package api

import (
	"crypto/rand"
	"encoding/base64"
	"errors"
	"maps"
	"net/http"
	"slices"
	"strings"
	"time"
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
	noStore(w)
	a, _, ok := s.sharedAssignmentWhile(w, r, (*store.Assignment).OpenAt)
	if !ok {
		return
	}
	// The player's own runs count, for a student's page to show the replays left and the stages passed.
	// The token is optional here and a bad one is not an error: this route never answers 401 or 403.
	attempts := map[string]int{}
	results := map[string]stageResult{}
	player, ok := s.optionalPlayer(w, r, a)
	if !ok {
		return
	}
	if player != nil {
		for stage, res := range player.Stages {
			if _, has := a.StageCounts[stage]; has {
				results[stage] = stageResult{Correct: res.Correct, Total: res.Total, Passed: res.Passed}
			}
		}
		for _, stage := range playedStages(player) {
			if n := player.RunsStarted(stage); n > 0 {
				attempts[stage] = n
			}
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
		"showPinyin":   a.ShowPinyin,
		"attempts":     attempts,
		"results":      results,
		"closesAt":     utcPtr(a.ClosesAt),
	})
}

// stageResult is a score of one stage and whether it passes: a finished run's, or a student's best, as
// getShared tells them.
type stageResult struct {
	Correct int  `json:"correct"`
	Total   int  `json:"total"`
	Passed  bool `json:"passed"`
}

// playedStages is every stage the player has started or finished a run of.
func playedStages(p *store.Player) []string {
	stages := slices.Collect(maps.Keys(p.Stages))
	for stage := range p.Started {
		if _, has := p.Stages[stage]; !has {
			stages = append(stages, stage)
		}
	}
	return stages
}

// joinShared handles POST /api/share/{code}/players: a student picks a name, and may pick an avatar, and
// gets a token that proves, on every later request, that it is the same student. The token is the only
// credential the student has, so only its hash is kept.
func (s *Server) joinShared(w http.ResponseWriter, r *http.Request) {
	a, now, ok := s.sharedAssignmentWhile(w, r, (*store.Assignment).OpenAt)
	if !ok {
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
		ID:           newID(),
		AssignmentID: a.ID,
		Name:         name,
		Avatar:       req.Avatar,
		NameKey:      strings.ToLower(name),
		TokenHash:    hashKey(token),
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
	a, _, ok := s.sharedAssignmentWhile(w, r, (*store.Assignment).OpenAt)
	if !ok {
		return
	}
	player, ok := s.requestPlayer(w, r, a)
	if !ok {
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

	err := s.Assignments.SetPlayerAvatar(r.Context(), a.ID, player.ID, req.Avatar)
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
	noStore(w)
	a, ok := s.sharedAssignment(w, r)
	if !ok {
		return
	}
	if a.HideBoard {
		writeText(w, http.StatusNotFound, "Board hidden")
		return
	}

	you, ok := s.optionalPlayer(w, r, a)
	if !ok {
		return
	}
	youID := ""
	if you != nil {
		youID = you.ID
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

// sharedAssignmentWhile is sharedAssignment for a route that needs the assignment in a state at now, such as
// (*store.Assignment).OpenAt or AcceptsResultsAt, and answers 410 "Assignment closed" when it is not.
func (s *Server) sharedAssignmentWhile(w http.ResponseWriter, r *http.Request, state func(*store.Assignment, time.Time) bool) (*store.Assignment, time.Time, bool) {
	a, ok := s.sharedAssignment(w, r)
	if !ok {
		return nil, time.Time{}, false
	}
	now := s.now()
	if !state(a, now) {
		writeText(w, http.StatusGone, "Assignment closed")
		return nil, time.Time{}, false
	}
	return a, now, true
}

// requestPlayer is the student behind the X-Player-Token header, or a 403 "Unknown player" for a missing
// token or one that no player of this assignment holds.
func (s *Server) requestPlayer(w http.ResponseWriter, r *http.Request, a *store.Assignment) (*store.Player, bool) {
	player, ok := s.optionalPlayer(w, r, a)
	if ok && player == nil {
		writeText(w, http.StatusForbidden, "Unknown player")
		return nil, false
	}
	return player, ok
}

// optionalPlayer is the student behind the X-Player-Token header, or nil for a missing token or one that no
// player of this assignment holds. It reports false only after answering 500 for a store that failed.
func (s *Server) optionalPlayer(w http.ResponseWriter, r *http.Request, a *store.Assignment) (*store.Player, bool) {
	token := r.Header.Get(playerTokenHeader)
	if token == "" {
		return nil, true
	}
	player, err := s.Assignments.PlayerByToken(r.Context(), a.ID, hashKey(token))
	if errors.Is(err, store.ErrNotFound) {
		return nil, true
	}
	if err != nil {
		s.internalError(w, r, "looking up player failed", err)
		return nil, false
	}
	return player, true
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
