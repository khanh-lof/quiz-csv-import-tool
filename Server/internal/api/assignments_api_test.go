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

// createBody is a valid POST /api/assignments body for the seeded job, with some keys replaced. It has no
// stage counts: the server counts the questions itself.
func createBody(overrides map[string]any) string {
	body := map[string]any{
		"jobId":    "job1",
		"label":    "",
		"closesAt": nil,
		"timeMode": "standard",
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

func entryRank(e leaderboardEntry) int {
	if e.Rank == nil {
		return -1
	}
	return *e.Rank
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

// classroom is alice with one assignment (job "job1", stage 1 of 5 questions and stage 2 of 10, unless
// csv says another quiz, see newClassroomCSV).
type classroom struct {
	*testEnv
	token string
	a     assignmentView
	csv   string
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

// tryJoinAs is tryJoin with an avatar picked.
func (c *classroom) tryJoinAs(name, avatar string) *httptest.ResponseRecorder {
	return c.send(http.MethodPost, "/api/share/"+c.a.Code+"/players", jsonOf(map[string]any{"name": name, "avatar": avatar}))
}

// setAvatar is a student changing their own avatar.
func (c *classroom) setAvatar(token, body string) *httptest.ResponseRecorder {
	return c.send(http.MethodPatch, "/api/share/"+c.a.Code+"/player", body, header("X-Player-Token", token))
}

// board is the students' leaderboard as the holder of token (none if empty) reads it.
func (c *classroom) board(token string) *httptest.ResponseRecorder {
	var opts []reqOpt
	if token != "" {
		opts = append(opts, header("X-Player-Token", token))
	}
	return c.send(http.MethodGet, "/api/share/"+c.a.Code+"/leaderboard", "", opts...)
}

// join adds a student and returns the player's id and token.
func (c *classroom) join(t *testing.T, name string) (id, token string) {
	t.Helper()
	rec := c.tryJoin(name)
	wantStatus(t, rec, http.StatusCreated)
	body := decode[struct{ PlayerID, Token, Name string }](t, rec)
	return body.PlayerID, body.Token
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
		"label": "  Lớp 6A ", "closesAt": inTime(closes), "timeMode": "extra", "stageLock": "open",
	}))
	wantStatus(t, rec, http.StatusCreated)
	if got := rec.Header().Get("Content-Type"); got != "application/json" {
		t.Errorf("content type %q", got)
	}
	created := decode[map[string]any](t, rec)
	wantKeys := []string{"closedAt", "closesAt", "code", "createdAt", "id", "jobId", "label", "maxAttempts", "open", "passPercents", "playerCount",
		"showBoard", "stageCounts", "stageLock", "timeLimits", "timeMode", "title"}
	if got := keysOf(created); !slices.Equal(got, wantKeys) {
		t.Fatalf("keys %v, want %v", got, wantKeys)
	}
	counts, _ := created["stageCounts"].(map[string]any)
	if created["jobId"] != "job1" || created["title"] != "HSK3-Bai5" || created["label"] != "Lớp 6A" ||
		created["timeMode"] != "extra" || created["stageLock"] != "open" || created["createdAt"] != inTime(start) || created["closesAt"] != inTime(closes) ||
		created["closedAt"] != nil || created["open"] != true || created["playerCount"] != float64(0) || created["showBoard"] != true ||
		len(counts) != 2 || counts["1"] != float64(5) || counts["2"] != float64(10) {
		t.Fatalf("created %v", created)
	}
	// Extra time, told as seconds per stage: 12 s become 18.
	if limits, _ := created["timeLimits"].(map[string]any); len(limits) != 2 || limits["1"] != float64(18) || limits["2"] != float64(18) {
		t.Fatalf("created time limits %v", created["timeLimits"])
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
	if !maps.Equal(stored.StageCounts, map[string]int{"1": 5, "2": 10}) {
		t.Fatalf("stored counts %v", stored.StageCounts)
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

	// A student opens the link, typed in lower case. What they get holds the settings and the counts but
	// neither the quiz nor any answer.
	rec = env.send(http.MethodGet, "/api/share/"+strings.ToLower(code), "")
	wantStatus(t, rec, http.StatusOK)
	if rec.Header().Get("Cache-Control") != "no-store" {
		t.Errorf("share is cacheable: %v", rec.Header())
	}
	if strings.Contains(rec.Body.String(), "EXPL") || strings.Contains(rec.Body.String(), "Q1-1") {
		t.Errorf("the share answer holds the quiz: %s", rec.Body)
	}
	shared := decode[map[string]any](t, rec)
	if got, want := keysOf(shared), []string{"attempts", "closesAt", "label", "maxAttempts", "passPercents", "results", "showBoard", "stageCounts", "stageLock", "timeLimits", "timeMode", "title"}; !slices.Equal(got, want) {
		t.Fatalf("share keys %v, want %v", got, want)
	}
	sharedCounts, _ := shared["stageCounts"].(map[string]any)
	sharedResults, _ := shared["results"].(map[string]any)
	if shared["title"] != "HSK3-Bai5" || shared["label"] != "Lớp 6A" ||
		shared["timeMode"] != "extra" || shared["stageLock"] != "open" || shared["closesAt"] != inTime(closes) || shared["showBoard"] != true ||
		len(sharedCounts) != 2 || sharedCounts["1"] != float64(5) || sharedCounts["2"] != float64(10) || sharedResults == nil || len(sharedResults) != 0 {
		t.Fatalf("share %v", shared)
	}

	// Joining hands out a token; the same name, however it is typed, is taken.
	rec = c.tryJoin("Lan")
	wantStatus(t, rec, http.StatusCreated)
	joined := decode[map[string]any](t, rec)
	if got, want := keysOf(joined), []string{"avatar", "name", "playerId", "token"}; !slices.Equal(got, want) {
		t.Fatalf("join keys %v, want %v", got, want)
	}
	lanToken, _ := joined["token"].(string)
	if joined["name"] != "Lan" || len(lanToken) != 43 || joined["playerId"] == "" || joined["avatar"] != "" {
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

	// Lan passes stage 1 (4 of 5), plays it again worse, then fails stage 2.
	c.finish(t, lanToken, 1, 4)
	env.clock.Advance(time.Minute)
	c.finish(t, lanToken, 1, 2)
	c.finish(t, lanToken, 2, 6)
	// Mai, a minute later, passes both stages.
	env.clock.Advance(time.Minute)
	c.finish(t, maiToken, 1, 5)
	c.finish(t, maiToken, 2, 7)

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
		order, gotRanks = append(order, p.Name), append(gotRanks, entryRank(p))
	}
	if !slices.Equal(order, []string{"Mai", "Lan", "Nam"}) || !slices.Equal(gotRanks, []int{1, 2, -1}) {
		t.Fatalf("order %v, ranks %v", order, gotRanks)
	}

	mai, lan, nam := detail.Players[0], detail.Players[1], detail.Players[2]
	if mai.StagesPassed != 2 || mai.Correct != 12 || mai.Possible != 15 || mai.Attempts != 2 ||
		mai.ReachedAt == nil || !mai.ReachedAt.Equal(start.Add(2*time.Minute)) {
		t.Errorf("mai %+v", mai)
	}
	// The worse second run did not lower the best.
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

func TestClosingStopsOpeningJoiningAndStartingButARunInProgressGetsAGrace(t *testing.T) {
	c := newClassroom(t, map[string]any{"timeMode": "unlimited"})
	_, lanToken := c.join(t, "Lan")
	_, maiToken := c.join(t, "Mai")
	lanRun := c.start(t, lanToken, 1)
	maiRun := c.start(t, maiToken, 1)

	closedAt := c.clock.Now()
	rec := c.patch(`{"closed":true}`)
	wantStatus(t, rec, http.StatusOK)
	closed := decode[assignmentView](t, rec)
	if closed.Open || closed.ClosedAt == nil || !closed.ClosedAt.Equal(closedAt) || closed.PlayerCount != 2 {
		t.Fatalf("closed %+v", closed)
	}

	wantError(t, c.shareGet(), http.StatusGone, "Assignment closed")
	wantError(t, c.tryJoin("Zed"), http.StatusGone, "Assignment closed")
	// A new run does not start, in the grace period or out of it.
	wantError(t, c.startRun(lanToken, 1), http.StatusGone, "Assignment closed")

	// A student in the middle of a stage at the deadline still gets to finish it, for 5 minutes.
	c.clock.Advance(4 * time.Minute)
	c.complete(t, lanToken, lanRun, 5)
	c.clock.Advance(time.Minute) // exactly 5 minutes after: still inside the grace
	if q := c.next(t, maiToken, maiRun.RunID); q.Index != 0 {
		t.Fatalf("question %+v", q)
	}
	wantStatus(t, c.answer(maiToken, maiRun.RunID, 0, c.choice(t, 1, maiRun.Question, true)), http.StatusOK)
	wantError(t, c.startRun(maiToken, 1), http.StatusGone, "Assignment closed")
	c.clock.Advance(time.Second)
	wantError(t, c.nextQuestion(maiToken, maiRun.RunID), http.StatusGone, "Assignment closed")
	wantError(t, c.answer(maiToken, maiRun.RunID, 1, 0), http.StatusGone, "Assignment closed")
	c.clock.Advance(time.Minute) // 6 minutes: long past it
	wantError(t, c.nextQuestion(lanToken, lanRun.RunID), http.StatusGone, "Assignment closed")

	// The teacher still sees everything, and the run that finished in time counted.
	detail := c.detail(t)
	if detail.Open || len(detail.Players) != 2 || detail.Players[0].Name != "Lan" || detail.Players[0].StagesPassed != 1 || detail.Players[0].Attempts != 1 ||
		len(detail.Players[1].Stages) != 0 || detail.Players[1].Attempts != 1 {
		t.Fatalf("detail %+v %+v", detail.assignmentView, detail.Players)
	}
}
func TestClosingTimePasses(t *testing.T) {
	c := newClassroom(t, map[string]any{"closesAt": inTime(testClockStart.Add(30 * time.Minute)), "timeMode": "unlimited"})
	_, lanToken := c.join(t, "Lan")
	wantStatus(t, c.shareGet(), http.StatusOK)

	c.clock.Advance(29*time.Minute + 59*time.Second)
	wantStatus(t, c.shareGet(), http.StatusOK)
	run := c.start(t, lanToken, 1)
	c.clock.Advance(time.Second) // the closing time itself is already closed
	wantError(t, c.shareGet(), http.StatusGone, "Assignment closed")
	wantError(t, c.tryJoin("Mai"), http.StatusGone, "Assignment closed")
	wantError(t, c.startRun(lanToken, 1), http.StatusGone, "Assignment closed")

	rec := c.teacher(http.MethodGet, "/api/assignments", "")
	if list := decode[struct{ Assignments []assignmentView }](t, rec).Assignments; len(list) != 1 || list[0].Open {
		t.Fatalf("a passed closing time still shows open: %+v", list)
	}

	c.clock.Advance(5 * time.Minute)
	c.complete(t, lanToken, run, 5)
	c.clock.Advance(time.Second)
	wantError(t, c.nextQuestion(lanToken, run.RunID), http.StatusGone, "Assignment closed")
	wantError(t, c.answer(lanToken, run.RunID, 0, 0), http.StatusGone, "Assignment closed")
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
	c.finish(t, lanToken, 1, 5)

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
		{"label too long", createBody(map[string]any{"label": strings.Repeat("ă", 61)}), 400, "Label is too long."},
		{"label too long with trailing spaces", createBody(map[string]any{"label": strings.Repeat("x", 61) + "   "}), 400, "Label is too long."},
		{"time mode other", createBody(map[string]any{"timeMode": "fast"}), 400, "Invalid time mode."},
		{"time mode empty", createBody(map[string]any{"timeMode": ""}), 400, "Invalid time mode."},
		{"time mode missing", createBody(map[string]any{"timeMode": omit{}}), 400, "Invalid time mode."},
		{"stage lock other", createBody(map[string]any{"stageLock": "free"}), 400, "Invalid stage lock."},
		{"stage lock case", createBody(map[string]any{"stageLock": "Open"}), 400, "Invalid stage lock."},
		{"pass percent stage 7", createBody(map[string]any{"passPercents": map[string]int{"7": 70}}), 400, "Invalid pass percents."},
		{"pass percent stage not a number", createBody(map[string]any{"passPercents": map[string]int{"one": 70}}), 400, "Invalid pass percents."},
		{"pass percent stage 0", createBody(map[string]any{"passPercents": map[string]int{"0": 70}}), 400, "Invalid pass percents."},
		{"pass percent stage spelled oddly", createBody(map[string]any{"passPercents": map[string]int{"01": 70}}), 400, "Invalid pass percents."},
		{"pass percent stage with a space", createBody(map[string]any{"passPercents": map[string]int{" 1": 70}}), 400, "Invalid pass percents."},
		{"pass percent 9", createBody(map[string]any{"passPercents": map[string]int{"1": 9}}), 400, "Invalid pass percents."},
		{"pass percent 101", createBody(map[string]any{"passPercents": map[string]int{"1": 101}}), 400, "Invalid pass percents."},
		{"pass percent 0", createBody(map[string]any{"passPercents": map[string]int{"1": 0}}), 400, "Invalid pass percents."},
		{"pass percent negative", createBody(map[string]any{"passPercents": map[string]int{"1": -70}}), 400, "Invalid pass percents."},
		{"pass percent fractional", createBody(map[string]any{"passPercents": map[string]any{"1": 70.5}}), 400, "Invalid pass percents."},
		{"pass percent as a string", createBody(map[string]any{"passPercents": map[string]any{"1": "70"}}), 400, "Invalid pass percents."},
		{"pass percent null value", createBody(map[string]any{"passPercents": map[string]any{"1": nil}}), 400, "Invalid pass percents."},
		{"pass percent bool", createBody(map[string]any{"passPercents": map[string]any{"1": true}}), 400, "Invalid pass percents."},
		{"pass percents an array", createBody(map[string]any{"passPercents": []int{70}}), 400, "Invalid pass percents."},
		{"pass percents a number", createBody(map[string]any{"passPercents": 70}), 400, "Invalid pass percents."},
		{"one bad pass percent among good ones", createBody(map[string]any{"passPercents": map[string]int{"1": 70, "2": 5}}), 400, "Invalid pass percents."},
		{"replay limit with sequential lock", createBody(map[string]any{"stageLock": "sequential", "maxAttempts": 3}), 400, "Invalid replay limit."},
		{"replay limit with lock omitted", createBody(map[string]any{"maxAttempts": 3}), 400, "Invalid replay limit."},
		{"replay limit 0", createBody(map[string]any{"stageLock": "open", "maxAttempts": 0}), 400, "Invalid replay limit."},
		{"replay limit 11", createBody(map[string]any{"stageLock": "open", "maxAttempts": 11}), 400, "Invalid replay limit."},
		{"replay limit negative", createBody(map[string]any{"stageLock": "open", "maxAttempts": -1}), 400, "Invalid replay limit."},
		{"replay limit fractional", createBody(map[string]any{"stageLock": "open", "maxAttempts": 2.5}), 400, "Invalid replay limit."},
		{"replay limit as a string", createBody(map[string]any{"stageLock": "open", "maxAttempts": "3"}), 400, "Invalid replay limit."},
		{"replay limit bool", createBody(map[string]any{"stageLock": "open", "maxAttempts": true}), 400, "Invalid replay limit."},
		{"replay limit an object", createBody(map[string]any{"stageLock": "open", "maxAttempts": map[string]int{"1": 3}}), 400, "Invalid replay limit."},
		{"pass percents before replay limit", createBody(map[string]any{"passPercents": map[string]int{"1": 5}, "maxAttempts": 0}), 400, "Invalid pass percents."},
		{"board setting as the string false", createBody(map[string]any{"showBoard": "false"}), 400, "Invalid board setting."},
		{"board setting as the string true", createBody(map[string]any{"showBoard": "true"}), 400, "Invalid board setting."},
		{"board setting 0", createBody(map[string]any{"showBoard": 0}), 400, "Invalid board setting."},
		{"board setting 1", createBody(map[string]any{"showBoard": 1}), 400, "Invalid board setting."},
		{"board setting an object", createBody(map[string]any{"showBoard": map[string]bool{"show": false}}), 400, "Invalid board setting."},
		{"board setting an array", createBody(map[string]any{"showBoard": []bool{false}}), 400, "Invalid board setting."},
		{"replay limit before board setting", createBody(map[string]any{"maxAttempts": 0, "showBoard": "false"}), 400, "Invalid replay limit."},
		{"time mode case", createBody(map[string]any{"timeMode": "Standard"}), 400, "Invalid time mode."},
		{"closes in the past", createBody(map[string]any{"closesAt": inTime(now.Add(-time.Minute))}), 400, "Invalid closing time."},
		{"closes now", createBody(map[string]any{"closesAt": inTime(now)}), 400, "Invalid closing time."},
		{"closes too far ahead", createBody(map[string]any{"closesAt": inTime(now.Add(180*24*time.Hour + time.Second))}), 400, "Invalid closing time."},
		{"closes not a time", createBody(map[string]any{"closesAt": "next week"}), 400, "Invalid closing time."},
		{"closes without zone", createBody(map[string]any{"closesAt": "2026-10-15T09:00:00"}), 400, "Invalid closing time."},
		{"closes a number", createBody(map[string]any{"closesAt": 5}), 400, "Invalid payload"},
		{"job unknown", createBody(map[string]any{"jobId": "nope"}), 404, "Job not found"},
		{"job missing", createBody(map[string]any{"jobId": omit{}}), 404, "Job not found"},
		// The payload is judged before the database is asked about the job.
		{"payload before job", createBody(map[string]any{"jobId": "nope", "timeMode": "fast"}), 400, "Invalid time mode."},
		// Checks run in the order of the contract.
		{"label before time mode", createBody(map[string]any{"label": strings.Repeat("x", 61), "timeMode": "fast"}), 400, "Label is too long."},
		{"time mode before closing time", createBody(map[string]any{"timeMode": "fast", "closesAt": "x"}), 400, "Invalid time mode."},
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

	// The limits themselves are allowed: 60 runes, 180 days, all six stages.
	env.seedJob(t, "alice", "big", func(j *store.Job) { j.CSV = quizCSV(map[int]int{1: 1, 2: 50, 3: 5, 4: 5, 5: 5, 6: 5}) })
	rec := env.send(http.MethodPost, "/api/assignments", createBody(map[string]any{
		"jobId":    "big",
		"label":    strings.Repeat("ă", 60),
		"closesAt": inTime(now.Add(180 * 24 * time.Hour)),
	}), bearer(token))
	wantStatus(t, rec, http.StatusCreated)
	if got := decode[assignmentView](t, rec).StageCounts; !maps.Equal(got, map[string]int{"1": 1, "2": 50, "3": 5, "4": 5, "5": 5, "6": 5}) {
		t.Fatalf("counts %v", got)
	}
}

// The server counts the questions of each stage itself, with the parser it plays them with, and takes
// nothing from the client: a stageCounts in the body (an older page still sends one) is ignored.
func TestCreateAssignmentCountsTheQuizItself(t *testing.T) {
	env := newEnv(t)
	env.seedJob(t, "alice", "job1", nil)
	token, _ := env.login(t, "alice", "pw")
	bom := string(rune(0xFEFF))
	jobs := map[string]struct {
		csv  string
		want map[string]int
	}{
		"plain": {gestureCSV, map[string]int{"1": 5, "2": 10}},
		"fenced, with a header and rows that are dropped": {
			"Here is the quiz:\n```csv\nStage,Question,Correct Answer,Wrong Answer 1,Wrong Answer 2,Wrong Answer 3,Explanation\n" +
				"1,Q,Đúng,,,,e\n1,Q,True,,,,e\n1,Q,Có,,,,e\n2,Q,A,B,,,e\n4,Q,A,B,C,,e\n4,Q,A,,,,e\n6,Q,我 / 是,,,,\n9,Q,A,B,,,\n```\nEnjoy!",
			map[string]int{"1": 2, "2": 1, "4": 1, "6": 1},
		},
		"with a byte order mark and CRLF": {bom + "3,Q,A,B,C,,e\r\n5,Q,A,B,C,D,e\r\n", map[string]int{"3": 1, "5": 1}},
		"stages out of order":             {"6,Q,a / b,,,,\n2,Q,A,B,,,\n6,Q,c / d,,,,\n", map[string]int{"2": 1, "6": 2}},
	}
	for name, tt := range jobs {
		id := strings.ReplaceAll(name, " ", "-")
		env.seedJob(t, "alice", id, func(j *store.Job) { j.CSV = tt.csv })
		// Whatever the client claims, the counts are the server's.
		rec := env.send(http.MethodPost, "/api/assignments", createBody(map[string]any{
			"jobId": id, "stageCounts": map[string]int{"1": 99, "3": 7, "6": 50},
		}), bearer(token))
		wantStatus(t, rec, http.StatusCreated)
		if got := decode[assignmentView](t, rec).StageCounts; !maps.Equal(got, tt.want) {
			t.Errorf("%s: counts %v, want %v", name, got, tt.want)
		}
		stored, err := env.assignments.Get(context.Background(), "alice", decode[assignmentView](t, rec).ID)
		if err != nil || !maps.Equal(stored.StageCounts, tt.want) || stored.CSV != tt.csv {
			t.Errorf("%s: stored %+v, %v", name, stored, err)
		}
	}

	// Counts of any shape in the body are ignored, wrong types included: they are not read at all.
	for name, counts := range map[string]any{"a string": "five", "a wrong type": map[string]string{"1": "5"}, "null": nil, "empty": map[string]int{}} {
		rec := env.send(http.MethodPost, "/api/assignments", createBody(map[string]any{"stageCounts": counts}), bearer(token))
		if rec.Code != http.StatusCreated || !maps.Equal(decode[assignmentView](t, rec).StageCounts, map[string]int{"1": 5, "2": 10}) {
			t.Errorf("%s: %d %q", name, rec.Code, rec.Body)
		}
	}

	// A pass percent for a stage the quiz does not have is dropped without a word, not refused; the stages
	// it has keep theirs, with 70 for the rest. The assignment stores only what it keeps.
	rec := env.send(http.MethodPost, "/api/assignments", createBody(map[string]any{
		"passPercents": map[string]int{"1": 60, "3": 50, "6": 90},
	}), bearer(token))
	wantStatus(t, rec, http.StatusCreated)
	created := decode[assignmentView](t, rec)
	if want := map[string]int{"1": 60, "2": 70}; !maps.Equal(created.PassPercents, want) {
		t.Fatalf("pass percents %v, want %v", created.PassPercents, want)
	}
	stored, _ := env.assignments.Get(context.Background(), "alice", created.ID)
	if !maps.Equal(stored.PassPercents, map[string]int{"1": 60}) {
		t.Fatalf("stored pass percents %v", stored.PassPercents)
	}
	// Where every key is of a stage the quiz lacks, nothing is stored and everything reads as 70.
	rec = env.send(http.MethodPost, "/api/assignments", createBody(map[string]any{"passPercents": map[string]int{"4": 50}}), bearer(token))
	wantStatus(t, rec, http.StatusCreated)
	if got := decode[assignmentView](t, rec).PassPercents; !maps.Equal(got, map[string]int{"1": 70, "2": 70}) {
		t.Fatalf("pass percents %v", got)
	}
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
		// A finished job whose CSV holds nothing the game can play is no quiz to hand out.
		"empty csv":         func(j *store.Job) { j.CSV = "" },
		"prose":             func(j *store.Job) { j.CSV = "Sorry, I could not read the photos." },
		"only a header":     func(j *store.Job) { j.CSV = "Stage,Question,Correct Answer\n" },
		"only broken rows":  func(j *store.Job) { j.CSV = "1,Q,Có,,,,\n2,Q,A,,,,\n9,Q,A,B,,," },
		"formatted columns": func(j *store.Job) { j.CSV = "Câu hỏi,Đáp án\nxin chào,你好\n" },
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
	if shared["title"] != "HSK3-Bai5" {
		t.Fatalf("share after deleting the job: %v", shared)
	}
	if detail := c.detail(t); detail.CSV != gestureCSV || detail.JobID != "job1" {
		t.Fatalf("detail after deleting the job: %+v", detail.assignmentView)
	}
	// And the students can still play it: the server deals the questions from its own copy.
	_, token := c.join(t, "Lan")
	if run := c.start(t, token, 1); run.Total != 5 {
		t.Fatalf("run %+v", run)
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

func TestShareRoutesAnswer404ForAnUnknownCode(t *testing.T) {
	c := newClassroom(t, nil)
	_, token := c.join(t, "Lan")
	// A code is matched whole: a longer or shorter one, or one made of spaces, is another code.
	for _, code := range []string{"ZZZZZZZZZZ", c.a.Code + "X", c.a.Code[:9], "%20", "0123456789"} {
		for _, rt := range []struct{ method, path, body string }{
			{http.MethodGet, "/api/share/" + code, ""},
			{http.MethodPost, "/api/share/" + code + "/players", `{"name":"Mai"}`},
			{http.MethodPost, "/api/share/" + code + "/runs", `{"stage":1}`},
			{http.MethodPost, "/api/share/" + code + "/runs/abc/next", ""},
			{http.MethodPost, "/api/share/" + code + "/runs/abc/answers", `{"index":0,"choice":0}`},
			{http.MethodPatch, "/api/share/" + code + "/player", `{"avatar":"fox"}`},
			{http.MethodGet, "/api/share/" + code + "/leaderboard", ""},
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
		if got := passMark(n, 70); got != want {
			t.Errorf("passMark(%d, 70) = %d, want %d", n, got, want)
		}
	}
	// The client computes Math.ceil(0.7 * n) with doubles; the server does it in integers.
	for n := 1; n <= 300; n++ {
		if got, want := passMark(n, 70), int(math.Ceil(0.7*float64(n))); got != want {
			t.Errorf("passMark(%d, 70) = %d, the client's Math.ceil(0.7*n) is %d", n, got, want)
		}
		// Exact: the smallest k with 100k >= 70n.
		k := 0
		for 100*k < 70*n {
			k++
		}
		if got := passMark(n, 70); got != k {
			t.Errorf("passMark(%d, 70) = %d, exact integer ceil is %d", n, got, k)
		}
		if got := passMark(n, 100); got != n {
			t.Errorf("passMark(%d, 100) = %d, want %d", n, got, n)
		}
		for percent := minPassPercent; percent <= maxPassPercent; percent++ {
			if got := passMark(n, percent); got < 1 || got > n || 100*got < percent*n || 100*(got-1) >= percent*n {
				t.Errorf("passMark(%d, %d) = %d is not ceil(%d*n/100)", n, percent, got, percent)
			}
		}
	}
	for _, tt := range []struct{ n, percent, want int }{
		{5, 50, 3}, {5, 10, 1}, {5, 100, 5}, {10, 50, 5}, {10, 85, 9}, {7, 60, 5}, {4, 25, 1}, {3, 34, 2},
	} {
		if got := passMark(tt.n, tt.percent); got != tt.want {
			t.Errorf("passMark(%d, %d) = %d, want %d", tt.n, tt.percent, got, tt.want)
		}
	}
}

func TestResultPassesAtTheMark(t *testing.T) {
	c := newClassroom(t, map[string]any{"stageLock": "open"})
	_, token := c.join(t, "Lan")
	c.finish(t, token, 1, 3) // one short of 4
	c.finish(t, token, 2, 7)
	lan := c.detail(t).Players[0]
	if lan.Stages["1"].Passed || !lan.Stages["2"].Passed || lan.StagesPassed != 1 {
		t.Fatalf("lan %+v", lan)
	}
	c.finish(t, token, 1, 4)
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
	c.finish(t, lanToken, 1, 5)

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
	hiddenBoard := decode[assignmentView](t, c.teacher(http.MethodPost, "/api/assignments", createBody(map[string]any{"showBoard": false})))
	_, token := c.join(t, "Runner")

	authorizations := []string{"Bearer garbage", "Bearer", "Basic dXNlcjpwYXNz", "garbage", "Bearer " + c.token + "x"}
	for i, authorization := range authorizations {
		auth := header("Authorization", authorization)
		// A run to ask about; the row that starts another one comes last, as it replaces this.
		runID := c.start(t, token, 1).RunID
		tests := []struct {
			name   string
			method string
			path   string
			body   string
			token  string
			status int
		}{
			{"get", http.MethodGet, "/api/share/" + c.a.Code, "", "", 200},
			{"get with a player", http.MethodGet, "/api/share/" + c.a.Code, "", token, 200},
			{"join", http.MethodPost, "/api/share/" + c.a.Code + "/players", fmt.Sprintf(`{"name":"Zed %d"}`, i), "", 201},
			{"start without a player", http.MethodPost, "/api/share/" + c.a.Code + "/runs", `{"stage":1}`, "", 403},
			{"start with a bad token", http.MethodPost, "/api/share/" + c.a.Code + "/runs", `{"stage":1}`, "garbage", 403},
			{"start a stage the quiz lacks", http.MethodPost, "/api/share/" + c.a.Code + "/runs", `{"stage":5}`, token, 400},
			{"start a locked stage", http.MethodPost, "/api/share/" + c.a.Code + "/runs", `{"stage":2}`, token, 409},
			{"start with a bad body", http.MethodPost, "/api/share/" + c.a.Code + "/runs", `nope`, token, 400},
			{"next without a player", http.MethodPost, "/api/share/" + c.a.Code + "/runs/" + runID + "/next", "", "", 403},
			{"next a run that is not there", http.MethodPost, "/api/share/" + c.a.Code + "/runs/nope/next", "", token, 404},
			{"answer without a player", http.MethodPost, "/api/share/" + c.a.Code + "/runs/" + runID + "/answers", `{"index":0,"choice":0}`, "", 403},
			{"answer a run that is not there", http.MethodPost, "/api/share/" + c.a.Code + "/runs/nope/answers", `{"index":0,"choice":0}`, token, 404},
			{"answer something invalid", http.MethodPost, "/api/share/" + c.a.Code + "/runs/" + runID + "/answers", `{"index":3}`, token, 400},
			{"get unknown", http.MethodGet, "/api/share/ZZZZZZZZZZ", "", "", 404},
			{"join unknown", http.MethodPost, "/api/share/ZZZZZZZZZZ/players", `{"name":"Zed"}`, "", 404},
			{"start unknown", http.MethodPost, "/api/share/ZZZZZZZZZZ/runs", `{"stage":1}`, token, 404},
			{"next unknown", http.MethodPost, "/api/share/ZZZZZZZZZZ/runs/" + runID + "/next", "", token, 404},
			{"answer unknown", http.MethodPost, "/api/share/ZZZZZZZZZZ/runs/" + runID + "/answers", `{"index":0,"choice":0}`, token, 404},
			{"get closed", http.MethodGet, "/api/share/" + closedOne.Code, "", "", 410},
			{"join closed", http.MethodPost, "/api/share/" + closedOne.Code + "/players", `{"name":"Zed"}`, "", 410},
			{"start closed", http.MethodPost, "/api/share/" + closedOne.Code + "/runs", `{"stage":1}`, token, 410},
			{"join with an avatar", http.MethodPost, "/api/share/" + c.a.Code + "/players", fmt.Sprintf(`{"name":"Avatar %d","avatar":"fox"}`, i), "", 201},
			{"join with a bad avatar", http.MethodPost, "/api/share/" + c.a.Code + "/players", `{"name":"Zed","avatar":"cow"}`, "", 400},
			{"avatar without a player", http.MethodPatch, "/api/share/" + c.a.Code + "/player", `{"avatar":"fox"}`, "", 403},
			{"avatar unknown", http.MethodPatch, "/api/share/ZZZZZZZZZZ/player", `{"avatar":"fox"}`, "", 404},
			{"avatar closed", http.MethodPatch, "/api/share/" + closedOne.Code + "/player", `{"avatar":"fox"}`, "", 410},
			{"leaderboard", http.MethodGet, "/api/share/" + c.a.Code + "/leaderboard", "", "", 200},
			{"leaderboard unknown", http.MethodGet, "/api/share/ZZZZZZZZZZ/leaderboard", "", "", 404},
			{"leaderboard closed", http.MethodGet, "/api/share/" + closedOne.Code + "/leaderboard", "", "", 200},
			{"leaderboard hidden", http.MethodGet, "/api/share/" + hiddenBoard.Code + "/leaderboard", "", "", 404},
			{"start", http.MethodPost, "/api/share/" + c.a.Code + "/runs", `{"stage":1}`, token, 201},
			{"the removed results route", http.MethodPost, "/api/share/" + c.a.Code + "/results", `{"runId":"run-0000001","stage":1,"correct":5,"total":5}`, token, 404},
		}
		for _, tt := range tests {
			opts := []reqOpt{auth}
			if tt.token != "" {
				opts = append(opts, header(playerTokenHeader, tt.token))
			}
			rec := c.send(tt.method, tt.path, tt.body, opts...)
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
		// So is the avatar: a bad one is a 400 on a full assignment, a good one finds it full.
		wantError(t, c.tryJoinAs("One too many", "cow"), http.StatusBadRequest, "Invalid avatar.")
		wantError(t, c.tryJoinAs("One too many", "fox"), http.StatusConflict, "Assignment is full")

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
	c.finish(t, lanToken, 1, 5)
	c.finish(t, maiToken, 1, 4)
	maiRun := c.start(t, maiToken, 2)

	base := "/api/assignments/" + c.a.ID + "/players/"
	wantStatus(t, c.teacher(http.MethodDelete, base+lanID, ""), http.StatusNoContent)
	wantError(t, c.teacher(http.MethodDelete, base+lanID, ""), http.StatusNotFound, "Player not found")
	wantError(t, c.teacher(http.MethodDelete, base+"nobody", ""), http.StatusNotFound, "Player not found")
	wantError(t, c.teacher(http.MethodDelete, "/api/assignments/nope/players/"+maiID, ""), http.StatusNotFound, "Assignment not found")

	// Lan's token is worth nothing now, and the leaderboard has only Mai.
	wantError(t, c.startRun(lanToken, 1), http.StatusForbidden, "Unknown player")
	detail := c.detail(t)
	if detail.PlayerCount != 1 || len(detail.Players) != 1 || detail.Players[0].Name != "Mai" || entryRank(detail.Players[0]) != 1 {
		t.Fatalf("detail %+v %+v", detail.assignmentView, detail.Players)
	}
	// The name is free again.
	c.join(t, "Lan")

	// A student cannot be removed through another teacher's assignment id.
	c.createUser(t, "bob", "pw", []string{"User"})
	bobToken, _ := c.login(t, "bob", "pw")
	rec := c.send(http.MethodDelete, base+maiID, "", bearer(bobToken))
	wantError(t, rec, http.StatusNotFound, "Assignment not found")
	// Mai, whose own run was not touched, plays on.
	c.complete(t, maiToken, maiRun, 7)
}

func TestDeleteAssignment(t *testing.T) {
	c := newClassroom(t, nil)
	_, lanToken := c.join(t, "Lan")
	c.finish(t, lanToken, 1, 5)
	other := decode[assignmentView](t, c.teacher(http.MethodPost, "/api/assignments", createBody(nil)))
	wantStatus(t, c.send(http.MethodPost, "/api/share/"+other.Code+"/players", `{"name":"Lan"}`), http.StatusCreated)

	rec := c.teacher(http.MethodDelete, "/api/assignments/"+c.a.ID, "")
	wantStatus(t, rec, http.StatusNoContent)
	if rec.Body.Len() != 0 {
		t.Fatalf("a 204 carries a body: %q", rec.Body)
	}

	wantError(t, c.shareGet(), http.StatusNotFound, "Assignment not found")
	wantError(t, c.tryJoin("Mai"), http.StatusNotFound, "Assignment not found")
	wantError(t, c.startRun(lanToken, 1), http.StatusNotFound, "Assignment not found")
	wantError(t, c.nextQuestion(lanToken, "any"), http.StatusNotFound, "Assignment not found")
	wantError(t, c.answer(lanToken, "any", 0, 0), http.StatusNotFound, "Assignment not found")
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
		{http.MethodPost, "/api/share/" + c.a.Code + "/runs", `{"stage":1}`, student},
		{http.MethodPost, "/api/share/" + c.a.Code + "/runs/abc/next", "", student},
		{http.MethodPost, "/api/share/" + c.a.Code + "/runs/abc/answers", `{"index":0,"choice":0}`, student},
		{http.MethodPatch, "/api/share/" + c.a.Code + "/player", `{"avatar":"fox"}`, student},
		{http.MethodGet, "/api/share/" + c.a.Code + "/leaderboard", "", student},
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

// An assignment created without a stage lock, or stored before the setting existed, plays as it always
// did: each stage opens once the one before it is passed.
func TestStageLockDefaultsToSequential(t *testing.T) {
	if got := stageLockOf(&store.Assignment{}); got != "sequential" {
		t.Errorf("empty lock reads %q", got)
	}
	if got := stageLockOf(&store.Assignment{StageLock: "open"}); got != "open" {
		t.Errorf("open lock reads %q", got)
	}
	if !validStageLock("sequential") || !validStageLock("open") || validStageLock("") {
		t.Error("validStageLock disagrees with the contract")
	}
}

// ---- pass percents ----

func TestCreateWithPassPercents(t *testing.T) {
	c := newClassroom(t, map[string]any{"passPercents": map[string]int{"2": 50}})
	want := map[string]int{"1": 70, "2": 50}
	if !maps.Equal(c.a.PassPercents, want) {
		t.Fatalf("created %v, want %v", c.a.PassPercents, want)
	}
	// The same complete map comes back from the detail, the list and the share answer.
	if got := c.detail(t).PassPercents; !maps.Equal(got, want) {
		t.Errorf("detail %v", got)
	}
	rec := c.teacher(http.MethodGet, "/api/assignments", "")
	wantStatus(t, rec, http.StatusOK)
	if list := decode[struct{ Assignments []assignmentView }](t, rec).Assignments; len(list) != 1 || !maps.Equal(list[0].PassPercents, want) {
		t.Errorf("list %+v", list)
	}
	shared := decode[struct{ PassPercents map[string]int }](t, c.shareGet())
	if !maps.Equal(shared.PassPercents, want) {
		t.Errorf("share %v", shared.PassPercents)
	}
	// It is fixed for the assignment's life: a PATCH leaves it alone.
	wantStatus(t, c.patch(`{"label":"x","passPercents":{"1":10}}`), http.StatusOK)
	if got := c.detail(t).PassPercents; !maps.Equal(got, want) {
		t.Errorf("after patch %v", got)
	}

	// The limits are allowed, and null or an empty object mean all default.
	for name, v := range map[string]any{"limits": map[string]int{"1": 10, "2": 100}, "null": nil, "empty": map[string]int{}} {
		c := newClassroom(t, map[string]any{"passPercents": v})
		wantAll := map[string]int{"1": 70, "2": 70}
		if name == "limits" {
			wantAll = map[string]int{"1": 10, "2": 100}
		}
		if !maps.Equal(c.a.PassPercents, wantAll) {
			t.Errorf("%s: %v, want %v", name, c.a.PassPercents, wantAll)
		}
	}
}

func TestPassPercentsDefaultToSeventy(t *testing.T) {
	c := newClassroom(t, nil)
	want := map[string]int{"1": 70, "2": 70}
	if !maps.Equal(c.a.PassPercents, want) {
		t.Fatalf("created %v", c.a.PassPercents)
	}
}

func TestResultPassesAtTheTeachersPercent(t *testing.T) {
	c := newClassroom(t, map[string]any{"passPercents": map[string]int{"1": 60}})
	_, token := c.join(t, "Lan")
	c.finish(t, token, 1, 3) // 3 of 5 is 60%
	c.finish(t, token, 2, 6) // the default 70% needs 7
	lan := c.detail(t).Players[0]
	if !lan.Stages["1"].Passed || lan.Stages["2"].Passed || lan.StagesPassed != 1 {
		t.Fatalf("lan %+v", lan)
	}

	// The same 3 of 5 does not pass where the teacher set nothing.
	d := newClassroom(t, nil)
	_, token = d.join(t, "Lan")
	d.finish(t, token, 1, 3)
	if lan = d.detail(t).Players[0]; lan.Stages["1"].Passed || lan.StagesPassed != 0 {
		t.Fatalf("default lan %+v", lan)
	}

	// A strict stage: 100% needs every answer.
	e := newClassroom(t, map[string]any{"stageLock": "open", "passPercents": map[string]int{"2": 100}})
	_, token = e.join(t, "Lan")
	e.finish(t, token, 2, 9)
	if lan = e.detail(t).Players[0]; lan.Stages["2"].Passed {
		t.Fatalf("9 of 10 passed a 100%% stage: %+v", lan)
	}
	e.finish(t, token, 2, 10)
	if lan = e.detail(t).Players[0]; !lan.Stages["2"].Passed || lan.StagesPassed != 1 {
		t.Fatalf("10 of 10 did not pass: %+v", lan)
	}
}

// An assignment stored before the setting existed has no passPercents: it reads as 70 everywhere.
func TestAssignmentWithoutPassPercentsReadsAsSeventy(t *testing.T) {
	env := newEnv(t)
	env.seedJob(t, "alice", "job1", nil)
	token, _ := env.login(t, "alice", "pw")
	old := &store.Assignment{
		ID: "old1", Code: "OLDCODE123", Username: "alice", JobID: "job1", Title: "HSK3-Bai5", CSV: gestureCSV,
		TimeMode: "standard", StageLock: "open", StageCounts: map[string]int{"1": 5, "2": 10}, CreatedAt: env.clock.Now(),
	}
	if err := env.assignments.Create(context.Background(), old); err != nil {
		t.Fatal(err)
	}
	c := &classroom{testEnv: env, token: token}
	rec := c.teacher(http.MethodGet, "/api/assignments/old1", "")
	wantStatus(t, rec, http.StatusOK)
	c.a = decode[assignmentDetailView](t, rec).assignmentView
	want := map[string]int{"1": 70, "2": 70}
	if !maps.Equal(c.a.PassPercents, want) {
		t.Fatalf("view %v", c.a.PassPercents)
	}
	shared := decode[struct{ PassPercents map[string]int }](t, c.shareGet())
	if !maps.Equal(shared.PassPercents, want) {
		t.Fatalf("share %v", shared.PassPercents)
	}
	_, ptoken := c.join(t, "Lan")
	c.finish(t, ptoken, 1, 3)
	c.finish(t, ptoken, 2, 7)
	lan := c.detail(t).Players[0]
	if lan.Stages["1"].Passed || !lan.Stages["2"].Passed {
		t.Fatalf("lan %+v", lan)
	}
	c.finish(t, ptoken, 1, 4)
	if lan = c.detail(t).Players[0]; !lan.Stages["1"].Passed || lan.StagesPassed != 2 {
		t.Fatalf("lan %+v", lan)
	}
}

// ---- replay limit ----

func TestCreateWithMaxAttempts(t *testing.T) {
	c := newClassroom(t, map[string]any{"stageLock": "open", "maxAttempts": 3})
	if c.a.MaxAttempts == nil || *c.a.MaxAttempts != 3 {
		t.Fatalf("created %v", c.a.MaxAttempts)
	}
	if got := c.detail(t).MaxAttempts; got == nil || *got != 3 {
		t.Errorf("detail %v", got)
	}
	rec := c.teacher(http.MethodGet, "/api/assignments", "")
	wantStatus(t, rec, http.StatusOK)
	if list := decode[struct{ Assignments []assignmentView }](t, rec).Assignments; len(list) != 1 || list[0].MaxAttempts == nil || *list[0].MaxAttempts != 3 {
		t.Errorf("list %+v", list)
	}
	shared := decode[map[string]any](t, c.shareGet())
	if shared["maxAttempts"] != float64(3) {
		t.Errorf("share %v", shared["maxAttempts"])
	}
	// It is fixed for the assignment's life: a PATCH leaves it alone.
	wantStatus(t, c.patch(`{"label":"x","maxAttempts":9}`), http.StatusOK)
	if got := c.detail(t).MaxAttempts; got == nil || *got != 3 {
		t.Errorf("after patch %v", got)
	}

	// The limits are allowed.
	for _, n := range []int{1, 10} {
		c := newClassroom(t, map[string]any{"stageLock": "open", "maxAttempts": n})
		if c.a.MaxAttempts == nil || *c.a.MaxAttempts != n {
			t.Errorf("%d: %v", n, c.a.MaxAttempts)
		}
	}
}

func TestMaxAttemptsDefaultsToUnlimited(t *testing.T) {
	for name, overrides := range map[string]map[string]any{
		"absent":      nil,
		"null":        {"maxAttempts": nil},
		"open absent": {"stageLock": "open"},
		"open null":   {"stageLock": "open", "maxAttempts": nil},
		"sequential":  {"stageLock": "sequential", "maxAttempts": nil},
	} {
		c := newClassroom(t, overrides)
		if c.a.MaxAttempts != nil {
			t.Errorf("%s: view %v", name, *c.a.MaxAttempts)
		}
		// The key is always there, null when unlimited.
		detail := decode[map[string]any](t, c.teacher(http.MethodGet, "/api/assignments/"+c.a.ID, ""))
		if v, ok := detail["maxAttempts"]; !ok || v != nil {
			t.Errorf("%s: detail key %v, %v", name, v, ok)
		}
		shared := decode[map[string]any](t, c.shareGet())
		if v, ok := shared["maxAttempts"]; !ok || v != nil {
			t.Errorf("%s: share key %v, %v", name, v, ok)
		}
	}
}

// An assignment stored before the setting existed has no maxAttempts: it reads as unlimited.
func TestAssignmentWithoutMaxAttemptsIsUnlimited(t *testing.T) {
	env := newEnv(t)
	env.seedJob(t, "alice", "job1", nil)
	token, _ := env.login(t, "alice", "pw")
	old := &store.Assignment{
		ID: "old1", Code: "OLDCODE123", Username: "alice", JobID: "job1", Title: "HSK3-Bai5", CSV: gestureCSV,
		TimeMode: "standard", StageLock: "open", StageCounts: map[string]int{"1": 5, "2": 10}, CreatedAt: env.clock.Now(),
	}
	if err := env.assignments.Create(context.Background(), old); err != nil {
		t.Fatal(err)
	}
	c := &classroom{testEnv: env, token: token}
	rec := c.teacher(http.MethodGet, "/api/assignments/old1", "")
	wantStatus(t, rec, http.StatusOK)
	c.a = decode[assignmentDetailView](t, rec).assignmentView
	if c.a.MaxAttempts != nil {
		t.Fatalf("view %v", *c.a.MaxAttempts)
	}
	if shared := decode[map[string]any](t, c.shareGet()); shared["maxAttempts"] != nil {
		t.Fatalf("share %v", shared["maxAttempts"])
	}
	_, ptoken := c.join(t, "Lan")
	for i := 0; i < 12; i++ {
		c.finish(t, ptoken, 1, 3)
	}
	if got := c.detail(t).Players[0].Stages["1"].Attempts; got != 12 {
		t.Fatalf("%d attempts", got)
	}
}

// ---- students' board setting ----

func TestCreateWithShowBoard(t *testing.T) {
	c := newClassroom(t, map[string]any{"showBoard": false})
	if c.a.ShowBoard {
		t.Fatalf("created %+v", c.a)
	}
	if c.detail(t).ShowBoard {
		t.Errorf("detail says the board is shown")
	}
	rec := c.teacher(http.MethodGet, "/api/assignments", "")
	wantStatus(t, rec, http.StatusOK)
	if list := decode[struct{ Assignments []assignmentView }](t, rec).Assignments; len(list) != 1 || list[0].ShowBoard {
		t.Errorf("list %+v", list)
	}
	rec = c.shareGet()
	wantStatus(t, rec, http.StatusOK)
	if shared := decode[map[string]any](t, rec); shared["showBoard"] != false {
		t.Errorf("share %v", shared["showBoard"])
	}
	stored, err := c.assignments.Get(context.Background(), "alice", c.a.ID)
	if err != nil || !stored.HideBoard {
		t.Fatalf("stored %+v, %v", stored, err)
	}
	// It is fixed for the assignment's life: a PATCH leaves it alone.
	wantStatus(t, c.patch(`{"label":"x","showBoard":true}`), http.StatusOK)
	if c.detail(t).ShowBoard {
		t.Errorf("a patch showed the board")
	}

	// Showing it is the default, however that is asked for.
	for name, overrides := range map[string]map[string]any{
		"true":   {"showBoard": true},
		"absent": {"showBoard": omit{}},
		"null":   {"showBoard": nil},
	} {
		c := newClassroom(t, overrides)
		if !c.a.ShowBoard || !c.detail(t).ShowBoard {
			t.Errorf("%s: created %+v", name, c.a)
		}
		if shared := decode[map[string]any](t, c.shareGet()); shared["showBoard"] != true {
			t.Errorf("%s: share %v", name, shared["showBoard"])
		}
		stored, err := c.assignments.Get(context.Background(), "alice", c.a.ID)
		if err != nil || stored.HideBoard {
			t.Errorf("%s: stored %+v, %v", name, stored, err)
		}
	}
}

// An assignment stored before the setting existed has no hideBoard: its board is shown.
func TestAssignmentWithoutHideBoardShowsTheBoard(t *testing.T) {
	env := newEnv(t)
	env.seedJob(t, "alice", "job1", nil)
	token, _ := env.login(t, "alice", "pw")
	old := &store.Assignment{
		ID: "old1", Code: "OLDCODE123", Username: "alice", JobID: "job1", Title: "HSK3-Bai5", CSV: gestureCSV,
		TimeMode: "standard", StageCounts: map[string]int{"1": 5, "2": 10}, CreatedAt: env.clock.Now(),
	}
	if err := env.assignments.Create(context.Background(), old); err != nil {
		t.Fatal(err)
	}
	c := &classroom{testEnv: env, token: token}
	rec := c.teacher(http.MethodGet, "/api/assignments/old1", "")
	wantStatus(t, rec, http.StatusOK)
	c.a = decode[assignmentDetailView](t, rec).assignmentView
	if !c.a.ShowBoard {
		t.Fatalf("view %+v", c.a)
	}
	if shared := decode[map[string]any](t, c.shareGet()); shared["showBoard"] != true {
		t.Fatalf("share %v", shared["showBoard"])
	}
	boardOf(t, c.board(""))
}

// ---- avatars ----

// joinAs adds a student with an avatar and returns the player's id and token.
func (c *classroom) joinAs(t *testing.T, name, avatar string) (id, token string) {
	t.Helper()
	rec := c.tryJoinAs(name, avatar)
	wantStatus(t, rec, http.StatusCreated)
	body := decode[struct{ PlayerID, Token string }](t, rec)
	return body.PlayerID, body.Token
}

// avatarsOf is the avatar of each player of the assignment, by name, as the teacher's detail shows them.
func (c *classroom) avatarsOf(t *testing.T) map[string]string {
	t.Helper()
	out := map[string]string{}
	for _, p := range c.detail(t).Players {
		out[p.Name] = p.Avatar
	}
	return out
}

func TestJoinAvatarRules(t *testing.T) {
	c := newClassroom(t, nil)
	tests := []struct {
		name       string
		body       string
		status     int
		wantAvatar string // the stored avatar, or the error message
	}{
		{"an avatar", `{"name":"Lan","avatar":"panda"}`, 201, "panda"},
		{"none sent, as a page from before avatars does", `{"name":"Mai"}`, 201, ""},
		{"empty", `{"name":"Nam","avatar":""}`, 201, ""},
		{"null", `{"name":"Bao","avatar":null}`, 201, ""},
		{"an id that is not an avatar", `{"name":"An","avatar":"cow"}`, 400, "Invalid avatar."},
		{"another case", `{"name":"An","avatar":"Panda"}`, 400, "Invalid avatar."},
		{"padded", `{"name":"An","avatar":" panda"}`, 400, "Invalid avatar."},
		{"only spaces", `{"name":"An","avatar":"  "}`, 400, "Invalid avatar."},
		{"the emoji instead of the id", `{"name":"An","avatar":"🐼"}`, 400, "Invalid avatar."},
		{"not a string", `{"name":"An","avatar":5}`, 400, "Invalid payload"},
		// The name is judged first, so a bad name wins over a bad avatar.
		{"bad name and bad avatar", `{"name":"","avatar":"cow"}`, 400, "Invalid name."},
		{"bad name and a good avatar", `{"name":"","avatar":"fox"}`, 400, "Invalid name."},
		{"a taken name with a good avatar", `{"name":"lan","avatar":"fox"}`, 409, "Name taken"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rec := c.send(http.MethodPost, "/api/share/"+c.a.Code+"/players", tt.body)
			if tt.status != http.StatusCreated {
				wantError(t, rec, tt.status, tt.wantAvatar)
				return
			}
			wantStatus(t, rec, http.StatusCreated)
			if got := decode[struct{ Avatar string }](t, rec).Avatar; got != tt.wantAvatar {
				t.Fatalf("avatar %q, want %q", got, tt.wantAvatar)
			}
		})
	}

	// The refusals created nobody, the others kept what they sent, and the teacher sees it.
	want := map[string]string{"Lan": "panda", "Mai": "", "Nam": "", "Bao": ""}
	if got := c.avatarsOf(t); !maps.Equal(got, want) {
		t.Fatalf("avatars %v, want %v", got, want)
	}
	c.join(t, "An") // the name was never taken by the refused joins

	// Every avatar of the set can be picked.
	for i, id := range avatarIDs {
		c.joinAs(t, fmt.Sprintf("Student %d", i), id)
	}
	for i, id := range avatarIDs {
		if got := c.avatarsOf(t)[fmt.Sprintf("Student %d", i)]; got != id {
			t.Errorf("student %d has %q, want %q", i, got, id)
		}
	}
}

func TestUpdateSharedPlayer(t *testing.T) {
	c := newClassroom(t, nil)
	lanID, lanToken := c.join(t, "Lan")
	_, maiToken := c.joinAs(t, "Mai", "owl")

	rec := c.setAvatar(lanToken, `{"avatar":"fox"}`)
	wantStatus(t, rec, http.StatusOK)
	if got := rec.Header().Get("Content-Type"); got != "application/json" {
		t.Errorf("content type %q", got)
	}
	answer := decode[map[string]any](t, rec)
	if got, want := keysOf(answer), []string{"avatar", "name", "playerId"}; !slices.Equal(got, want) {
		t.Fatalf("keys %v, want %v", got, want)
	}
	if answer["playerId"] != lanID || answer["name"] != "Lan" || answer["avatar"] != "fox" {
		t.Fatalf("answer %v", answer)
	}

	// The teacher's leaderboard shows it on that player only.
	if got, want := c.avatarsOf(t), map[string]string{"Lan": "fox", "Mai": "owl"}; !maps.Equal(got, want) {
		t.Fatalf("avatars %v, want %v", got, want)
	}

	// Picking again replaces it, and the same avatar twice is fine.
	wantStatus(t, c.setAvatar(lanToken, `{"avatar":"frog"}`), http.StatusOK)
	wantStatus(t, c.setAvatar(lanToken, `{"avatar":"frog"}`), http.StatusOK)
	wantStatus(t, c.setAvatar(maiToken, `{"avatar":"frog"}`), http.StatusOK) // two students may share one
	if got, want := c.avatarsOf(t), map[string]string{"Lan": "frog", "Mai": "frog"}; !maps.Equal(got, want) {
		t.Fatalf("avatars %v, want %v", got, want)
	}

	// The token is the lookup, so the body cannot name another player, and a result keeps the avatar.
	rec = c.setAvatar(lanToken, `{"avatar":"cat","playerId":"someone-else","name":"Mai"}`)
	wantStatus(t, rec, http.StatusOK)
	if got := decode[map[string]string](t, rec); got["name"] != "Lan" || got["playerId"] != lanID {
		t.Fatalf("answer %v", got)
	}
	c.finish(t, lanToken, 1, 5)
	if got, want := c.avatarsOf(t), map[string]string{"Lan": "cat", "Mai": "frog"}; !maps.Equal(got, want) {
		t.Fatalf("avatars after a result %v, want %v", got, want)
	}
	if lan := c.detail(t).Players[0]; lan.Name != "Lan" || lan.Correct != 5 || lan.Avatar != "cat" {
		t.Fatalf("lan %+v", lan)
	}

	// The code is trimmed and upper-cased like everywhere else on the student routes.
	rec = c.send(http.MethodPatch, "/api/share/%20"+strings.ToLower(c.a.Code)+"%20/player", `{"avatar":"dog"}`, header("X-Player-Token", lanToken))
	wantStatus(t, rec, http.StatusOK)
}

func TestUpdateSharedPlayerErrors(t *testing.T) {
	c := newClassroom(t, nil)
	_, lanToken := c.joinAs(t, "Lan", "panda")
	other := decode[assignmentView](t, c.teacher(http.MethodPost, "/api/assignments", createBody(nil)))

	patchOn := func(code, token, body string) *httptest.ResponseRecorder {
		var opts []reqOpt
		if token != "" {
			opts = append(opts, header("X-Player-Token", token))
		}
		return c.send(http.MethodPatch, "/api/share/"+code+"/player", body, opts...)
	}
	good := `{"avatar":"fox"}`

	// 404: the code, before anything else is looked at.
	wantError(t, patchOn("ZZZZZZZZZZ", lanToken, good), http.StatusNotFound, "Assignment not found")
	wantError(t, patchOn("ZZZZZZZZZZ", "", "nope"), http.StatusNotFound, "Assignment not found")

	// 403: no token, an unknown one, the hash instead of the token, and a token of another assignment.
	// It is checked before the body is read.
	players, _ := c.assignments.ListPlayers(context.Background(), c.a.ID)
	for name, token := range map[string]string{
		"missing":                "",
		"unknown":                "not-a-token",
		"the stored hash":        players[0].TokenHash,
		"another assignment's":   lanToken,
		"a token with a newline": lanToken + "\n",
	} {
		code := c.a.Code
		if name == "another assignment's" {
			code = other.Code
		}
		wantError(t, patchOn(code, token, good), http.StatusForbidden, "Unknown player")
		wantError(t, patchOn(code, token, "nope"), http.StatusForbidden, "Unknown player")
	}

	// 400: the payload, then the avatar; the player is known by now.
	for name, tt := range map[string]struct{ body, msg string }{
		"no body":          {``, "Missing body"},
		"not json":         {`nope`, "Invalid payload"},
		"not a string":     {`{"avatar":5}`, "Invalid payload"},
		"an object":        {`{"avatar":{"id":"fox"}}`, "Invalid payload"},
		"no avatar":        {`{}`, "Invalid avatar."},
		"empty":            {`{"avatar":""}`, "Invalid avatar."},
		"null":             {`{"avatar":null}`, "Invalid avatar."},
		"only spaces":      {`{"avatar":" "}`, "Invalid avatar."},
		"unknown":          {`{"avatar":"cow"}`, "Invalid avatar."},
		"another case":     {`{"avatar":"Fox"}`, "Invalid avatar."},
		"padded":           {`{"avatar":"fox "}`, "Invalid avatar."},
		"the emoji itself": {`{"avatar":"🦊"}`, "Invalid avatar."},
	} {
		if rec := patchOn(c.a.Code, lanToken, tt.body); rec.Code != http.StatusBadRequest || rec.Body.String() != tt.msg {
			t.Errorf("%s: got %d %q, want 400 %q", name, rec.Code, rec.Body, tt.msg)
		}
	}
	if got := c.avatarsOf(t)["Lan"]; got != "panda" {
		t.Fatalf("a refused change set the avatar to %q", got)
	}

	// 410: once the assignment is closed, before the token is looked at, and nothing changes.
	wantStatus(t, c.patch(`{"closed":true}`), http.StatusOK)
	wantError(t, patchOn(c.a.Code, lanToken, good), http.StatusGone, "Assignment closed")
	wantError(t, patchOn(c.a.Code, "", good), http.StatusGone, "Assignment closed")
	wantError(t, patchOn(c.a.Code, lanToken, "nope"), http.StatusGone, "Assignment closed")
	wantError(t, patchOn("ZZZZZZZZZZ", lanToken, good), http.StatusNotFound, "Assignment not found")
	if got := c.avatarsOf(t)["Lan"]; got != "panda" {
		t.Fatalf("a refused change set the avatar to %q", got)
	}

	// Reopened, the student can change it again.
	wantStatus(t, c.patch(`{"closed":false}`), http.StatusOK)
	wantStatus(t, patchOn(c.a.Code, lanToken, good), http.StatusOK)
}

func TestUpdateSharedPlayerOfARemovedStudent(t *testing.T) {
	c := newClassroom(t, nil)
	lanID, lanToken := c.join(t, "Lan")
	c.join(t, "Mai")
	wantStatus(t, c.teacher(http.MethodDelete, "/api/assignments/"+c.a.ID+"/players/"+lanID, ""), http.StatusNoContent)

	wantError(t, c.setAvatar(lanToken, `{"avatar":"fox"}`), http.StatusForbidden, "Unknown player")
	if got := c.avatarsOf(t); !maps.Equal(got, map[string]string{"Mai": ""}) {
		t.Fatalf("avatars %v", got)
	}

	// The teacher can also remove the student between the token check and the write.
	_, namToken := c.join(t, "Nam")
	c.srv.Assignments = avatarFailing{c.assignments, store.ErrNotFound}
	wantError(t, c.setAvatar(namToken, `{"avatar":"fox"}`), http.StatusForbidden, "Unknown player")
}

// avatarFailing makes every SetPlayerAvatar fail with err, whatever the player.
type avatarFailing struct {
	store.Assignments
	err error
}

func (a avatarFailing) SetPlayerAvatar(context.Context, string, string, string) error { return a.err }

// tokenLookupFailing makes every PlayerByToken fail with err.
type tokenLookupFailing struct {
	store.Assignments
	err error
}

func (a tokenLookupFailing) PlayerByToken(context.Context, string, string) (*store.Player, error) {
	return nil, a.err
}

func TestAvatarStoreFailuresAreInternalErrors(t *testing.T) {
	c := newClassroom(t, nil)
	_, token := c.join(t, "Lan")

	c.srv.Assignments = avatarFailing{c.assignments, errBroken}
	if rec := c.setAvatar(token, `{"avatar":"fox"}`); rec.Code != http.StatusInternalServerError || rec.Body.Len() != 0 {
		t.Errorf("writing the avatar: %d %q", rec.Code, rec.Body)
	}

	c.srv.Assignments = tokenLookupFailing{c.assignments, errBroken}
	if rec := c.setAvatar(token, `{"avatar":"fox"}`); rec.Code != http.StatusInternalServerError || rec.Body.Len() != 0 {
		t.Errorf("looking up the player to change: %d %q", rec.Code, rec.Body)
	}
	if rec := c.board(token); rec.Code != http.StatusInternalServerError || rec.Body.Len() != 0 {
		t.Errorf("looking up the reader of the board: %d %q", rec.Code, rec.Body)
	}
	// Without a token nothing is looked up, so the board does not depend on it.
	wantStatus(t, c.board(""), http.StatusOK)
}

// ---- the students' leaderboard ----

// classOf joins the students in order, each of whom finishes stage 1 with full marks a minute after the
// one before, so they are ranked in the order given. It returns their tokens and player ids by name.
func classOf(t *testing.T, c *classroom, names ...string) (tokens, ids map[string]string) {
	t.Helper()
	tokens, ids = map[string]string{}, map[string]string{}
	for i, name := range names {
		ids[name], tokens[name] = c.joinAs(t, name, avatarIDs[i%len(avatarIDs)])
	}
	for _, name := range names {
		c.clock.Advance(time.Minute)
		c.finish(t, tokens[name], 1, 5)
	}
	return tokens, ids
}

func boardOf(t *testing.T, rec *httptest.ResponseRecorder) studentBoard {
	t.Helper()
	wantStatus(t, rec, http.StatusOK)
	if got := rec.Header().Get("Cache-Control"); got != "no-store" {
		t.Errorf("the board is cacheable: %q", got)
	}
	if got := rec.Header().Get("Content-Type"); got != "application/json" {
		t.Errorf("content type %q", got)
	}
	return decode[studentBoard](t, rec)
}

func TestSharedLeaderboardShowsTheTopFiveAndYou(t *testing.T) {
	c := newClassroom(t, nil) // stage 1 has 5 questions, stage 2 has 10
	tokens, ids := classOf(t, c, "S1", "S2", "S3", "S4", "S5", "S6", "S7")
	_, idleToken := c.join(t, "Idle")

	// Without a token: the top five and nobody to be.
	board := boardOf(t, c.board(""))
	if got, want := boardNames(board), []string{"S1", "S2", "S3", "S4", "S5"}; !slices.Equal(got, want) {
		t.Fatalf("names %v, want %v", got, want)
	}
	if got, want := boardRanks(board), []int{1, 2, 3, 4, 5}; !slices.Equal(got, want) {
		t.Fatalf("ranks %v, want %v", got, want)
	}
	if board.You != nil || board.Possible != 15 || board.StageCount != 2 || board.PlayerCount != 8 {
		t.Fatalf("board %+v", board)
	}
	if first := board.Top[0]; first.Avatar != avatarIDs[0] || first.StagesPassed != 1 || first.Correct != 5 || first.You {
		t.Errorf("first row %+v", first)
	}

	// A student inside the top is marked on their row and named in you.
	board = boardOf(t, c.board(tokens["S3"]))
	if board.You == nil || board.You.Rank == nil || *board.You.Rank != 3 || board.You.Name != "S3" ||
		board.You.Avatar != avatarIDs[2] || board.You.StagesPassed != 1 || board.You.Correct != 5 {
		t.Fatalf("you %+v", board.You)
	}
	for _, row := range board.Top {
		if row.You != (row.Name == "S3") {
			t.Errorf("row %+v", row)
		}
	}

	// One outside it gets the same top and their own place under it.
	board = boardOf(t, c.board(tokens["S7"]))
	if board.You == nil || board.You.Rank == nil || *board.You.Rank != 7 || board.You.Name != "S7" {
		t.Fatalf("you %+v", board.You)
	}
	if got, want := boardNames(board), []string{"S1", "S2", "S3", "S4", "S5"}; !slices.Equal(got, want) {
		t.Fatalf("names %v, want %v", got, want)
	}
	for _, row := range board.Top {
		if row.You {
			t.Errorf("a row is marked as the reader's own: %+v", row)
		}
	}

	// One without a result is on the class's count but has no rank.
	board = boardOf(t, c.board(idleToken))
	if board.You == nil || board.You.Rank != nil || board.You.Name != "Idle" || board.You.Correct != 0 {
		t.Fatalf("you %+v", board.You)
	}

	// The board moves with the results: S7 overtakes by passing stage 2 as well.
	c.finish(t, tokens["S7"], 2, 10)
	board = boardOf(t, c.board(tokens["S7"]))
	if got, want := boardNames(board), []string{"S7", "S1", "S2", "S3", "S4"}; !slices.Equal(got, want) {
		t.Fatalf("names %v, want %v", got, want)
	}
	if board.You == nil || *board.You.Rank != 1 || board.You.StagesPassed != 2 || board.You.Correct != 15 || !board.Top[0].You {
		t.Fatalf("you %+v, first %+v", board.You, board.Top[0])
	}

	// A student who changes the avatar shows the new one at once, on the row and in you.
	wantStatus(t, c.setAvatar(tokens["S7"], `{"avatar":"unicorn"}`), http.StatusOK)
	board = boardOf(t, c.board(tokens["S7"]))
	if board.Top[0].Avatar != "unicorn" || board.You.Avatar != "unicorn" {
		t.Fatalf("avatar of %+v, %+v", board.Top[0], board.You)
	}

	// A removed student leaves the board, and their token is worth nothing.
	wantStatus(t, c.teacher(http.MethodDelete, "/api/assignments/"+c.a.ID+"/players/"+ids["S7"], ""), http.StatusNoContent)
	board = boardOf(t, c.board(tokens["S7"]))
	if board.You != nil || board.PlayerCount != 7 || board.Top[0].Name != "S1" {
		t.Fatalf("board %+v", board)
	}
}

func TestSharedLeaderboardAnswersTiesAndTheCap(t *testing.T) {
	// Three students reach the same score at the same moment, so they share 5th place.
	c := newClassroom(t, nil)
	classOf(t, c, "A", "B", "C", "D")
	c.clock.Advance(time.Minute)
	for _, name := range []string{"E", "F", "G"} {
		_, token := c.join(t, name)
		c.finish(t, token, 1, 5)
	}
	c.clock.Advance(time.Minute)
	_, hToken := c.join(t, "H")
	c.finish(t, hToken, 1, 5)

	board := boardOf(t, c.board(hToken))
	// Those who tie are listed by when they joined, which was the same moment, so by an id that is random.
	names := boardNames(board)
	slices.Sort(names[4:])
	if want := []string{"A", "B", "C", "D", "E", "F", "G"}; !slices.Equal(names, want) {
		t.Fatalf("names %v, want %v", names, want)
	}
	if got, want := boardRanks(board), []int{1, 2, 3, 4, 5, 5, 5}; !slices.Equal(got, want) {
		t.Fatalf("ranks %v, want %v", got, want)
	}
	if board.You == nil || *board.You.Rank != 8 || board.PlayerCount != 8 {
		t.Fatalf("board %+v", board)
	}

	// Twelve students who all tie for first place fill ten rows, not twelve.
	c = newClassroom(t, nil)
	for i := range 12 {
		_, token := c.join(t, fmt.Sprintf("Tie %d", i))
		c.finish(t, token, 1, 5)
	}
	board = boardOf(t, c.board(""))
	if len(board.Top) != 10 || board.PlayerCount != 12 {
		t.Fatalf("%d rows, %d players", len(board.Top), board.PlayerCount)
	}
	for _, row := range board.Top {
		if row.Rank != 1 {
			t.Errorf("row %+v", row)
		}
	}
}

func TestSharedLeaderboardWhenNobodyHasPlayed(t *testing.T) {
	c := newClassroom(t, nil)
	rec := c.board("")
	wantStatus(t, rec, http.StatusOK)
	if got, want := strings.TrimSpace(rec.Body.String()), `{"top":[],"you":null,"possible":15,"stageCount":2,"playerCount":0}`; got != want {
		t.Fatalf("got %s, want %s", got, want)
	}
	_, token := c.join(t, "Lan")
	board := boardOf(t, c.board(token))
	if len(board.Top) != 0 || board.PlayerCount != 1 || board.You == nil || board.You.Rank != nil || board.You.Name != "Lan" {
		t.Fatalf("board %+v", board)
	}
}

func TestSharedLeaderboardIgnoresABadToken(t *testing.T) {
	c := newClassroom(t, nil)
	tokens, _ := classOf(t, c, "S1", "S2")
	other := decode[assignmentView](t, c.teacher(http.MethodPost, "/api/assignments", createBody(nil)))

	for name, opts := range map[string][]reqOpt{
		"unknown token":          {header("X-Player-Token", "garbage")},
		"empty token":            {header("X-Player-Token", "")},
		"the stored hash":        {header("X-Player-Token", hashPlayerToken(tokens["S1"]))},
		"token and bad auth":     {header("X-Player-Token", "garbage"), header("Authorization", "Bearer garbage")},
		"a good token, bad auth": {header("X-Player-Token", tokens["S1"]), header("Authorization", "Bearer garbage")},
	} {
		rec := c.send(http.MethodGet, "/api/share/"+c.a.Code+"/leaderboard", "", opts...)
		board := boardOf(t, rec)
		wantYou := name == "a good token, bad auth"
		if (board.You != nil) != wantYou || len(board.Top) != 2 {
			t.Errorf("%s: %+v", name, board)
		}
	}

	// A token of another assignment is not a student of this one.
	rec := c.send(http.MethodGet, "/api/share/"+other.Code+"/leaderboard", "", header("X-Player-Token", tokens["S1"]))
	if board := boardOf(t, rec); board.You != nil || len(board.Top) != 0 {
		t.Fatalf("another assignment's token: %+v", board)
	}
}

func TestSharedLeaderboardAnswersWhileClosed(t *testing.T) {
	c := newClassroom(t, nil)
	tokens, _ := classOf(t, c, "S1", "S2", "S3")
	wantStatus(t, c.patch(`{"closed":true}`), http.StatusOK)
	wantError(t, c.shareGet(), http.StatusGone, "Assignment closed")

	// The final board is still there for the closed card, long after the results stopped being taken.
	for _, wait := range []time.Duration{0, 4 * time.Minute, 2 * time.Hour} {
		c.clock.Advance(wait)
		board := boardOf(t, c.board(tokens["S2"]))
		if got, want := boardNames(board), []string{"S1", "S2", "S3"}; !slices.Equal(got, want) {
			t.Fatalf("names %v, want %v", got, want)
		}
		if board.You == nil || *board.You.Rank != 2 || !board.Top[1].You {
			t.Fatalf("you %+v", board.You)
		}
	}
	wantError(t, c.startRun(tokens["S2"], 2), http.StatusGone, "Assignment closed")
}

func TestSharedLeaderboardHidden(t *testing.T) {
	c := newClassroom(t, map[string]any{"showBoard": false})
	tokens, _ := classOf(t, c, "S1", "S2")

	// A 404, not an empty board and never a 401 or 403, whoever asks and whatever they send.
	wantHidden := func(name string, rec *httptest.ResponseRecorder) {
		t.Helper()
		if rec.Code != http.StatusNotFound || rec.Body.String() != "Board hidden" {
			t.Errorf("%s: got %d %q, want 404 \"Board hidden\"", name, rec.Code, rec.Body)
		}
		if got := rec.Header().Get("Cache-Control"); got != "no-store" {
			t.Errorf("%s: the answer is cacheable: %q", name, got)
		}
	}
	wantHidden("no token", c.board(""))
	wantHidden("a player's token", c.board(tokens["S1"]))
	wantHidden("an unknown token", c.board("garbage"))
	wantHidden("bad auth", c.send(http.MethodGet, "/api/share/"+c.a.Code+"/leaderboard", "", header("Authorization", "Bearer garbage")))
	wantHidden("a token and bad auth", c.send(http.MethodGet, "/api/share/"+c.a.Code+"/leaderboard", "",
		header("X-Player-Token", tokens["S1"]), header("Authorization", "Bearer garbage")))

	// An unknown code is still told apart from a hidden board.
	wantError(t, c.send(http.MethodGet, "/api/share/ZZZZZZZZZZ/leaderboard", ""), http.StatusNotFound, "Assignment not found")

	// Everything else of the students' side works as before.
	_, token := c.join(t, "S3")
	c.clock.Advance(time.Minute)
	c.finish(t, token, 1, 5)
	wantStatus(t, c.shareGet(), http.StatusOK)

	// The teacher still sees the players ranked.
	var order []string
	for _, p := range c.detail(t).Players {
		order = append(order, fmt.Sprintf("%s:%d", p.Name, entryRank(p)))
	}
	if want := []string{"S1:1", "S2:2", "S3:3"}; !slices.Equal(order, want) {
		t.Fatalf("order %v, want %v", order, want)
	}

	// Closing the assignment does not bring the board back.
	wantStatus(t, c.patch(`{"closed":true}`), http.StatusOK)
	wantError(t, c.shareGet(), http.StatusGone, "Assignment closed")
	c.clock.Advance(2 * time.Hour)
	wantHidden("closed", c.board(tokens["S2"]))
}

func TestSharedLeaderboardAnswersNoStoreWhateverTheStatus(t *testing.T) {
	c := newClassroom(t, nil)
	rec := c.send(http.MethodGet, "/api/share/ZZZZZZZZZZ/leaderboard", "")
	wantError(t, rec, http.StatusNotFound, "Assignment not found")
	if got := rec.Header().Get("Cache-Control"); got != "no-store" {
		t.Errorf("the 404 is cacheable: %q", got)
	}
	// The code is trimmed and upper-cased, nothing else.
	wantStatus(t, c.send(http.MethodGet, "/api/share/%20"+strings.ToLower(c.a.Code)+"%20/leaderboard", ""), http.StatusOK)
	wantError(t, c.send(http.MethodGet, "/api/share/"+c.a.Code[:9]+"/leaderboard", ""), http.StatusNotFound, "Assignment not found")
}

func TestSharedLeaderboardJSONShape(t *testing.T) {
	c := newClassroom(t, nil)
	tokens, ids := classOf(t, c, "S1", "S2", "S3", "S4", "S5", "S6")
	_, idleToken := c.join(t, "Idle")

	for name, token := range map[string]string{"no token": "", "inside the top": tokens["S2"], "outside": tokens["S6"], "unranked": idleToken} {
		rec := c.board(token)
		wantStatus(t, rec, http.StatusOK)
		for _, id := range ids {
			if strings.Contains(rec.Body.String(), id) {
				t.Errorf("%s: the player id %s is in %s", name, id, rec.Body)
			}
		}
		board := decode[map[string]any](t, rec)
		if got, want := keysOf(board), []string{"playerCount", "possible", "stageCount", "top", "you"}; !slices.Equal(got, want) {
			t.Fatalf("%s: keys %v, want %v", name, got, want)
		}
		top, ok := board["top"].([]any)
		if !ok || len(top) != 5 {
			t.Fatalf("%s: top %v", name, board["top"])
		}
		for _, row := range top {
			if got, want := keysOf(row.(map[string]any)), []string{"avatar", "correct", "name", "rank", "stagesPassed", "you"}; !slices.Equal(got, want) {
				t.Fatalf("%s: row keys %v, want %v", name, got, want)
			}
		}
		if token == "" {
			if board["you"] != nil {
				t.Fatalf("%s: you is %v, want null", name, board["you"])
			}
			continue
		}
		you, ok := board["you"].(map[string]any)
		if !ok {
			t.Fatalf("%s: you is %v, want an object", name, board["you"])
		}
		if got, want := keysOf(you), []string{"avatar", "correct", "name", "rank", "stagesPassed"}; !slices.Equal(got, want) {
			t.Fatalf("%s: you keys %v, want %v", name, got, want)
		}
		if name == "unranked" && you["rank"] != nil {
			t.Errorf("an unranked reader has rank %v", you["rank"])
		}
	}
}
