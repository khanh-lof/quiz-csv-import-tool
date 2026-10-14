package api

import (
	"crypto/rand"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"quiz-csv-import-tool/server/internal/auth"
	"quiz-csv-import-tool/server/internal/csvgen"
	"quiz-csv-import-tool/server/internal/store"
)

const (
	// maxAssignmentsPerUser keeps one account from filling the database with links.
	maxAssignmentsPerUser = 100
	maxLabelRunes         = 60
	// maxClosesAhead is how far in the future a closing time may be set.
	maxClosesAhead = 180 * 24 * time.Hour
	// stageNumbers is how many stages the game has; stageCounts keys run from "1" to this.
	stageNumbers = 6
	// maxStageQuestions is the most questions one stage may hold; the model writes 4 or 5.
	maxStageQuestions = 50
	// createAttempts is how often creating an assignment is tried when a freshly drawn id or code
	// turns out to be taken (which practically never happens with 50 random bits in a code).
	createAttempts = 3

	// shareCodeAlphabet is Crockford's base32: digits and letters without I, L, O and U, so a code
	// read aloud or typed from a projector cannot be mistaken. 32 characters, so one random byte maps
	// onto it with `% 32` without bias.
	shareCodeAlphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
	shareCodeLength   = 10
)

// assignmentView is an assignment as the client sees it (the shared `Assignment` type of the
// contract): without the CSV, with the open flag worked out at response time.
type assignmentView struct {
	ID          string         `json:"id"`
	Code        string         `json:"code"`
	JobID       string         `json:"jobId"`
	Title       string         `json:"title"`
	Label       string         `json:"label"`
	TimeMode    string         `json:"timeMode"`
	StageCounts map[string]int `json:"stageCounts"`
	CreatedAt   time.Time      `json:"createdAt"`
	ClosesAt    *time.Time     `json:"closesAt"`
	ClosedAt    *time.Time     `json:"closedAt"`
	Open        bool           `json:"open"`
	PlayerCount int            `json:"playerCount"`
}

func newAssignmentView(a *store.Assignment, now time.Time, playerCount int) assignmentView {
	counts := a.StageCounts
	if counts == nil {
		counts = map[string]int{}
	}
	return assignmentView{
		ID: a.ID, Code: a.Code, JobID: a.JobID, Title: a.Title, Label: a.Label, TimeMode: a.TimeMode,
		StageCounts: counts, CreatedAt: a.CreatedAt.UTC(), ClosesAt: utcPtr(a.ClosesAt), ClosedAt: utcPtr(a.ClosedAt),
		Open: a.OpenAt(now), PlayerCount: playerCount,
	}
}

func utcPtr(t *time.Time) *time.Time {
	if t == nil {
		return nil
	}
	v := t.UTC()
	return &v
}

// assignmentDetailView is the ranking page's answer: the assignment, the quiz it snapshotted and the
// ranked players.
type assignmentDetailView struct {
	assignmentView
	CSV     string         `json:"csv"`
	Players []rankedPlayer `json:"players"`
}

// createAssignment handles POST /api/assignments: it snapshots one of the caller's finished Quiz cử
// chỉ jobs under a new public code. The checks run in the order the contract lists their messages,
// the cheap ones on the payload before anything is read from the database.
func (s *Server) createAssignment(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.FromContext(r.Context())
	username := claims.Username()

	var req struct {
		JobID       string         `json:"jobId"`
		Label       string         `json:"label"`
		ClosesAt    *string        `json:"closesAt"`
		TimeMode    string         `json:"timeMode"`
		StageCounts map[string]int `json:"stageCounts"`
	}
	if !s.readJSON(w, r, &req) {
		return
	}
	now := s.now()

	label, ok := cleanLabel(req.Label)
	if !ok {
		writeText(w, http.StatusBadRequest, "Label is too long.")
		return
	}
	if !validTimeMode(req.TimeMode) {
		writeText(w, http.StatusBadRequest, "Invalid time mode.")
		return
	}
	var closesAt *time.Time
	if req.ClosesAt != nil {
		t, ok := parseClosesAt(*req.ClosesAt, now)
		if !ok {
			writeText(w, http.StatusBadRequest, "Invalid closing time.")
			return
		}
		closesAt = &t
	}
	if !validStageCounts(req.StageCounts) {
		writeText(w, http.StatusBadRequest, "Invalid stage counts.")
		return
	}

	count, err := s.Assignments.Count(r.Context(), username)
	if err != nil {
		s.internalError(w, r, "counting assignments failed", err)
		return
	}
	if count >= maxAssignmentsPerUser {
		writeText(w, http.StatusConflict, "Too many assignments.")
		return
	}

	job, err := s.Jobs.Get(r.Context(), username, req.JobID)
	if errors.Is(err, store.ErrNotFound) {
		writeText(w, http.StatusNotFound, "Job not found")
		return
	}
	if err != nil {
		s.internalError(w, r, "loading job failed", err)
		return
	}
	if job.Status != store.JobDone || !job.Creative || job.ExportType == nil || *job.ExportType != int(csvgen.GestureQuiz) {
		writeText(w, http.StatusConflict, "Job is not a finished gesture quiz.")
		return
	}

	a := &store.Assignment{
		Username:    username,
		JobID:       job.ID,
		Title:       job.Title,
		Label:       label,
		CSV:         job.CSV,
		TimeMode:    req.TimeMode,
		StageCounts: req.StageCounts,
		CreatedAt:   now.UTC().Truncate(time.Millisecond),
		ClosesAt:    closesAt,
	}
	for attempt := 1; ; attempt++ {
		a.ID, a.Code = newJobID(), newShareCode()
		err = s.Assignments.Create(r.Context(), a)
		if !errors.Is(err, store.ErrDuplicate) || attempt == createAttempts {
			break
		}
	}
	if err != nil {
		s.internalError(w, r, "creating assignment failed", err)
		return
	}
	writeJSON(w, http.StatusCreated, newAssignmentView(a, now, 0))
}

