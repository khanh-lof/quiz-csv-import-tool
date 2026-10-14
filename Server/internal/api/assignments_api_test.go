package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"maps"
	"math"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
	"time"

	"quiz-csv-import-tool/server/internal/csvgen"
	"quiz-csv-import-tool/server/internal/store"
)

// gestureCSV is what the seeded job holds; the assignment must copy it as it is.
const gestureCSV = "1,Đúng hay sai?,Đúng,,,,Giải thích\n2,A hay B?,A,B,,,Giải thích\n"

// ---- helpers ----

type reqOpt func(*http.Request)

func bearer(token string) reqOpt {
	return func(r *http.Request) { r.Header.Set("Authorization", "Bearer "+token) }
}

func header(key, value string) reqOpt { return func(r *http.Request) { r.Header.Set(key, value) } }

// send runs one request against the handler; an empty body sends none.
func (e *testEnv) send(method, path, body string, opts ...reqOpt) *httptest.ResponseRecorder {
	var reader io.Reader
	if body != "" {
		reader = strings.NewReader(body)
	}
	req := httptest.NewRequest(method, path, reader)
	for _, opt := range opts {
		opt(req)
	}
	return e.do(req)
}

func decode[T any](t *testing.T, rec *httptest.ResponseRecorder) T {
	t.Helper()
	var v T
	if err := json.Unmarshal(rec.Body.Bytes(), &v); err != nil {
		t.Fatalf("decoding %q: %v", rec.Body, err)
	}
	return v
}

func wantStatus(t *testing.T, rec *httptest.ResponseRecorder, status int) {
	t.Helper()
	if rec.Code != status {
		t.Fatalf("status %d %q, want %d", rec.Code, rec.Body, status)
	}
}

// wantError checks a plain-text error answer, which is part of the contract with the client.
func wantError(t *testing.T, rec *httptest.ResponseRecorder, status int, msg string) {
	t.Helper()
	if rec.Code != status || rec.Body.String() != msg {
		t.Fatalf("got %d %q, want %d %q", rec.Code, rec.Body, status, msg)
	}
}

func jsonOf(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return string(b)
}

// omit, as an override of createBody, removes the key from the request.
type omit struct{}

// createBody is a valid POST /api/assignments body for the seeded job, with some keys replaced.
func createBody(overrides map[string]any) string {
	body := map[string]any{
		"jobId":       "job1",
		"label":       "",
		"closesAt":    nil,
		"timeMode":    "standard",
		"stageCounts": map[string]int{"1": 5, "2": 10},
	}
	for k, v := range overrides {
		if _, drop := v.(omit); drop {
			delete(body, k)
		} else {
			body[k] = v
		}
	}
	return jsonOf(body)
}

func resultBody(runID string, stage, correct, total int) string {
	return jsonOf(map[string]any{"runId": runID, "stage": stage, "correct": correct, "total": total})
}

func rankOf(p rankedPlayer) int {
	if p.Rank == nil {
		return -1
	}
	return *p.Rank
}

func inTime(t time.Time) string { return t.UTC().Format(time.RFC3339) }

// seedJob stores a finished Game job; edit may turn it into something else.
func (e *testEnv) seedJob(t *testing.T, username, id string, edit func(*store.Job)) {
	t.Helper()
	job := &store.Job{
		ID: id, Username: username, Status: store.JobDone, Title: "HSK3-Bai5", Creative: true,
		ExportType: ptr(int(csvgen.GestureQuiz)), CSV: gestureCSV, CreatedAt: e.clock.Now(),
	}
	if edit != nil {
		edit(job)
	}
	if err := e.jobs.Create(context.Background(), job); err != nil {
		t.Fatal(err)
	}
}

// classroom is alice with one assignment (job "job1", stage 1 of 5 questions and stage 2 of 10).
type classroom struct {
	*testEnv
	token string
	a     assignmentView
}

func newClassroom(t *testing.T, createOverrides map[string]any) *classroom {
	t.Helper()
	env := newEnv(t)
	env.seedJob(t, "alice", "job1", nil)
	token, _ := env.login(t, "alice", "pw")
	c := &classroom{testEnv: env, token: token}
	rec := c.teacher(http.MethodPost, "/api/assignments", createBody(createOverrides))
	wantStatus(t, rec, http.StatusCreated)
	c.a = decode[assignmentView](t, rec)
	return c
}

func (c *classroom) teacher(method, path, body string) *httptest.ResponseRecorder {
	return c.send(method, path, body, bearer(c.token))
}

func (c *classroom) patch(body string) *httptest.ResponseRecorder {
	return c.teacher(http.MethodPatch, "/api/assignments/"+c.a.ID, body)
}

func (c *classroom) detail(t *testing.T) assignmentDetailView {
	t.Helper()
	rec := c.teacher(http.MethodGet, "/api/assignments/"+c.a.ID, "")
	wantStatus(t, rec, http.StatusOK)
	return decode[assignmentDetailView](t, rec)
}

func (c *classroom) shareGet() *httptest.ResponseRecorder {
	return c.send(http.MethodGet, "/api/share/"+c.a.Code, "")
}

func (c *classroom) tryJoin(name string) *httptest.ResponseRecorder {
	return c.send(http.MethodPost, "/api/share/"+c.a.Code+"/players", jsonOf(map[string]any{"name": name}))
}

// join adds a student and returns the player's id and token.
func (c *classroom) join(t *testing.T, name string) (id, token string) {
	t.Helper()
	rec := c.tryJoin(name)
	wantStatus(t, rec, http.StatusCreated)
	body := decode[struct{ PlayerID, Token, Name string }](t, rec)
	return body.PlayerID, body.Token
}

func (c *classroom) report(token, body string) *httptest.ResponseRecorder {
	return c.send(http.MethodPost, "/api/share/"+c.a.Code+"/results", body, header("X-Player-Token", token))
}

// finish reports a run that must be accepted.
func (c *classroom) finish(t *testing.T, token, runID string, stage, correct, total int) {
	t.Helper()
	rec := c.report(token, resultBody(runID, stage, correct, total))
	wantStatus(t, rec, http.StatusNoContent)
	if rec.Body.Len() != 0 {
		t.Fatalf("a 204 carries a body: %q", rec.Body)
	}
}

func keysOf(m map[string]any) []string {
	return slices.Sorted(maps.Keys(m))
}

// ---- the whole flow ----

