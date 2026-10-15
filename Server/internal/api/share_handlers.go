package api

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"net/http"
	"strings"
	"unicode"
	"unicode/utf8"

	"quiz-csv-import-tool/server/internal/store"
)

const (
	// maxPlayersPerAssignment bounds one class's leaderboard (and the work of every poll of it).
	maxPlayersPerAssignment = 300
	maxNameRunes            = 40
	// playerTokenHeader carries the token the server gave a student when they joined.
	playerTokenHeader = "X-Player-Token"
)

// getShared handles GET /api/share/{code}: what a student's page needs to play, while the assignment
// is open. It holds no question and no answer: the server deals those one at a time, see run_handlers.go.
// Every answer of it, errors included, is marked uncacheable, since closing it must show at once.
func (s *Server) getShared(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	a, ok := s.sharedAssignment(w, r)
	if !ok {
		return
	}
	if !a.OpenAt(s.now()) {
		writeText(w, http.StatusGone, "Assignment closed")
		return
	}
	// The player's own runs count, for a student's page to show the replays left and the stages passed.
	// The token is optional here and a bad one is not an error: this route never answers 401 or 403.
	attempts := map[string]int{}
	results := map[string]sharedStageResult{}
	if token := r.Header.Get(playerTokenHeader); token != "" {
		player, err := s.Assignments.PlayerByToken(r.Context(), a.ID, hashPlayerToken(token))
		switch {
		case err == nil:
			// A run counts the moment it starts, finished or not, so the attempts are what was started,
			// or what the results say for a player from before runs were dealt by the server.
			for stage, res := range player.Stages {
				if n := max(res.Attempts, player.Started[stage]); n > 0 {
					attempts[stage] = n
				}
				if _, has := a.StageCounts[stage]; has {
					results[stage] = sharedStageResult{Correct: res.Correct, Total: res.Total, Passed: res.Passed}
				}
			}
			for stage, started := range player.Started {
				if started > attempts[stage] {
					attempts[stage] = started
				}
			}
		case !errors.Is(err, store.ErrNotFound):
			s.internalError(w, r, "looking up player failed", err)
			return
		}
	}
	counts := a.StageCounts
	if counts == nil {
		counts = map[string]int{}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"title":        a.Title,
		"label":        a.Label,
		"timeMode":     a.TimeMode,
		"stageLock":    stageLockOf(a),
		"stageCounts":  counts,
		"timeLimits":   s.timeLimits(a),
		"passPercents": passPercentsOf(a),
		"maxAttempts":  a.MaxAttempts,
		"showBoard":    !a.HideBoard,
		"attempts":     attempts,
		"results":      results,
		"closesAt":     utcPtr(a.ClosesAt),
	})
}

// sharedStageResult is a student's best finished run of one stage, as getShared tells them.
type sharedStageResult struct {
	Correct int  `json:"correct"`
	Total   int  `json:"total"`
	Passed  bool `json:"passed"`
}

// joinShared handles POST /api/share/{code}/players: a student picks a name, and may pick an avatar, and
// gets a token that proves, on every later request, that it is the same student. The token is the only
// credential the student has, so only its hash is kept.
func (s *Server) joinShared(w http.ResponseWriter, r *http.Request) {
	a, ok := s.sharedAssignment(w, r)
	if !ok {
		return
	}
	now := s.now()
	if !a.OpenAt(now) {
		writeText(w, http.StatusGone, "Assignment closed")
		return
	}

	var req struct {
		Name string `json:"name"`
		// Avatar is optional: a page from before avatars, or a student who picked none, sends nothing.
		Avatar string `json:"avatar"`
	}
	if !s.readJSON(w, r, &req) {
		return
	}
	name, ok := cleanPlayerName(req.Name)
	if !ok {
		writeText(w, http.StatusBadRequest, "Invalid name.")
		return
	}
	if req.Avatar != "" && !validAvatar(req.Avatar) {
		writeText(w, http.StatusBadRequest, "Invalid avatar.")
		return
	}

	counts, err := s.Assignments.CountPlayers(r.Context(), []string{a.ID})
	if err != nil {
		s.internalError(w, r, "counting players failed", err)
		return
	}
	if counts[a.ID] >= maxPlayersPerAssignment {
		writeText(w, http.StatusConflict, "Assignment is full")
		return
	}

	raw := make([]byte, 32)
	_, _ = rand.Read(raw)
	token := base64.RawURLEncoding.EncodeToString(raw)
	player := &store.Player{
		ID:           newJobID(),
		AssignmentID: a.ID,
		Name:         name,
		Avatar:       req.Avatar,
		NameKey:      strings.ToLower(name),
		TokenHash:    hashPlayerToken(token),
		JoinedAt:     now.UTC(),
	}
	err = s.Assignments.CreatePlayer(r.Context(), player)
	if errors.Is(err, store.ErrDuplicate) {
		writeText(w, http.StatusConflict, "Name taken")
		return
	}
	if err != nil {
		s.internalError(w, r, "creating player failed", err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]string{
		"playerId": player.ID, "token": token, "name": player.Name, "avatar": player.Avatar,
	})
}