// listAssignments handles GET /api/assignments: the caller's assignments, newest first.
func (s *Server) listAssignments(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.FromContext(r.Context())
	assignments, err := s.Assignments.List(r.Context(), claims.Username(), maxAssignmentsPerUser)
	if err != nil {
		s.internalError(w, r, "listing assignments failed", err)
		return
	}
	ids := make([]string, len(assignments))
	for i, a := range assignments {
		ids[i] = a.ID
	}
	counts, err := s.Assignments.CountPlayers(r.Context(), ids)
	if err != nil {
		s.internalError(w, r, "counting players failed", err)
		return
	}

	now := s.now()
	views := make([]assignmentView, len(assignments))
	for i := range assignments {
		views[i] = newAssignmentView(&assignments[i], now, counts[assignments[i].ID])
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]any{"assignments": views})
}

// getAssignment handles GET /api/assignments/{id}: the ranking page's data, which the page polls.
func (s *Server) getAssignment(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.FromContext(r.Context())
	a, err := s.Assignments.Get(r.Context(), claims.Username(), r.PathValue("id"))
	if errors.Is(err, store.ErrNotFound) {
		writeText(w, http.StatusNotFound, "Assignment not found")
		return
	}
	if err != nil {
		s.internalError(w, r, "loading assignment failed", err)
		return
	}
	players, err := s.Assignments.ListPlayers(r.Context(), a.ID)
	if err != nil {
		s.internalError(w, r, "listing players failed", err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, assignmentDetailView{
		assignmentView: newAssignmentView(a, s.now(), len(players)),
		CSV:            a.CSV,
		Players:        rankPlayers(players, a.StageCounts),
	})
}

// patchAssignment handles PATCH /api/assignments/{id}. The body is read as a map of raw values so a
// key that is absent (leave it) differs from one that is null (clear the closing time).
func (s *Server) patchAssignment(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.FromContext(r.Context())
	username := claims.Username()

	var body map[string]json.RawMessage
	if !s.readJSON(w, r, &body) {
		return
	}
	a, err := s.Assignments.Get(r.Context(), username, r.PathValue("id"))
	if errors.Is(err, store.ErrNotFound) {
		writeText(w, http.StatusNotFound, "Assignment not found")
		return
	}
	if err != nil {
		s.internalError(w, r, "loading assignment failed", err)
		return
	}
	now := s.now()

	var update store.AssignmentUpdate
	if raw, ok := body["label"]; ok {
		var text string
		// A null would decode into the empty string without complaint, so it is refused by hand.
		if string(raw) == "null" || json.Unmarshal(raw, &text) != nil {
			writeText(w, http.StatusBadRequest, "Invalid payload")
			return
		}
		label, ok := cleanLabel(text)
		if !ok {
			writeText(w, http.StatusBadRequest, "Label is too long.")
			return
		}
		update.Label = &label
	}

	closesAt := a.ClosesAt // the closing time that will apply once the update is done
	if raw, ok := body["closesAt"]; ok {
		update.ClosesAt.Set = true
		if string(raw) == "null" {
			closesAt = nil
		} else {
			var text string
			if json.Unmarshal(raw, &text) != nil {
				writeText(w, http.StatusBadRequest, "Invalid payload")
				return
			}
			t, ok := parseClosesAt(text, now)
			if !ok {
				writeText(w, http.StatusBadRequest, "Invalid closing time.")
				return
			}
			update.ClosesAt.Value, closesAt = &t, &t
		}
	}

	if raw, ok := body["closed"]; ok {
		var closed bool
		if string(raw) == "null" || json.Unmarshal(raw, &closed) != nil {
			writeText(w, http.StatusBadRequest, "Invalid payload")
			return
		}
		if closed {
			// Closing an assignment that was already closed by hand keeps the first moment, so the
			// grace period for late results does not move every time the teacher presses the button.
			if a.ClosedAt == nil {
				closedAt := now.UTC().Truncate(time.Millisecond)
				update.ClosedAt = store.TimeChange{Set: true, Value: &closedAt}
			}
		} else {
			// Reopening must leave the assignment open: a closing time that has passed would close it
			// again at once, so the teacher has to move or remove it in the same request.
			if closesAt != nil && !closesAt.After(now) {
				writeText(w, http.StatusBadRequest, "Invalid closing time.")
				return
			}
			update.ClosedAt = store.TimeChange{Set: true}
		}
	}

	updated, err := s.Assignments.Update(r.Context(), username, a.ID, update)
	if errors.Is(err, store.ErrNotFound) {
		writeText(w, http.StatusNotFound, "Assignment not found")
		return
	}
	if err != nil {
		s.internalError(w, r, "updating assignment failed", err)
		return
	}
	counts, err := s.Assignments.CountPlayers(r.Context(), []string{updated.ID})
	if err != nil {
		s.internalError(w, r, "counting players failed", err)
		return
	}
	writeJSON(w, http.StatusOK, newAssignmentView(updated, now, counts[updated.ID]))
}

// deleteAssignment handles DELETE /api/assignments/{id}; the store removes its players too.
func (s *Server) deleteAssignment(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.FromContext(r.Context())
	err := s.Assignments.Delete(r.Context(), claims.Username(), r.PathValue("id"))
	if errors.Is(err, store.ErrNotFound) {
		writeText(w, http.StatusNotFound, "Assignment not found")
		return
	}
	if err != nil {
		s.internalError(w, r, "deleting assignment failed", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// deleteAssignmentPlayer handles DELETE /api/assignments/{id}/players/{playerId}, for removing a
// student with a joke name. The assignment is loaded first only to check that it is the caller's:
// the player methods of the store do not know about owners.
func (s *Server) deleteAssignmentPlayer(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.FromContext(r.Context())
	a, err := s.Assignments.Get(r.Context(), claims.Username(), r.PathValue("id"))
	if errors.Is(err, store.ErrNotFound) {
		writeText(w, http.StatusNotFound, "Assignment not found")
		return
	}
	if err != nil {
		s.internalError(w, r, "loading assignment failed", err)
		return
	}
	err = s.Assignments.DeletePlayer(r.Context(), a.ID, r.PathValue("playerId"))
	if errors.Is(err, store.ErrNotFound) {
		writeText(w, http.StatusNotFound, "Player not found")
		return
	}
	if err != nil {
		s.internalError(w, r, "deleting player failed", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// cleanLabel trims a label and reports whether it fits.
func cleanLabel(raw string) (string, bool) {
	label := strings.TrimSpace(raw)
	return label, utf8.RuneCountInString(label) <= maxLabelRunes
}

func validTimeMode(mode string) bool {
	switch mode {
	case "standard", "extra", "unlimited":
		return true
	}
	return false
}

// parseClosesAt reads a closing time, which must be an RFC 3339 instant after now and no further
// than maxClosesAhead away. The result is in the millisecond UTC form the stores keep.
func parseClosesAt(raw string, now time.Time) (time.Time, bool) {
	t, err := time.Parse(time.RFC3339, raw)
	if err != nil || !t.After(now) || t.After(now.Add(maxClosesAhead)) {
		return time.Time{}, false
	}
	return t.UTC().Truncate(time.Millisecond), true
}

// validStageCounts checks the question counts the client reads off the quiz: stages "1" to "6" by
// their canonical spelling, 1 to maxStageQuestions questions each, at least one stage.
func validStageCounts(counts map[string]int) bool {
	if len(counts) == 0 {
		return false
	}
	for key, n := range counts {
		stage, err := strconv.Atoi(key)
		if err != nil || strconv.Itoa(stage) != key || stage < 1 || stage > stageNumbers {
			return false
		}
		if n < 1 || n > maxStageQuestions {
			return false
		}
	}
	return true
}

// newShareCode draws the code of a link from crypto/rand.
func newShareCode() string {
	b := make([]byte, shareCodeLength)
	_, _ = rand.Read(b)
	for i, v := range b {
		b[i] = shareCodeAlphabet[v%byte(len(shareCodeAlphabet))]
	}
	return string(b)
}