func TestAssignmentFlow(t *testing.T) {
	env := newEnv(t)
	env.seedJob(t, "alice", "job1", nil)
	token, _ := env.login(t, "alice", "pw")
	c := &classroom{testEnv: env, token: token}
	start := env.clock.Now()

	// Create: the assignment snapshots the job under a fresh code.
	closes := start.Add(time.Hour)
	rec := c.teacher(http.MethodPost, "/api/assignments", createBody(map[string]any{
		"label": "  Lớp 6A ", "closesAt": inTime(closes), "timeMode": "extra",
	}))
	wantStatus(t, rec, http.StatusCreated)
	if got := rec.Header().Get("Content-Type"); got != "application/json" {
		t.Errorf("content type %q", got)
	}
	created := decode[map[string]any](t, rec)
	wantKeys := []string{"closedAt", "closesAt", "code", "createdAt", "id", "jobId", "label", "open", "playerCount",
		"stageCounts", "timeMode", "title"}
	if got := keysOf(created); !slices.Equal(got, wantKeys) {
		t.Fatalf("keys %v, want %v", got, wantKeys)
	}
	counts, _ := created["stageCounts"].(map[string]any)
	if created["jobId"] != "job1" || created["title"] != "HSK3-Bai5" || created["label"] != "Lớp 6A" ||
		created["timeMode"] != "extra" || created["createdAt"] != inTime(start) || created["closesAt"] != inTime(closes) ||
		created["closedAt"] != nil || created["open"] != true || created["playerCount"] != float64(0) ||
		len(counts) != 2 || counts["1"] != float64(5) || counts["2"] != float64(10) {
		t.Fatalf("created %v", created)
	}
	code, _ := created["code"].(string)
	if len(code) != 10 || strings.Trim(code, shareCodeAlphabet) != "" {
		t.Fatalf("code %q is not 10 characters of the Crockford alphabet", code)
	}
	if id, _ := created["id"].(string); len(id) != 32 {
		t.Fatalf("id %q", id)
	}
	c.a = decode[assignmentView](t, rec)
	stored, err := env.assignments.Get(context.Background(), "alice", c.a.ID)
	if err != nil || stored.CSV != gestureCSV || stored.Username != "alice" || stored.Code != code {
		t.Fatalf("stored %+v, %v", stored, err)
	}

	// The list has it, newest first, without a CSV.
	rec = c.teacher(http.MethodGet, "/api/assignments", "")
	wantStatus(t, rec, http.StatusOK)
	if rec.Header().Get("Cache-Control") != "no-store" {
		t.Errorf("list is cacheable: %v", rec.Header())
	}
	list := decode[struct{ Assignments []map[string]any }](t, rec)
	if len(list.Assignments) != 1 || list.Assignments[0]["id"] != c.a.ID || list.Assignments[0]["playerCount"] != float64(0) {
		t.Fatalf("list %v", list)
	}

	// A student opens the link, typed in lower case.
	rec = env.send(http.MethodGet, "/api/share/"+strings.ToLower(code), "")
	wantStatus(t, rec, http.StatusOK)
	if rec.Header().Get("Cache-Control") != "no-store" {
		t.Errorf("share is cacheable: %v", rec.Header())
	}
	shared := decode[map[string]any](t, rec)
	if got, want := keysOf(shared), []string{"closesAt", "csv", "label", "timeMode", "title"}; !slices.Equal(got, want) {
		t.Fatalf("share keys %v, want %v", got, want)
	}
	if shared["title"] != "HSK3-Bai5" || shared["label"] != "Lớp 6A" || shared["csv"] != gestureCSV ||
		shared["timeMode"] != "extra" || shared["closesAt"] != inTime(closes) {
		t.Fatalf("share %v", shared)
	}

	// Joining hands out a token; the same name, however it is typed, is taken.
	rec = c.tryJoin("Lan")
	wantStatus(t, rec, http.StatusCreated)
	joined := decode[map[string]any](t, rec)
	if got, want := keysOf(joined), []string{"name", "playerId", "token"}; !slices.Equal(got, want) {
		t.Fatalf("join keys %v, want %v", got, want)
	}
	lanToken, _ := joined["token"].(string)
	if joined["name"] != "Lan" || len(lanToken) != 43 || joined["playerId"] == "" {
		t.Fatalf("joined %v", joined)
	}
	wantError(t, c.tryJoin(" lan "), http.StatusConflict, "Name taken")
	_, maiToken := c.join(t, "Mai")
	c.join(t, "Nam")

	// The server keeps only a hash of the token.
	players, _ := env.assignments.ListPlayers(context.Background(), c.a.ID)
	for _, p := range players {
		if p.TokenHash == lanToken || p.TokenHash == "" {
			t.Fatalf("token stored as %q", p.TokenHash)
		}
	}

	// Lan passes stage 1 (4 of 5), plays it again worse, resends the first run, then fails stage 2.
	c.finish(t, lanToken, "run-lan-0001", 1, 4, 5)
	env.clock.Advance(time.Minute)
	c.finish(t, lanToken, "run-lan-0002", 1, 2, 5)
	c.finish(t, lanToken, "run-lan-0001", 1, 4, 5)
	c.finish(t, lanToken, "run-lan-0003", 2, 6, 10)
	// Mai, a minute later, passes both stages.
	env.clock.Advance(time.Minute)
	c.finish(t, maiToken, "run-mai-0001", 1, 5, 5)
	c.finish(t, maiToken, "run-mai-0002", 2, 7, 10)

	rec = c.teacher(http.MethodGet, "/api/assignments/"+c.a.ID, "")
	wantStatus(t, rec, http.StatusOK)
	if rec.Header().Get("Cache-Control") != "no-store" {
		t.Errorf("detail is cacheable: %v", rec.Header())
	}
	detailKeys := slices.Sorted(slices.Values(append(slices.Clone(wantKeys), "csv", "players")))
	if got := keysOf(decode[map[string]any](t, rec)); !slices.Equal(got, detailKeys) {
		t.Fatalf("detail keys %v, want %v", got, detailKeys)
	}
	detail := decode[assignmentDetailView](t, rec)
	if detail.CSV != gestureCSV || detail.PlayerCount != 3 || !detail.Open || detail.ID != c.a.ID {
		t.Fatalf("detail %+v", detail.assignmentView)
	}
	var order []string
	var gotRanks []int
	for _, p := range detail.Players {
		order, gotRanks = append(order, p.Name), append(gotRanks, rankOf(p))
	}
	if !slices.Equal(order, []string{"Mai", "Lan", "Nam"}) || !slices.Equal(gotRanks, []int{1, 2, -1}) {
		t.Fatalf("order %v, ranks %v", order, gotRanks)
	}

	mai, lan, nam := detail.Players[0], detail.Players[1], detail.Players[2]
	if mai.StagesPassed != 2 || mai.Correct != 12 || mai.Possible != 15 || mai.Attempts != 2 ||
		mai.ReachedAt == nil || !mai.ReachedAt.Equal(start.Add(2*time.Minute)) {
		t.Errorf("mai %+v", mai)
	}
	// The worse second run did not lower the best, and the resent run counted once.
	if lan.StagesPassed != 1 || lan.Correct != 10 || lan.Possible != 15 || lan.Attempts != 3 ||
		lan.ReachedAt == nil || !lan.ReachedAt.Equal(start.Add(time.Minute)) {
		t.Errorf("lan %+v", lan)
	}
	if got, want := lan.Stages["1"], (stageScore{Correct: 4, Total: 5, Passed: true, Attempts: 2}); got != want {
		t.Errorf("lan stage 1: %+v, want %+v", got, want)
	}
	if got, want := lan.Stages["2"], (stageScore{Correct: 6, Total: 10, Passed: false, Attempts: 1}); got != want {
		t.Errorf("lan stage 2: %+v, want %+v", got, want)
	}
	if lan.LastPlayedAt == nil || !lan.LastPlayedAt.Equal(start.Add(time.Minute)) {
		t.Errorf("lan lastPlayedAt %v", lan.LastPlayedAt)
	}
	if nam.Stages == nil || len(nam.Stages) != 0 || nam.Attempts != 0 || nam.LastPlayedAt != nil || nam.ReachedAt != nil || nam.Possible != 15 {
		t.Errorf("nam %+v", nam)
	}

	// The list now counts the students.
	rec = c.teacher(http.MethodGet, "/api/assignments", "")
	if got := decode[struct{ Assignments []assignmentView }](t, rec).Assignments; len(got) != 1 || got[0].PlayerCount != 3 {
		t.Fatalf("list %+v", got)
	}
}

