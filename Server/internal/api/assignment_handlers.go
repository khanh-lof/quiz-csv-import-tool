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
	StageLock   string         `json:"stageLock"`
	StageCounts map[string]int `json:"stageCounts"`
	// PassPercents is the share of right answers that passes each stage, for exactly the stages in
	// StageCounts, defaults filled in.
	PassPercents map[string]int `json:"passPercents"`
	// MaxAttempts is the cap on finished runs per stage, null when unlimited.
	MaxAttempts *int `json:"maxAttempts"`
	// ShowBoard is false when the teacher hid the leaderboard from the students.
	ShowBoard   bool       `json:"showBoard"`
	CreatedAt   time.Time  `json:"createdAt"`
	ClosesAt    *time.Time `json:"closesAt"`
	ClosedAt    *time.Time `json:"closedAt"`
	Open        bool       `json:"open"`
	PlayerCount int        `json:"playerCount"`
}

func newAssignmentView(a *store.Assignment, now time.Time, playerCount int) assignmentView {
	counts := a.StageCounts
	if counts == nil {
		counts = map[string]int{}
	}
	return assignmentView{
		ID: a.ID, Code: a.Code, JobID: a.JobID, Title: a.Title, Label: a.Label, TimeMode: a.TimeMode,
		StageLock:    stageLockOf(a),
		PassPercents: passPercentsOf(a),
		MaxAttempts:  a.MaxAttempts,
		ShowBoard:    !a.HideBoard,
		StageCounts:  counts, CreatedAt: a.CreatedAt.UTC(), ClosesAt: utcPtr(a.ClosesAt), ClosedAt: utcPtr(a.ClosedAt),
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

// assignmentDetailView is the leaderboard page's answer: the assignment, the quiz it snapshotted and the
// players in leaderboard order.
type assignmentDetailView struct {
	assignmentView
	CSV     string             `json:"csv"`
	Players []leaderboardEntry `json:"players"`
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
		StageLock   string         `json:"stageLock"`
		StageCounts map[string]int `json:"stageCounts"`
		// PassPercents is read raw so that a value that is not an integer is told apart from bad JSON.
		PassPercents json.RawMessage `json:"passPercents"`
		// MaxAttempts is read raw for the same reason.
		MaxAttempts json.RawMessage `json:"maxAttempts"`
		// ShowBoard is read raw for the same reason.
		ShowBoard json.RawMessage `json:"showBoard"`
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
	if req.StageLock == "" {
		req.StageLock = stageLockSequential
	}
	if !validStageLock(req.StageLock) {
		writeText(w, http.StatusBadRequest, "Invalid stage lock.")
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
	passPercents, ok := parsePassPercents(req.PassPercents, req.StageCounts)
	if !ok {
		writeText(w, http.StatusBadRequest, "Invalid pass percents.")
		return
	}
	maxAttempts, ok := parseMaxAttempts(req.MaxAttempts, req.StageLock)
	if !ok {
		writeText(w, http.StatusBadRequest, "Invalid replay limit.")
		return
	}
	showBoard, ok := parseShowBoard(req.ShowBoard)
	if !ok {
		writeText(w, http.StatusBadRequest, "Invalid board setting.")
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
		Username:     username,
		JobID:        job.ID,
		Title:        job.Title,
		Label:        label,
		CSV:          job.CSV,
		TimeMode:     req.TimeMode,
		StageLock:    req.StageLock,
		StageCounts:  req.StageCounts,
		PassPercents: passPercents,
		MaxAttempts:  maxAttempts,
		HideBoard:    !showBoard,
		CreatedAt:    now.UTC().Truncate(time.Millisecond),
		ClosesAt:     closesAt,
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

// getAssignment handles GET /api/assignments/{id}: the leaderboard page's data, which the page polls.
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
		Players:        buildLeaderboard(players, a.StageCounts),
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

const (
	stageLockSequential = "sequential"
	stageLockOpen       = "open"
)

func validStageLock(lock string) bool {
	return lock == stageLockSequential || lock == stageLockOpen
}

// stageLockOf is the assignment's stage lock, with the empty value of an assignment made before the
// setting existed read as the rule that applied then.
func stageLockOf(a *store.Assignment) string {
	if a.StageLock == stageLockOpen {
		return stageLockOpen
	}
	return stageLockSequential
}

const (
	defaultPassPercent = 70
	minPassPercent     = 10
	maxPassPercent     = 100
)

// passPercentOf is the percentage of right answers that passes the stage: what the teacher set, or
// the default for a stage without a setting (all of them on an assignment made before the setting).
func passPercentOf(a *store.Assignment, stage string) int {
	if p, ok := a.PassPercents[stage]; ok {
		return p
	}
	return defaultPassPercent
}

// passPercentsOf is the complete map for the assignment's stages, defaults filled in, never nil.
func passPercentsOf(a *store.Assignment) map[string]int {
	out := make(map[string]int, len(a.StageCounts))
	for stage := range a.StageCounts {
		out[stage] = passPercentOf(a, stage)
	}
	return out
}

const (
	minMaxAttempts = 1
	maxMaxAttempts = 10
)

// parseMaxAttempts reads the optional maxAttempts of a create request: absent or null is unlimited
// (nil); otherwise a plain JSON integer from minMaxAttempts to maxMaxAttempts, and only on an "open"
// stage lock, since a sequential assignment's replays are always unlimited.
func parseMaxAttempts(raw json.RawMessage, stageLock string) (*int, bool) {
	if len(raw) == 0 || string(raw) == "null" {
		return nil, true
	}
	n, err := strconv.Atoi(string(raw))
	if err != nil || n < minMaxAttempts || n > maxMaxAttempts || stageLock != stageLockOpen {
		return nil, false
	}
	return &n, true
}

// parseShowBoard reads the optional showBoard of a create request: absent or null shows the leaderboard
// to the students (true); otherwise it must be a JSON boolean. A string such as "false" is refused rather
// than guessed at, so a client that sends the wrong type never hides or shows the board by accident. Null
// is handled before unmarshalling, because decoding null into a bool succeeds and leaves false.
func parseShowBoard(raw json.RawMessage) (bool, bool) {
	if len(raw) == 0 || string(raw) == "null" {
		return true, true
	}
	var show bool
	if err := json.Unmarshal(raw, &show); err != nil {
		return false, false
	}
	return show, true
}

// parsePassPercents reads the optional passPercents of a create request. Absent or null is "all
// default" (nil); otherwise it must be an object whose keys are stages of the quiz and whose values are
// integers from minPassPercent to maxPassPercent, written as plain JSON integers. Only what was sent
// is kept.
func parsePassPercents(raw json.RawMessage, stageCounts map[string]int) (map[string]int, bool) {
	if len(raw) == 0 || string(raw) == "null" {
		return nil, true
	}
	var values map[string]json.RawMessage
	if err := json.Unmarshal(raw, &values); err != nil {
		return nil, false
	}
	out := make(map[string]int, len(values))
	for stage, v := range values {
		if _, ok := stageCounts[stage]; !ok {
			return nil, false
		}
		p, err := strconv.Atoi(string(v))
		if err != nil || p < minPassPercent || p > maxPassPercent {
			return nil, false
		}
		out[stage] = p
	}
	return out, true
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