// updateSharedPlayer handles PATCH /api/share/{code}/player: a student changes their own avatar. The
// player is the one whose token the X-Player-Token header carries, never one named in the body, so a
// student can only ever change themselves. Like joining, it needs the assignment to be open, and like
// every student route it never answers 401.
func (s *Server) updateSharedPlayer(w http.ResponseWriter, r *http.Request) {
	a, ok := s.sharedAssignment(w, r)
	if !ok {
		return
	}
	if !a.OpenAt(s.now()) {
		writeText(w, http.StatusGone, "Assignment closed")
		return
	}

	token := r.Header.Get(playerTokenHeader)
	if token == "" {
		writeText(w, http.StatusForbidden, "Unknown player")
		return
	}
	player, err := s.Assignments.PlayerByToken(r.Context(), a.ID, hashPlayerToken(token))
	if errors.Is(err, store.ErrNotFound) {
		writeText(w, http.StatusForbidden, "Unknown player")
		return
	}
	if err != nil {
		s.internalError(w, r, "looking up player failed", err)
		return
	}

	var req struct {
		Avatar string `json:"avatar"`
	}
	if !s.readJSON(w, r, &req) {
		return
	}
	// Unlike joining, a change has to name an avatar: there is no way back to none.
	if !validAvatar(req.Avatar) {
		writeText(w, http.StatusBadRequest, "Invalid avatar.")
		return
	}

	err = s.Assignments.SetPlayerAvatar(r.Context(), a.ID, player.ID, req.Avatar)
	if errors.Is(err, store.ErrNotFound) {
		// The teacher removed the student between the token check and now.
		writeText(w, http.StatusForbidden, "Unknown player")
		return
	}
	if err != nil {
		s.internalError(w, r, "setting avatar failed", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"playerId": player.ID, "name": player.Name, "avatar": req.Avatar})
}

// sharedLeaderboard handles GET /api/share/{code}/leaderboard: the top of the class and the caller's own
// place, for a student's page. It answers while the assignment is closed too, unlike getShared, so the
// closed card can show the final board. The X-Player-Token header is optional and a missing or unknown
// token only means no "you": this route never answers 401 or 403. Every answer is uncacheable, since the
// board changes with every result.
//
// When the teacher hid the board it answers 404 "Board hidden", closed or not. An empty board would look
// like a class where nobody has played yet, and a page that showed it anyway would say nobody has a
// result, which is untrue; a 404 says there is no board for students. It is never a 401 or 403, because
// the student routes never answer those (AuthInterceptor would try a refresh on a 401, and the client
// forgets the student's identity on a 403). The client mounts no board when it knows showBoard is false,
// and takes this 404 as "draw nothing, stop polling" for the one case it cannot know: a link that was
// already closed when opened, where getShared answers 410.
func (s *Server) sharedLeaderboard(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	a, ok := s.sharedAssignment(w, r)
	if !ok {
		return
	}
	if a.HideBoard {
		writeText(w, http.StatusNotFound, "Board hidden")
		return
	}

	youID := ""
	if token := r.Header.Get(playerTokenHeader); token != "" {
		player, err := s.Assignments.PlayerByToken(r.Context(), a.ID, hashPlayerToken(token))
		switch {
		case err == nil:
			youID = player.ID
		case !errors.Is(err, store.ErrNotFound):
			s.internalError(w, r, "looking up player failed", err)
			return
		}
	}

	players, err := s.Assignments.ListPlayers(r.Context(), a.ID)
	if err != nil {
		s.internalError(w, r, "listing players failed", err)
		return
	}
	writeJSON(w, http.StatusOK, newStudentBoard(buildLeaderboard(players, a.StageCounts), youID, a.StageCounts))
}

// sharedAssignment finds the assignment a student's link points at, or answers 404. The code is
// stored upper-case and a student may have typed it any way, so it is normalized here; what the
// store gets is matched exactly.
func (s *Server) sharedAssignment(w http.ResponseWriter, r *http.Request) (*store.Assignment, bool) {
	code := strings.ToUpper(strings.TrimSpace(r.PathValue("code")))
	a, err := s.Assignments.GetByCode(r.Context(), code)
	if errors.Is(err, store.ErrNotFound) {
		writeText(w, http.StatusNotFound, "Assignment not found")
		return nil, false
	}
	if err != nil {
		s.internalError(w, r, "loading assignment failed", err)
		return nil, false
	}
	return a, true
}

// passMark is how many of n questions must be right to pass a stage that needs percent: percent of n,
// rounded up, in integers. With 70 it is the same number as the client's Math.ceil(0.7 * n).
func passMark(n, percent int) int {
	return (percent*n + 99) / 100
}

// cleanPlayerName trims a student's name and folds every run of whitespace into one space, then
// reports whether what is left is 1 to maxNameRunes characters without control characters.
func cleanPlayerName(raw string) (string, bool) {
	name := strings.Join(strings.Fields(raw), " ")
	if n := utf8.RuneCountInString(name); n < 1 || n > maxNameRunes {
		return "", false
	}
	if strings.ContainsFunc(name, unicode.IsControl) {
		return "", false
	}
	return name, true
}

// hashPlayerToken is what the store keeps instead of a player's token: the same SHA-256 in base64url
// as the refresh tokens use (auth keeps its own helper unexported). The token is 256 random bits, so
// a plain fast hash suffices.
func hashPlayerToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}