func TestAssignmentsAreListedNewestFirst(t *testing.T) {
	c := newClassroom(t, map[string]any{"label": "first"})
	c.clock.Advance(time.Minute)
	rec := c.teacher(http.MethodPost, "/api/assignments", createBody(map[string]any{"label": "second"}))
	wantStatus(t, rec, http.StatusCreated)

	rec = c.teacher(http.MethodGet, "/api/assignments", "")
	list := decode[struct{ Assignments []assignmentView }](t, rec).Assignments
	if len(list) != 2 || list[0].Label != "second" || list[1].Label != "first" {
		t.Fatalf("list %+v", list)
	}
	if list[0].Code == list[1].Code || list[0].ID == list[1].ID {
		t.Fatalf("two assignments share an id or a code: %+v", list)
	}
}

func TestEmptyAssignmentListIsAnArray(t *testing.T) {
	env := newEnv(t)
	token, _ := env.login(t, "alice", "pw")
	rec := env.send(http.MethodGet, "/api/assignments", "", bearer(token))
	if rec.Code != http.StatusOK || strings.TrimSpace(rec.Body.String()) != `{"assignments":[]}` {
		t.Fatalf("got %d %q", rec.Code, rec.Body)
	}
}

// ---- closing and reopening ----

func TestClosingStopsOpeningAndJoiningButResultsGetAGrace(t *testing.T) {
	c := newClassroom(t, nil)
	_, lanToken := c.join(t, "Lan")

	closedAt := c.clock.Now()
	rec := c.patch(`{"closed":true}`)
	wantStatus(t, rec, http.StatusOK)
	closed := decode[assignmentView](t, rec)
	if closed.Open || closed.ClosedAt == nil || !closed.ClosedAt.Equal(closedAt) || closed.PlayerCount != 1 {
		t.Fatalf("closed %+v", closed)
	}

	wantError(t, c.shareGet(), http.StatusGone, "Assignment closed")
	wantError(t, c.tryJoin("Mai"), http.StatusGone, "Assignment closed")

	// A student in the middle of a stage at the deadline still gets the result in, for 5 minutes.
	c.clock.Advance(4 * time.Minute)
	c.finish(t, lanToken, "run-lan-0001", 1, 5, 5)
	c.clock.Advance(time.Minute) // exactly 5 minutes after: still inside the grace
	c.finish(t, lanToken, "run-lan-0002", 2, 7, 10)
	c.clock.Advance(time.Second)
	wantError(t, c.report(lanToken, resultBody("run-lan-0003", 2, 10, 10)), http.StatusGone, "Assignment closed")
	c.clock.Advance(time.Minute) // 6 minutes: long past it
	wantError(t, c.report(lanToken, resultBody("run-lan-0004", 2, 10, 10)), http.StatusGone, "Assignment closed")

	// The teacher still sees everything, and what arrived in time counted.
	detail := c.detail(t)
	if detail.Open || len(detail.Players) != 1 || detail.Players[0].StagesPassed != 2 || detail.Players[0].Attempts != 2 {
		t.Fatalf("detail %+v %+v", detail.assignmentView, detail.Players)
	}
}

func TestClosingTimePasses(t *testing.T) {
	c := newClassroom(t, map[string]any{"closesAt": inTime(testClockStart.Add(30 * time.Minute))})
	_, lanToken := c.join(t, "Lan")
	wantStatus(t, c.shareGet(), http.StatusOK)

	c.clock.Advance(29*time.Minute + 59*time.Second)
	wantStatus(t, c.shareGet(), http.StatusOK)
	c.clock.Advance(time.Second) // the closing time itself is already closed
	wantError(t, c.shareGet(), http.StatusGone, "Assignment closed")
	wantError(t, c.tryJoin("Mai"), http.StatusGone, "Assignment closed")

	rec := c.teacher(http.MethodGet, "/api/assignments", "")
	if list := decode[struct{ Assignments []assignmentView }](t, rec).Assignments; len(list) != 1 || list[0].Open {
		t.Fatalf("a passed closing time still shows open: %+v", list)
	}

	c.clock.Advance(5 * time.Minute)
	c.finish(t, lanToken, "run-lan-0001", 1, 5, 5)
	c.clock.Advance(time.Second)
	wantError(t, c.report(lanToken, resultBody("run-lan-0002", 1, 5, 5)), http.StatusGone, "Assignment closed")
}

func TestClosingAgainKeepsTheFirstMoment(t *testing.T) {
	c := newClassroom(t, nil)
	first := decode[assignmentView](t, c.patch(`{"closed":true}`))
	c.clock.Advance(2 * time.Minute)
	again := decode[assignmentView](t, c.patch(`{"closed":true}`))
	if first.ClosedAt == nil || again.ClosedAt == nil || !again.ClosedAt.Equal(*first.ClosedAt) {
		t.Fatalf("closed at %v, then %v", first.ClosedAt, again.ClosedAt)
	}
}

func TestReopening(t *testing.T) {
	c := newClassroom(t, map[string]any{"closesAt": inTime(testClockStart.Add(time.Hour))})
	_, lanToken := c.join(t, "Lan")
	wantStatus(t, c.patch(`{"closed":true}`), http.StatusOK)
	wantError(t, c.shareGet(), http.StatusGone, "Assignment closed")

	// An hour later the old closing time has passed, so reopening needs a new one or none.
	c.clock.Advance(2 * time.Hour)
	wantError(t, c.patch(`{"closed":false}`), http.StatusBadRequest, "Invalid closing time.")
	wantError(t, c.patch(`{"closed":false,"closesAt":"`+inTime(c.clock.Now().Add(-time.Minute))+`"}`),
		http.StatusBadRequest, "Invalid closing time.")
	wantError(t, c.shareGet(), http.StatusGone, "Assignment closed") // the refusals changed nothing

	rec := c.patch(`{"closed":false,"closesAt":null}`)
	wantStatus(t, rec, http.StatusOK)
	reopened := decode[assignmentView](t, rec)
	if !reopened.Open || reopened.ClosedAt != nil || reopened.ClosesAt != nil || reopened.PlayerCount != 1 {
		t.Fatalf("reopened %+v", reopened)
	}
	wantStatus(t, c.shareGet(), http.StatusOK)
	c.finish(t, lanToken, "run-lan-0001", 1, 5, 5)

	// Reopening with a new closing time works too, and keeps that time.
	wantStatus(t, c.patch(`{"closed":true}`), http.StatusOK)
	later := c.clock.Now().Add(time.Hour)
	reopened = decode[assignmentView](t, c.patch(`{"closed":false,"closesAt":"`+inTime(later)+`"}`))
	if !reopened.Open || reopened.ClosesAt == nil || !reopened.ClosesAt.Equal(later) {
		t.Fatalf("reopened %+v", reopened)
	}

	// Reopening an assignment that was never closed by hand changes nothing about it being open.
	if got := decode[assignmentView](t, c.patch(`{"closed":false}`)); !got.Open || got.ClosesAt == nil {
		t.Fatalf("got %+v", got)
	}
}

