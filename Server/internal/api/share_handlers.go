package api

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	"quiz-csv-import-tool/server/internal/store"
)

const (
	// maxPlayersPerAssignment bounds one class's ranking (and the work of every poll of it).
	maxPlayersPerAssignment = 300
	maxNameRunes            = 40
	// playerTokenHeader carries the token the server gave a student when they joined.
	playerTokenHeader = "X-Player-Token"
)

// runIDPattern is what a browser's crypto.randomUUID() looks like, with some room.
var runIDPattern = regexp.MustCompile(`^[A-Za-z0-9-]{8,64}$`)

// getShared handles GET /api/share/{code}: what a student's page needs to play, while the assignment
// is open. Every answer of it, errors included, is marked uncacheable, since closing it must show at once.
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
	writeJSON(w, http.StatusOK, map[string]any{
		"title":    a.Title,
		"label":    a.Label,
		"csv":      a.CSV,
		"timeMode": a.TimeMode,
		"closesAt": utcPtr(a.ClosesAt),
	})
}

// joinShared handles POST /api/share/{code}/players: a student picks a name and gets a token that
// proves, on every later result, that it is the same student. The token is the only credential the
// student has, so only its hash is kept.
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
	}
	if !s.readJSON(w, r, &req) {
		return
	}
	name, ok := cleanPlayerName(req.Name)
	if !ok {
		writeText(w, http.StatusBadRequest, "Invalid name.")
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
	writeJSON(w, http.StatusCreated, map[string]string{"playerId": player.ID, "token": token, "name": player.Name})
}

// reportResult handles POST /api/share/{code}/results: the browser reports one finished stage run.
// The server cannot prove it was played honestly, but it rejects what could not have happened in the
// quiz (a stage it does not have, a different number of questions, more right answers than questions).
// Results are taken for a grace period after the assignment closes, see store.ResultGrace.
func (s *Server) reportResult(w http.ResponseWriter, r *http.Request) {
	a, ok := s.sharedAssignment(w, r)
	if !ok {
		return
	}
	now := s.now()
	if !a.AcceptsResultsAt(now) {
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
		RunID   string `json:"runId"`
		Stage   int    `json:"stage"`
		Correct int    `json:"correct"`
		Total   int    `json:"total"`
	}
	if !s.readJSON(w, r, &req) {
		return
	}
	stage := strconv.Itoa(req.Stage)
	questions, hasStage := a.StageCounts[stage]
	if !runIDPattern.MatchString(req.RunID) || !hasStage || req.Total != questions ||
		req.Correct < 0 || req.Correct > req.Total {
		writeText(w, http.StatusBadRequest, "Invalid result.")
		return
	}

	passed := req.Correct >= passMark(req.Total)
	err = s.Assignments.RecordResult(r.Context(), a.ID, player.ID, req.RunID, stage, req.Correct, req.Total, passed, now)
	if errors.Is(err, store.ErrNotFound) {
		// The teacher removed the student between the token check and now.
		writeText(w, http.StatusForbidden, "Unknown player")
		return
	}
	if err != nil {
		s.internalError(w, r, "recording result failed", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
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

// passMark is how many of n questions must be right to pass a stage: 70%, rounded up. It is
// ceil(0.7n) in integers, the same number as the client's Math.ceil(0.7 * n).
func passMark(n int) int {
	return (7*n + 9) / 10
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