func TestPatchLabelAndClosingTime(t *testing.T) {
	c := newClassroom(t, map[string]any{"label": "Lớp 6A", "closesAt": inTime(testClockStart.Add(time.Hour))})
	_, _ = c.join(t, "Lan")

	// A key that is absent stays as it is.
	got := decode[assignmentView](t, c.patch(`{"label":"  Lớp 6B  "}`))
	if got.Label != "Lớp 6B" || got.ClosesAt == nil || got.PlayerCount != 1 {
		t.Fatalf("label only: %+v", got)
	}
	got = decode[assignmentView](t, c.patch(`{}`))
	if got.Label != "Lớp 6B" || got.ClosesAt == nil {
		t.Fatalf("empty patch: %+v", got)
	}

	// closesAt: null removes the closing time, and leaves the label.
	got = decode[assignmentView](t, c.patch(`{"closesAt":null}`))
	if got.Label != "Lớp 6B" || got.ClosesAt != nil || !got.Open {
		t.Fatalf("closesAt null: %+v", got)
	}

	// A new closing time replaces it, and an empty label clears the label.
	later := testClockStart.Add(2 * time.Hour)
	got = decode[assignmentView](t, c.patch(`{"label":"","closesAt":"`+inTime(later)+`"}`))
	if got.Label != "" || got.ClosesAt == nil || !got.ClosesAt.Equal(later) {
		t.Fatalf("label and time: %+v", got)
	}
	if detail := c.detail(t); detail.Label != "" || detail.ClosesAt == nil || !detail.ClosesAt.Equal(later) {
		t.Fatalf("not stored: %+v", detail.assignmentView)
	}

	// The closing time can be moved while the assignment is closed by hand, without reopening it.
	wantStatus(t, c.patch(`{"closed":true}`), http.StatusOK)
	got = decode[assignmentView](t, c.patch(`{"closesAt":"`+inTime(later.Add(time.Hour))+`"}`))
	if got.Open || got.ClosedAt == nil {
		t.Fatalf("moving the time reopened it: %+v", got)
	}
}

func TestPatchErrors(t *testing.T) {
	c := newClassroom(t, map[string]any{"label": "Lớp 6A"})
	now := c.clock.Now()
	tests := []struct {
		name string
		body string
		msg  string
	}{
		{"no body", "", "Missing body"},
		{"not json", "nope", "Invalid payload"},
		{"an array", "[]", "Invalid payload"},
		{"null label", `{"label":null}`, "Invalid payload"},
		{"number label", `{"label":5}`, "Invalid payload"},
		{"long label", `{"label":"` + strings.Repeat("ă", 61) + `"}`, "Label is too long."},
		{"number closesAt", `{"closesAt":5}`, "Invalid payload"},
		{"closesAt text", `{"closesAt":"tomorrow"}`, "Invalid closing time."},
		{"closesAt empty", `{"closesAt":""}`, "Invalid closing time."},
		{"closesAt past", `{"closesAt":"` + inTime(now.Add(-time.Hour)) + `"}`, "Invalid closing time."},
		{"closesAt now", `{"closesAt":"` + inTime(now) + `"}`, "Invalid closing time."},
		{"closesAt too far", `{"closesAt":"` + inTime(now.Add(180*24*time.Hour+time.Second)) + `"}`, "Invalid closing time."},
		{"string closed", `{"closed":"true"}`, "Invalid payload"},
		{"null closed", `{"closed":null}`, "Invalid payload"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			wantError(t, c.patch(tt.body), http.StatusBadRequest, tt.msg)
		})
	}
	// None of them changed anything; 60 runes is still fine.
	if detail := c.detail(t); detail.Label != "Lớp 6A" || !detail.Open || detail.ClosesAt != nil {
		t.Fatalf("detail %+v", detail.assignmentView)
	}
	wantStatus(t, c.patch(`{"label":"`+strings.Repeat("ă", 60)+`","closesAt":"`+inTime(now.Add(180*24*time.Hour))+`"}`), http.StatusOK)
}

// ---- validation ----

func TestCreateAssignmentErrors(t *testing.T) {
	env := newEnv(t)
	env.seedJob(t, "alice", "job1", nil)
	token, _ := env.login(t, "alice", "pw")
	now := env.clock.Now()

	tests := []struct {
		name   string
		body   string
		status int
		msg    string
	}{
		{"no body", "", 400, "Missing body"},
		{"not json", "nope", 400, "Invalid payload"},
		{"wrong type", `{"jobId":5}`, 400, "Invalid payload"},
		{"stage count not a number", `{"jobId":"job1","timeMode":"standard","stageCounts":{"1":"5"}}`, 400, "Invalid payload"},
		{"label too long", createBody(map[string]any{"label": strings.Repeat("ă", 61)}), 400, "Label is too long."},
		{"label too long with trailing spaces", createBody(map[string]any{"label": strings.Repeat("x", 61) + "   "}), 400, "Label is too long."},
		{"time mode other", createBody(map[string]any{"timeMode": "fast"}), 400, "Invalid time mode."},
		{"time mode empty", createBody(map[string]any{"timeMode": ""}), 400, "Invalid time mode."},
		{"time mode missing", createBody(map[string]any{"timeMode": omit{}}), 400, "Invalid time mode."},
		{"time mode case", createBody(map[string]any{"timeMode": "Standard"}), 400, "Invalid time mode."},
		{"closes in the past", createBody(map[string]any{"closesAt": inTime(now.Add(-time.Minute))}), 400, "Invalid closing time."},
		{"closes now", createBody(map[string]any{"closesAt": inTime(now)}), 400, "Invalid closing time."},
		{"closes too far ahead", createBody(map[string]any{"closesAt": inTime(now.Add(180*24*time.Hour + time.Second))}), 400, "Invalid closing time."},
		{"closes not a time", createBody(map[string]any{"closesAt": "next week"}), 400, "Invalid closing time."},
		{"closes without zone", createBody(map[string]any{"closesAt": "2026-10-15T09:00:00"}), 400, "Invalid closing time."},
		{"closes a number", createBody(map[string]any{"closesAt": 5}), 400, "Invalid payload"},
		{"no stage counts", createBody(map[string]any{"stageCounts": omit{}}), 400, "Invalid stage counts."},
		{"null stage counts", createBody(map[string]any{"stageCounts": nil}), 400, "Invalid stage counts."},
		{"empty stage counts", createBody(map[string]any{"stageCounts": map[string]int{}}), 400, "Invalid stage counts."},
		{"stage 0", createBody(map[string]any{"stageCounts": map[string]int{"0": 5}}), 400, "Invalid stage counts."},
		{"stage 7", createBody(map[string]any{"stageCounts": map[string]int{"7": 5}}), 400, "Invalid stage counts."},
		{"stage not a number", createBody(map[string]any{"stageCounts": map[string]int{"one": 5}}), 400, "Invalid stage counts."},
		{"stage spelled oddly", createBody(map[string]any{"stageCounts": map[string]int{"01": 5}}), 400, "Invalid stage counts."},
		{"one bad stage among good ones", createBody(map[string]any{"stageCounts": map[string]int{"1": 5, "9": 5}}), 400, "Invalid stage counts."},
		{"no questions", createBody(map[string]any{"stageCounts": map[string]int{"1": 0}}), 400, "Invalid stage counts."},
		{"negative questions", createBody(map[string]any{"stageCounts": map[string]int{"1": -1}}), 400, "Invalid stage counts."},
		{"too many questions", createBody(map[string]any{"stageCounts": map[string]int{"1": 51}}), 400, "Invalid stage counts."},
		{"job unknown", createBody(map[string]any{"jobId": "nope"}), 404, "Job not found"},
		{"job missing", createBody(map[string]any{"jobId": omit{}}), 404, "Job not found"},
		// The payload is judged before the database is asked about the job.
		{"payload before job", createBody(map[string]any{"jobId": "nope", "timeMode": "fast"}), 400, "Invalid time mode."},
		// Checks run in the order of the contract.
		{"label before time mode", createBody(map[string]any{"label": strings.Repeat("x", 61), "timeMode": "fast"}), 400, "Label is too long."},
		{"time mode before closing time", createBody(map[string]any{"timeMode": "fast", "closesAt": "x"}), 400, "Invalid time mode."},
		{"closing time before stage counts", createBody(map[string]any{"closesAt": "x", "stageCounts": omit{}}), 400, "Invalid closing time."},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			wantError(t, env.send(http.MethodPost, "/api/assignments", tt.body, bearer(token)), tt.status, tt.msg)
		})
	}

	// Nothing was created by any of them.
	if n, _ := env.assignments.Count(context.Background(), "alice"); n != 0 {
		t.Fatalf("%d assignments after only failures", n)
	}

	// The limits themselves are allowed: 60 runes, 180 days, 50 questions, all six stages.
	rec := env.send(http.MethodPost, "/api/assignments", createBody(map[string]any{
		"label":       strings.Repeat("ă", 60),
		"closesAt":    inTime(now.Add(180 * 24 * time.Hour)),
		"stageCounts": map[string]int{"1": 1, "2": 50, "3": 5, "4": 5, "5": 5, "6": 5},
	}), bearer(token))
	wantStatus(t, rec, http.StatusCreated)
}

func TestCreateAssignmentNeedsAFinishedGestureQuiz(t *testing.T) {
	env := newEnv(t)
	token, _ := env.login(t, "alice", "pw")
	jobs := map[string]func(*store.Job){
		"running":        func(j *store.Job) { j.Status = store.JobRunning },
		"failed":         func(j *store.Job) { j.Status = store.JobFailed },
		"formatted":      func(j *store.Job) { j.Creative, j.ExportType = false, nil },
		"no export type": func(j *store.Job) { j.ExportType = nil },
		"gimkit":         func(j *store.Job) { j.ExportType = ptr(int(csvgen.GimKit)) },
		"wayground":      func(j *store.Job) { j.ExportType = ptr(int(csvgen.Wayground)) },
		"not creative":   func(j *store.Job) { j.Creative = false },
	}
	for id, edit := range jobs {
		env.seedJob(t, "alice", id, edit)
		rec := env.send(http.MethodPost, "/api/assignments", createBody(map[string]any{"jobId": id}), bearer(token))
		if rec.Code != http.StatusConflict || rec.Body.String() != "Job is not a finished gesture quiz." {
			t.Errorf("%s job: got %d %q", id, rec.Code, rec.Body)
		}
	}

	env.seedJob(t, "alice", "good", nil)
	wantStatus(t, env.send(http.MethodPost, "/api/assignments", createBody(map[string]any{"jobId": "good"}), bearer(token)), http.StatusCreated)
}

func TestAssignmentSnapshotsTheJob(t *testing.T) {
	c := newClassroom(t, nil)
	// Deleting the job (or pruning it) must not touch a live link.
	if err := c.jobs.Delete(context.Background(), "alice", "job1"); err != nil {
		t.Fatal(err)
	}
	shared := decode[map[string]any](t, c.shareGet())
	if shared["csv"] != gestureCSV || shared["title"] != "HSK3-Bai5" {
		t.Fatalf("share after deleting the job: %v", shared)
	}
	if detail := c.detail(t); detail.CSV != gestureCSV || detail.JobID != "job1" {
		t.Fatalf("detail after deleting the job: %+v", detail.assignmentView)
	}
}

func TestJoinNameRules(t *testing.T) {
	c := newClassroom(t, nil)
	tests := []struct {
		name     string
		body     string
		status   int
		wantName string // the stored name, or the error message
	}{
		{"empty", `{"name":""}`, 400, "Invalid name."},
		{"missing", `{}`, 400, "Invalid name."},
		{"only spaces", `{"name":"   "}`, 400, "Invalid name."},
		{"only whitespace characters", `{"name":" \t\n "}`, 400, "Invalid name."},
		{"41 runes", `{"name":"` + strings.Repeat("Ă", 41) + `"}`, 400, "Invalid name."},
		{"bell", `{"name":"Lan\u0007"}`, 400, "Invalid name."},
		{"nul", `{"name":"\u0000"}`, 400, "Invalid name."},
		{"delete", `{"name":"La\u007fn"}`, 400, "Invalid name."},
		{"not a string", `{"name":5}`, 400, "Invalid payload"},
		{"no body", ``, 400, "Missing body"},
		{"40 runes", `{"name":"` + strings.Repeat("Ă", 40) + `"}`, 201, strings.Repeat("Ă", 40)},
		{"trimmed and collapsed", `{"name":"  Lan \t  Anh\n"}`, 201, "Lan Anh"},
		{"that name again, spelled differently", `{"name":"lan ANH"}`, 409, "Name taken"},
		{"accents are different names", `{"name":"Năm"}`, 201, "Năm"},
		{"accents are different names too", `{"name":"Nam"}`, 201, "Nam"},
		{"case is kept as typed", `{"name":"McDonald"}`, 201, "McDonald"},
		{"emoji is fine", `{"name":"Mai 🐸"}`, 201, "Mai 🐸"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rec := c.send(http.MethodPost, "/api/share/"+c.a.Code+"/players", tt.body)
			if tt.status != http.StatusCreated {
				wantError(t, rec, tt.status, tt.wantName)
				return
			}
			wantStatus(t, rec, http.StatusCreated)
			if got := decode[struct{ Name string }](t, rec).Name; got != tt.wantName {
				t.Fatalf("name %q, want %q", got, tt.wantName)
			}
		})
	}
	// "Mai 🐸" is typed with a different case the next time, and that is the same name.
	wantError(t, c.tryJoin("MAI 🐸"), http.StatusConflict, "Name taken")
}

func TestReportResultValidation(t *testing.T) {
	c := newClassroom(t, nil) // stage 1 has 5 questions, stage 2 has 10
	_, token := c.join(t, "Lan")

	tests := []struct {
		name string
		body string
	}{
		{"run id missing", `{"stage":1,"correct":3,"total":5}`},
		{"run id too short", resultBody("abcdefg", 1, 3, 5)},
		{"run id too long", resultBody(strings.Repeat("a", 65), 1, 3, 5)},
		{"run id with a space", resultBody("run id 0001", 1, 3, 5)},
		{"run id with an underscore", resultBody("run_id_0001", 1, 3, 5)},
		{"run id with a slash", resultBody("run/id/0001", 1, 3, 5)},
		{"run id with a newline", resultBody("run-id-0001\n", 1, 3, 5)},
		{"stage missing", `{"runId":"run-0000001","correct":3,"total":5}`},
		{"stage 0", resultBody("run-0000001", 0, 3, 5)},
		{"stage negative", resultBody("run-0000001", -1, 3, 5)},
		{"stage 7", resultBody("run-0000001", 7, 3, 5)},
		{"stage the assignment lacks", resultBody("run-0000001", 3, 3, 5)},
		{"total smaller than the stage", resultBody("run-0000001", 1, 3, 4)},
		{"total larger than the stage", resultBody("run-0000001", 1, 3, 6)},
		{"total of another stage", resultBody("run-0000001", 1, 3, 10)},
		{"total missing", `{"runId":"run-0000001","stage":1,"correct":0}`},
		{"total zero", resultBody("run-0000001", 1, 0, 0)},
		{"correct negative", resultBody("run-0000001", 1, -1, 5)},
		{"correct above total", resultBody("run-0000001", 1, 6, 5)},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			wantError(t, c.report(token, tt.body), http.StatusBadRequest, "Invalid result.")
		})
	}

	// Wrong JSON types and a missing body are payload errors, not result errors.
	wantError(t, c.report(token, `{"runId":"run-0000001","stage":"1","correct":3,"total":5}`), http.StatusBadRequest, "Invalid payload")
	wantError(t, c.report(token, `{"runId":"run-0000001","stage":1.5,"correct":3,"total":5}`), http.StatusBadRequest, "Invalid payload")
	wantError(t, c.report(token, `nope`), http.StatusBadRequest, "Invalid payload")
	wantError(t, c.report(token, ``), http.StatusBadRequest, "Missing body")

	// None of the failures recorded anything.
	if p := c.detail(t).Players; len(p) != 1 || len(p[0].Stages) != 0 || p[0].Attempts != 0 {
		t.Fatalf("players %+v", p)
	}

	// The edges of a valid result: shortest and longest run id, nothing right, everything right.
	c.finish(t, token, "abcd-123", 1, 0, 5)
	c.finish(t, token, strings.Repeat("a", 64), 1, 5, 5)
	c.finish(t, token, "RUN-0000-UPPER", 2, 10, 10)
}

func TestReportResultNeedsAKnownPlayer(t *testing.T) {
	c := newClassroom(t, nil)
	_, lanToken := c.join(t, "Lan")
	body := resultBody("run-0000001", 1, 5, 5)

	wantError(t, c.send(http.MethodPost, "/api/share/"+c.a.Code+"/results", body), http.StatusForbidden, "Unknown player")
	wantError(t, c.report("", body), http.StatusForbidden, "Unknown player")
	wantError(t, c.report("not-a-token", body), http.StatusForbidden, "Unknown player")
	// The token is checked before the body is read.
	wantError(t, c.report("", "nope"), http.StatusForbidden, "Unknown player")
	// The hash is not the token.
	players, _ := c.assignments.ListPlayers(context.Background(), c.a.ID)
	wantError(t, c.report(players[0].TokenHash, body), http.StatusForbidden, "Unknown player")

	// A token is good for its own assignment only.
	other := decode[assignmentView](t, c.teacher(http.MethodPost, "/api/assignments", createBody(nil)))
	rec := c.send(http.MethodPost, "/api/share/"+other.Code+"/results", body, header("X-Player-Token", lanToken))
	wantError(t, rec, http.StatusForbidden, "Unknown player")

	c.finish(t, lanToken, "run-0000001", 1, 5, 5)
}

func TestShareRoutesAnswer404ForAnUnknownCode(t *testing.T) {
	c := newClassroom(t, nil)
	_, token := c.join(t, "Lan")
	// A code is matched whole: a longer or shorter one, or one made of spaces, is another code.
	for _, code := range []string{"ZZZZZZZZZZ", c.a.Code + "X", c.a.Code[:9], "%20", "0123456789"} {
		for _, rt := range []struct{ method, path, body string }{
			{http.MethodGet, "/api/share/" + code, ""},
			{http.MethodPost, "/api/share/" + code + "/players", `{"name":"Mai"}`},
			{http.MethodPost, "/api/share/" + code + "/results", resultBody("run-0000001", 1, 5, 5)},
		} {
			rec := c.send(rt.method, rt.path, rt.body, header("X-Player-Token", token))
			if rec.Code != http.StatusNotFound || rec.Body.String() != "Assignment not found" {
				t.Errorf("%s %s: %d %q", rt.method, rt.path, rec.Code, rec.Body)
			}
		}
	}
	// The code is trimmed and upper-cased, nothing else.
	wantStatus(t, c.send(http.MethodGet, "/api/share/%20"+strings.ToLower(c.a.Code)+"%20", ""), http.StatusOK)
}

func TestPassMark(t *testing.T) {
	for n, want := range map[int]int{1: 1, 2: 2, 3: 3, 4: 3, 5: 4, 6: 5, 10: 7, 20: 14, 25: 18, 50: 35} {
		if got := passMark(n); got != want {
			t.Errorf("passMark(%d) = %d, want %d", n, got, want)
		}
	}
	// The client computes Math.ceil(0.7 * n) with doubles; the server does it in integers.
	for n := 1; n <= 300; n++ {
		if got, want := passMark(n), int(math.Ceil(0.7*float64(n))); got != want {
			t.Errorf("passMark(%d) = %d, the client's Math.ceil(0.7*n) is %d", n, got, want)
		}
	}
}

func TestResultPassesAtTheMark(t *testing.T) {
	c := newClassroom(t, nil)
	_, token := c.join(t, "Lan")
	c.finish(t, token, "run-0000001", 1, 3, 5) // one short of 4
	c.finish(t, token, "run-0000002", 2, 7, 10)
	lan := c.detail(t).Players[0]
	if lan.Stages["1"].Passed || !lan.Stages["2"].Passed || lan.StagesPassed != 1 {
		t.Fatalf("lan %+v", lan)
	}
	c.finish(t, token, "run-0000003", 1, 4, 5)
	if lan = c.detail(t).Players[0]; !lan.Stages["1"].Passed || lan.StagesPassed != 2 || lan.Stages["1"].Attempts != 2 {
		t.Fatalf("lan %+v", lan)
	}
}

// ---- ownership, auth and limits ----

func TestAssignmentsBelongToTheirTeacher(t *testing.T) {
	c := newClassroom(t, nil)
	playerID, lanToken := c.join(t, "Lan")
	c.createUser(t, "bob", "pw", []string{"User"})
	bobToken, _ := c.login(t, "bob", "pw")
	bob := func(method, path, body string) *httptest.ResponseRecorder {
		return c.send(method, path, body, bearer(bobToken))
	}

	base := "/api/assignments/" + c.a.ID
	wantError(t, bob(http.MethodGet, base, ""), http.StatusNotFound, "Assignment not found")
	wantError(t, bob(http.MethodPatch, base, `{"closed":true}`), http.StatusNotFound, "Assignment not found")
	wantError(t, bob(http.MethodDelete, base, ""), http.StatusNotFound, "Assignment not found")
	wantError(t, bob(http.MethodDelete, base+"/players/"+playerID, ""), http.StatusNotFound, "Assignment not found")

	// His list holds none of hers.
	rec := bob(http.MethodGet, "/api/assignments", "")
	if rec.Code != http.StatusOK || strings.TrimSpace(rec.Body.String()) != `{"assignments":[]}` {
		t.Fatalf("bob's list: %d %q", rec.Code, rec.Body)
	}

	// None of it did anything.
	detail := c.detail(t)
	if !detail.Open || len(detail.Players) != 1 || detail.Players[0].ID != playerID {
		t.Fatalf("detail %+v", detail)
	}
	c.finish(t, lanToken, "run-0000001", 1, 5, 5)

	// A job of bob's cannot be assigned by alice, and his job is not found rather than refused.
	c.seedJob(t, "bob", "bobjob", nil)
	rec = c.teacher(http.MethodPost, "/api/assignments", createBody(map[string]any{"jobId": "bobjob"}))
	wantError(t, rec, http.StatusNotFound, "Job not found")
	// His own works for him.
	wantStatus(t, bob(http.MethodPost, "/api/assignments", createBody(map[string]any{"jobId": "bobjob"})), http.StatusCreated)
}

func TestTeacherRoutesNeedALogin(t *testing.T) {
	c := newClassroom(t, nil)
	c.createUser(t, "visitor", "pw", nil)
	visitorToken, _ := c.login(t, "visitor", "pw")

	routes := []struct{ method, path, body string }{
		{http.MethodPost, "/api/assignments", createBody(nil)},
		{http.MethodGet, "/api/assignments", ""},
		{http.MethodGet, "/api/assignments/" + c.a.ID, ""},
		{http.MethodPatch, "/api/assignments/" + c.a.ID, `{"closed":true}`},
		{http.MethodDelete, "/api/assignments/" + c.a.ID, ""},
		{http.MethodDelete, "/api/assignments/" + c.a.ID + "/players/x", ""},
	}
	for _, rt := range routes {
		rec := c.send(rt.method, rt.path, rt.body)
		if rec.Code != http.StatusUnauthorized || rec.Header().Get("WWW-Authenticate") == "" {
			t.Errorf("%s %s without a token: %d %v", rt.method, rt.path, rec.Code, rec.Header())
		}
		if rec := c.send(rt.method, rt.path, rt.body, bearer("garbage")); rec.Code != http.StatusUnauthorized {
			t.Errorf("%s %s with a garbage token: %d", rt.method, rt.path, rec.Code)
		}
		// A user without the User or Admin role is refused, like on the jobs routes.
		if rec := c.send(rt.method, rt.path, rt.body, bearer(visitorToken)); rec.Code != http.StatusForbidden {
			t.Errorf("%s %s without a role: %d", rt.method, rt.path, rec.Code)
		}
	}
	// Nothing happened to the assignment.
	if detail := c.detail(t); !detail.Open {
		t.Fatalf("detail %+v", detail.assignmentView)
	}
}

func TestStudentRoutesNeverAnswer401(t *testing.T) {
	c := newClassroom(t, nil)
	closedOne := decode[assignmentView](t, c.teacher(http.MethodPost, "/api/assignments", createBody(nil)))
	wantStatus(t, c.teacher(http.MethodPatch, "/api/assignments/"+closedOne.ID, `{"closed":true}`), http.StatusOK)

	authorizations := []string{"Bearer garbage", "Bearer", "Basic dXNlcjpwYXNz", "garbage", "Bearer " + c.token + "x"}
	for i, authorization := range authorizations {
		auth := header("Authorization", authorization)
		tests := []struct {
			name   string
			method string
			path   string
			body   string
			status int
		}{
			{"get", http.MethodGet, "/api/share/" + c.a.Code, "", 200},
			{"join", http.MethodPost, "/api/share/" + c.a.Code + "/players", fmt.Sprintf(`{"name":"Zed %d"}`, i), 201},
			{"result without a player", http.MethodPost, "/api/share/" + c.a.Code + "/results", resultBody("run-0000001", 1, 5, 5), 403},
			{"get unknown", http.MethodGet, "/api/share/ZZZZZZZZZZ", "", 404},
			{"join unknown", http.MethodPost, "/api/share/ZZZZZZZZZZ/players", `{"name":"Zed"}`, 404},
			{"result unknown", http.MethodPost, "/api/share/ZZZZZZZZZZ/results", resultBody("run-0000001", 1, 5, 5), 404},
			{"get closed", http.MethodGet, "/api/share/" + closedOne.Code, "", 410},
			{"join closed", http.MethodPost, "/api/share/" + closedOne.Code + "/players", `{"name":"Zed"}`, 410},
		}
		for _, tt := range tests {
			rec := c.send(tt.method, tt.path, tt.body, auth)
			if rec.Code != tt.status {
				t.Errorf("%q: %s: got %d %q, want %d", authorization, tt.name, rec.Code, rec.Body, tt.status)
			}
		}
	}
}

func TestAssignmentLimits(t *testing.T) {
	t.Run("assignments per user", func(t *testing.T) {
		env := newEnv(t)
		env.seedJob(t, "alice", "job1", nil)
		token, _ := env.login(t, "alice", "pw")
		for i := range maxAssignmentsPerUser - 1 {
			err := env.assignments.Create(context.Background(), &store.Assignment{
				ID: fmt.Sprintf("seed-%d", i), Code: fmt.Sprintf("SEED%06d", i), Username: "alice",
				Title: "seed", TimeMode: "standard", StageCounts: map[string]int{"1": 5}, CreatedAt: env.clock.Now(),
			})
			if err != nil {
				t.Fatal(err)
			}
		}
		// The 100th is the last one allowed, and the 101st is refused.
		wantStatus(t, env.send(http.MethodPost, "/api/assignments", createBody(nil), bearer(token)), http.StatusCreated)
		wantError(t, env.send(http.MethodPost, "/api/assignments", createBody(nil), bearer(token)), http.StatusConflict, "Too many assignments.")

		// The limit is per user.
		env.createUser(t, "bob", "pw", []string{"User"})
		env.seedJob(t, "bob", "bobjob", nil)
		bobToken, _ := env.login(t, "bob", "pw")
		wantStatus(t, env.send(http.MethodPost, "/api/assignments", createBody(map[string]any{"jobId": "bobjob"}), bearer(bobToken)), http.StatusCreated)

		// Deleting one makes room again.
		wantStatus(t, env.send(http.MethodDelete, "/api/assignments/seed-0", "", bearer(token)), http.StatusNoContent)
		wantStatus(t, env.send(http.MethodPost, "/api/assignments", createBody(nil), bearer(token)), http.StatusCreated)

		rec := env.send(http.MethodGet, "/api/assignments", "", bearer(token))
		if got := decode[struct{ Assignments []assignmentView }](t, rec).Assignments; len(got) != maxAssignmentsPerUser {
			t.Fatalf("list has %d", len(got))
		}
	})

	t.Run("players per assignment", func(t *testing.T) {
		c := newClassroom(t, nil)
		for i := range maxPlayersPerAssignment - 1 {
			err := c.assignments.CreatePlayer(context.Background(), &store.Player{
				ID: fmt.Sprintf("p%d", i), AssignmentID: c.a.ID, Name: fmt.Sprintf("Student %d", i),
				NameKey: fmt.Sprintf("student %d", i), TokenHash: fmt.Sprintf("hash%d", i), JoinedAt: c.clock.Now(),
			})
			if err != nil {
				t.Fatal(err)
			}
		}
		// The 300th student gets in, the 301st finds it full, with a different name or the same one.
		c.join(t, "Last")
		wantError(t, c.tryJoin("One too many"), http.StatusConflict, "Assignment is full")
		wantError(t, c.tryJoin("Last"), http.StatusConflict, "Assignment is full")
		wantError(t, c.tryJoin(""), http.StatusBadRequest, "Invalid name.") // the name is judged first

		// The limit is per assignment, and a removed student makes room.
		other := decode[assignmentView](t, c.teacher(http.MethodPost, "/api/assignments", createBody(nil)))
		wantStatus(t, c.send(http.MethodPost, "/api/share/"+other.Code+"/players", `{"name":"Lan"}`), http.StatusCreated)
		wantStatus(t, c.teacher(http.MethodDelete, "/api/assignments/"+c.a.ID+"/players/p0", ""), http.StatusNoContent)
		c.join(t, "Fits now")

		if detail := c.detail(t); detail.PlayerCount != maxPlayersPerAssignment || len(detail.Players) != maxPlayersPerAssignment {
			t.Fatalf("detail has %d players, count %d", len(detail.Players), detail.PlayerCount)
		}
	})
}

// ---- removing ----

func TestDeletePlayer(t *testing.T) {
	c := newClassroom(t, nil)
	lanID, lanToken := c.join(t, "Lan")
	maiID, maiToken := c.join(t, "Mai")
	c.finish(t, lanToken, "run-0000001", 1, 5, 5)
	c.finish(t, maiToken, "run-0000002", 1, 4, 5)

	base := "/api/assignments/" + c.a.ID + "/players/"
	wantStatus(t, c.teacher(http.MethodDelete, base+lanID, ""), http.StatusNoContent)
	wantError(t, c.teacher(http.MethodDelete, base+lanID, ""), http.StatusNotFound, "Player not found")
	wantError(t, c.teacher(http.MethodDelete, base+"nobody", ""), http.StatusNotFound, "Player not found")
	wantError(t, c.teacher(http.MethodDelete, "/api/assignments/nope/players/"+maiID, ""), http.StatusNotFound, "Assignment not found")

	// Lan's token is worth nothing now, and the ranking has only Mai.
	wantError(t, c.report(lanToken, resultBody("run-0000003", 1, 5, 5)), http.StatusForbidden, "Unknown player")
	detail := c.detail(t)
	if detail.PlayerCount != 1 || len(detail.Players) != 1 || detail.Players[0].Name != "Mai" || rankOf(detail.Players[0]) != 1 {
		t.Fatalf("detail %+v %+v", detail.assignmentView, detail.Players)
	}
	// The name is free again.
	c.join(t, "Lan")

	// A student cannot be removed through another teacher's assignment id.
	c.createUser(t, "bob", "pw", []string{"User"})
	bobToken, _ := c.login(t, "bob", "pw")
	rec := c.send(http.MethodDelete, base+maiID, "", bearer(bobToken))
	wantError(t, rec, http.StatusNotFound, "Assignment not found")
	c.finish(t, maiToken, "run-0000004", 2, 7, 10)
}

func TestDeleteAssignment(t *testing.T) {
	c := newClassroom(t, nil)
	_, lanToken := c.join(t, "Lan")
	c.finish(t, lanToken, "run-0000001", 1, 5, 5)
	other := decode[assignmentView](t, c.teacher(http.MethodPost, "/api/assignments", createBody(nil)))
	wantStatus(t, c.send(http.MethodPost, "/api/share/"+other.Code+"/players", `{"name":"Lan"}`), http.StatusCreated)

	rec := c.teacher(http.MethodDelete, "/api/assignments/"+c.a.ID, "")
	wantStatus(t, rec, http.StatusNoContent)
	if rec.Body.Len() != 0 {
		t.Fatalf("a 204 carries a body: %q", rec.Body)
	}

	wantError(t, c.shareGet(), http.StatusNotFound, "Assignment not found")
	wantError(t, c.tryJoin("Mai"), http.StatusNotFound, "Assignment not found")
	wantError(t, c.report(lanToken, resultBody("run-0000002", 1, 5, 5)), http.StatusNotFound, "Assignment not found")
	wantError(t, c.teacher(http.MethodGet, "/api/assignments/"+c.a.ID, ""), http.StatusNotFound, "Assignment not found")
	wantError(t, c.teacher(http.MethodDelete, "/api/assignments/"+c.a.ID, ""), http.StatusNotFound, "Assignment not found")
	wantError(t, c.patch(`{"closed":true}`), http.StatusNotFound, "Assignment not found")

	// Its players went with it, and the other assignment is as it was.
	if players, _ := c.assignments.ListPlayers(context.Background(), c.a.ID); len(players) != 0 {
		t.Fatalf("players left behind: %+v", players)
	}
	rec = c.teacher(http.MethodGet, "/api/assignments", "")
	list := decode[struct{ Assignments []assignmentView }](t, rec).Assignments
	if len(list) != 1 || list[0].ID != other.ID || list[0].PlayerCount != 1 {
		t.Fatalf("list %+v", list)
	}
}

// ---- creating under contention ----

// duplicatingAssignments refuses the first creates as if their code were taken.
type duplicatingAssignments struct {
	store.Assignments
	duplicates int
	tried      []store.Assignment
}

func (d *duplicatingAssignments) Create(ctx context.Context, a *store.Assignment) error {
	d.tried = append(d.tried, *a)
	if len(d.tried) <= d.duplicates {
		return store.ErrDuplicate
	}
	return d.Assignments.Create(ctx, a)
}

func TestCreateAssignmentRetriesAClashingCode(t *testing.T) {
	env := newEnv(t)
	env.seedJob(t, "alice", "job1", nil)
	token, _ := env.login(t, "alice", "pw")
	flaky := &duplicatingAssignments{Assignments: env.assignments, duplicates: 2}
	env.srv.Assignments = flaky

	rec := env.send(http.MethodPost, "/api/assignments", createBody(nil), bearer(token))
	wantStatus(t, rec, http.StatusCreated)
	created := decode[assignmentView](t, rec)
	if len(flaky.tried) != 3 {
		t.Fatalf("%d attempts, want 3", len(flaky.tried))
	}
	// Each attempt drew a new id and a new code, and the answer is the one that stuck.
	for i, a := range flaky.tried[:2] {
		if a.ID == created.ID || a.Code == created.Code || a.ID == flaky.tried[i+1].ID || a.Code == flaky.tried[i+1].Code {
			t.Fatalf("attempt %d reused an id or a code: %+v", i, flaky.tried)
		}
	}
	if _, err := env.assignments.GetByCode(context.Background(), created.Code); err != nil {
		t.Fatal(err)
	}

	// Three clashes in a row are a server error, not a loop.
	flaky.duplicates, flaky.tried = 3, nil
	if rec := env.send(http.MethodPost, "/api/assignments", createBody(nil), bearer(token)); rec.Code != http.StatusInternalServerError {
		t.Fatalf("got %d %q", rec.Code, rec.Body)
	}
	if len(flaky.tried) != 3 {
		t.Fatalf("%d attempts, want 3", len(flaky.tried))
	}
}

func TestShareCodes(t *testing.T) {
	seen := map[string]bool{}
	for range 500 {
		code := newShareCode()
		if len(code) != 10 || strings.Trim(code, shareCodeAlphabet) != "" || strings.ContainsAny(code, "ILOU") {
			t.Fatalf("code %q", code)
		}
		seen[code] = true
	}
	if len(seen) != 500 {
		t.Fatalf("500 codes gave %d distinct ones", len(seen))
	}
}

func TestStoreFailuresAreInternalErrors(t *testing.T) {
	c := newClassroom(t, nil)
	c.srv.Assignments = brokenAssignments{c.assignments}
	teacher, student := bearer(c.token), header("X-Test", "1")
	for _, rt := range []struct {
		method, path, body string
		opt                reqOpt
	}{
		{http.MethodGet, "/api/assignments", "", teacher},
		{http.MethodGet, "/api/assignments/" + c.a.ID, "", teacher},
		{http.MethodPatch, "/api/assignments/" + c.a.ID, `{"closed":true}`, teacher},
		{http.MethodDelete, "/api/assignments/" + c.a.ID, "", teacher},
		{http.MethodDelete, "/api/assignments/" + c.a.ID + "/players/x", "", teacher},
		{http.MethodGet, "/api/share/" + c.a.Code, "", student},
		{http.MethodPost, "/api/share/" + c.a.Code + "/players", `{"name":"Lan"}`, student},
		{http.MethodPost, "/api/share/" + c.a.Code + "/results", resultBody("run-0000001", 1, 5, 5), student},
	} {
		if rec := c.send(rt.method, rt.path, rt.body, rt.opt); rec.Code != http.StatusInternalServerError || rec.Body.Len() != 0 {
			t.Errorf("%s %s: %d %q", rt.method, rt.path, rec.Code, rec.Body)
		}
	}
}

// brokenAssignments fails every lookup with something that is not ErrNotFound.
type brokenAssignments struct{ store.Assignments }

var errBroken = errors.New("database is down")

func (brokenAssignments) Get(context.Context, string, string) (*store.Assignment, error) {
	return nil, errBroken
}
func (brokenAssignments) GetByCode(context.Context, string) (*store.Assignment, error) {
	return nil, errBroken
}
func (brokenAssignments) List(context.Context, string, int) ([]store.Assignment, error) {
	return nil, errBroken
}
func (brokenAssignments) Delete(context.Context, string, string) error { return errBroken }
