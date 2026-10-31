package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"quiz-csv-import-tool/server/internal/auth"
	"quiz-csv-import-tool/server/internal/csvgen"
	"quiz-csv-import-tool/server/internal/store"
)

type fakeGenerator struct {
	calls    int
	images   []csvgen.Image
	creative bool
	opts     csvgen.Options
	err      error
	// block makes Generate wait for the context to end, like a stalled LLM call.
	block bool
}

func (g *fakeGenerator) Generate(ctx context.Context, images []csvgen.Image, creative bool, opts csvgen.Options) (string, error) {
	g.calls++
	g.images, g.creative, g.opts = images, creative, opts
	if g.block {
		<-ctx.Done()
		return "", ctx.Err()
	}
	return "a,b", g.err
}

// testClockStart is where newEnv's clock begins; tests build closing times from it.
var testClockStart = time.Date(2026, time.October, 14, 9, 0, 0, 0, time.UTC)

// testClock is the clock the assignment handlers read in tests: it stands still until a test moves it.
type testClock struct{ now time.Time }

func (c *testClock) Now() time.Time          { return c.now }
func (c *testClock) Advance(d time.Duration) { c.now = c.now.Add(d) }

type testEnv struct {
	srv         *Server
	h           http.Handler
	users       *store.Memory
	jobs        *store.MemoryJobs
	assignments *store.MemoryAssignments
	clock       *testClock
	gen         *fakeGenerator
}

func newEnv(t *testing.T) *testEnv {
	t.Helper()
	users := store.NewMemory()
	jobs := store.NewMemoryJobs()
	assignments := store.NewMemoryAssignments()
	clock := &testClock{now: testClockStart}
	jwt := auth.NewJWT([]byte("0123456789abcdef0123456789abcdef"), "quiztool", "quiztool-api", 15*time.Minute)
	gen := &fakeGenerator{}
	srv := &Server{
		Users:           users,
		Jobs:            jobs,
		Assignments:     assignments,
		Now:             clock.Now,
		Auth:            auth.NewService(users, jwt, 30*24*time.Hour, 5),
		JWT:             jwt,
		Generator:       gen,
		AdminAPIKey:     "admin-key",
		RefreshTokenTTL: 30 * 24 * time.Hour,
		AICallsPerRound: 2,
		RoundDuration:   time.Minute,
		Logger:          slog.New(slog.DiscardHandler),
	}
	env := &testEnv{srv: srv, h: srv.Handler(), users: users, jobs: jobs, assignments: assignments, clock: clock, gen: gen}
	env.createUser(t, "alice", "pw", []string{"User"})
	return env
}

func (e *testEnv) do(req *http.Request) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	e.h.ServeHTTP(rec, req)
	return rec
}

func (e *testEnv) createUser(t *testing.T, username, password string, roles []string) {
	t.Helper()
	body, _ := json.Marshal(map[string]any{"username": username, "password": password, "roles": roles})
	req := httptest.NewRequest(http.MethodPost, "/api/users", bytes.NewReader(body))
	req.Header.Set("X-Admin-Key", "admin-key")
	if rec := e.do(req); rec.Code != http.StatusCreated {
		t.Fatalf("create user: %d %s", rec.Code, rec.Body)
	}
}

func (e *testEnv) login(t *testing.T, username, password string) (string, *http.Cookie) {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/auth/login",
		strings.NewReader(`{"Username":"`+username+`","PASSWORD":"`+password+`"}`))
	rec := e.do(req)
	if rec.Code != http.StatusOK {
		t.Fatalf("login: %d %s", rec.Code, rec.Body)
	}
	var body struct{ AccessToken string }
	_ = json.NewDecoder(rec.Body).Decode(&body)
	return body.AccessToken, refreshCookie(t, rec)
}

func refreshCookie(t *testing.T, rec *httptest.ResponseRecorder) *http.Cookie {
	t.Helper()
	for _, c := range rec.Result().Cookies() {
		if c.Name == "refreshToken" {
			return c
		}
	}
	t.Fatal("no refreshToken cookie set")
	return nil
}

func TestLoginSetsRefreshCookie(t *testing.T) {
	env := newEnv(t)
	req := httptest.NewRequest(http.MethodPost, "/api/auth/login", strings.NewReader(`{"username":"alice","password":"pw"}`))
	rec := env.do(req)
	if rec.Code != http.StatusOK || rec.Header().Get("Content-Type") != "application/json" {
		t.Fatalf("login: %d %v", rec.Code, rec.Header())
	}
	var body map[string]string
	_ = json.NewDecoder(rec.Body).Decode(&body)
	if body["accessToken"] == "" || len(body) != 1 {
		t.Fatalf("unexpected body %v", body)
	}
	setCookie := rec.Header().Get("Set-Cookie")
	for _, attr := range []string{"refreshToken=", "Path=/", "Max-Age=2592000", "HttpOnly", "Secure", "SameSite=Strict"} {
		if !strings.Contains(setCookie, attr) {
			t.Errorf("Set-Cookie %q lacks %q", setCookie, attr)
		}
	}
}

func TestLoginErrors(t *testing.T) {
	env := newEnv(t)
	tests := []struct {
		body       string
		wantStatus int
		wantBody   string
	}{
		{"", http.StatusBadRequest, "Missing body"},
		{"   ", http.StatusBadRequest, "Missing body"},
		{"not json", http.StatusBadRequest, "Invalid payload"},
		{`{"username":"alice"}`, http.StatusBadRequest, "Invalid payload"},
		{`{"username":123,"password":"pw"}`, http.StatusBadRequest, "Invalid payload"},
		{`{"username":"alice","password":"nope"}`, http.StatusUnauthorized, "Invalid credentials"},
		{`{"username":"nobody","password":"pw"}`, http.StatusUnauthorized, "Invalid credentials"},
	}
	for _, tt := range tests {
		rec := env.do(httptest.NewRequest(http.MethodPost, "/api/auth/login", strings.NewReader(tt.body)))
		if rec.Code != tt.wantStatus || rec.Body.String() != tt.wantBody {
			t.Errorf("body %q: got %d %q, want %d %q", tt.body, rec.Code, rec.Body, tt.wantStatus, tt.wantBody)
		}
	}
}

func TestRefreshRotatesCookie(t *testing.T) {
	env := newEnv(t)
	_, cookie := env.login(t, "alice", "pw")

	req := httptest.NewRequest(http.MethodPost, "/api/auth/refresh", strings.NewReader("{}"))
	req.AddCookie(cookie)
	rec := env.do(req)
	if rec.Code != http.StatusOK {
		t.Fatalf("refresh: %d %s", rec.Code, rec.Body)
	}
	if rotated := refreshCookie(t, rec); rotated.Value == cookie.Value {
		t.Fatal("refresh token was not rotated")
	}

	// The old token is spent.
	req = httptest.NewRequest(http.MethodPost, "/api/auth/refresh", nil)
	req.AddCookie(cookie)
	if rec := env.do(req); rec.Code != http.StatusUnauthorized || rec.Body.String() != "Invalid refresh token" {
		t.Fatalf("reused token: %d %q", rec.Code, rec.Body)
	}
	if rec := env.do(httptest.NewRequest(http.MethodPost, "/api/auth/refresh", nil)); rec.Code != http.StatusUnauthorized ||
		rec.Body.String() != "Missing refresh token" {
		t.Fatalf("no cookie: %d %q", rec.Code, rec.Body)
	}
}

func TestLogoutEndpoints(t *testing.T) {
	env := newEnv(t)
	_, phone := env.login(t, "alice", "pw")
	_, laptop := env.login(t, "alice", "pw")

	req := httptest.NewRequest(http.MethodPost, "/api/auth/logout", nil)
	req.AddCookie(phone)
	rec := env.do(req)
	if rec.Code != http.StatusOK || refreshCookie(t, rec).MaxAge != -1 {
		t.Fatalf("logout: %d, cookie not cleared", rec.Code)
	}
	if rec := env.do(httptest.NewRequest(http.MethodPost, "/api/auth/logout", nil)); rec.Code != http.StatusOK {
		t.Fatalf("logout without cookie: %d", rec.Code)
	}

	if rec := env.do(httptest.NewRequest(http.MethodPost, "/api/auth/logout-all", nil)); rec.Code != http.StatusBadRequest {
		t.Fatalf("logout-all without cookie: %d", rec.Code)
	}
	req = httptest.NewRequest(http.MethodPost, "/api/auth/logout-all", nil)
	req.AddCookie(laptop)
	if rec := env.do(req); rec.Code != http.StatusOK {
		t.Fatalf("logout-all: %d", rec.Code)
	}
	req = httptest.NewRequest(http.MethodPost, "/api/auth/logout-all", nil)
	req.AddCookie(laptop)
	if rec := env.do(req); rec.Code != http.StatusBadRequest {
		t.Fatalf("logout-all with revoked token: %d", rec.Code)
	}
}

func TestCreateUserRequiresAdminKey(t *testing.T) {
	env := newEnv(t)
	body := `{"username":"bob","password":"pw"}`
	for _, key := range []string{"", "wrong"} {
		req := httptest.NewRequest(http.MethodPost, "/api/users", strings.NewReader(body))
		req.Header.Set("X-Admin-Key", key)
		if rec := env.do(req); rec.Code != http.StatusUnauthorized {
			t.Fatalf("key %q: %d", key, rec.Code)
		}
	}

	env.srv.AdminAPIKey = ""
	req := httptest.NewRequest(http.MethodPost, "/api/users", strings.NewReader(body))
	if rec := env.do(req); rec.Code != http.StatusUnauthorized {
		t.Fatalf("unset admin key must reject: %d", rec.Code)
	}
	env.srv.AdminAPIKey = "admin-key"

	req = httptest.NewRequest(http.MethodPost, "/api/users", strings.NewReader(`{"username":"alice","password":"x"}`))
	req.Header.Set("X-Admin-Key", "admin-key")
	if rec := env.do(req); rec.Code != http.StatusConflict || rec.Body.String() != "User already exists" {
		t.Fatalf("duplicate: %d %q", rec.Code, rec.Body)
	}

	req = httptest.NewRequest(http.MethodPost, "/api/users", strings.NewReader(body))
	req.Header.Set("X-Admin-Key", "admin-key")
	rec := env.do(req)
	if rec.Code != http.StatusCreated || strings.TrimSpace(rec.Body.String()) != `{"username":"bob"}` {
		t.Fatalf("create: %d %q", rec.Code, rec.Body)
	}
	if u, _ := env.users.FindByUsername(context.Background(), "bob"); u == nil || u.Roles == nil || len(u.Roles) != 0 {
		t.Fatalf("stored user %+v", u)
	}
}

type upload struct {
	query   string
	token   string
	files   int
	rawBody *string // overrides the multipart body when set
	ctype   *string
}

func (e *testEnv) upload(t *testing.T, u upload) *httptest.ResponseRecorder {
	t.Helper()
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	_ = mw.WriteField("note", "not a file")
	for range u.files {
		fw, _ := mw.CreateFormFile("images", "lesson.png")
		_, _ = fw.Write([]byte("png-bytes"))
	}
	_ = mw.Close()
	var reader io.Reader = &body
	if u.rawBody != nil {
		reader = strings.NewReader(*u.rawBody)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/csv/jobs"+u.query, reader)
	if u.token != "" {
		req.Header.Set("Authorization", "Bearer "+u.token)
	}
	if u.ctype != nil {
		req.Header.Set("Content-Type", *u.ctype)
	} else {
		req.Header.Set("Content-Type", mw.FormDataContentType())
	}
	return e.do(req)
}

func ptr[T any](v T) *T { return &v }

// onlyJob is the single job a user has; the handler has finished its work by the time a test sees
// the response, so the job is already done or failed.
func (e *testEnv) onlyJob(t *testing.T, username string) store.Job {
	t.Helper()
	jobs, err := e.jobs.List(context.Background(), username, 100)
	if err != nil || len(jobs) != 1 {
		t.Fatalf("jobs of %s: %v, %v", username, jobs, err)
	}
	return jobs[0]
}

func TestCreateJobFormattedMode(t *testing.T) {
	env := newEnv(t)
	token, _ := env.login(t, "alice", "pw")

	rec := env.upload(t, upload{token: token, files: 2, query: "?title=Anh%20bai%201"})
	job := env.onlyJob(t, "alice")
	if rec.Code != http.StatusAccepted || rec.Header().Get("Content-Type") != "application/json" ||
		rec.Header().Get("Connection") != "close" || strings.TrimSpace(rec.Body.String()) != `{"id":"`+job.ID+`"}` {
		t.Fatalf("create: %d %q %v", rec.Code, rec.Body, rec.Header())
	}
	if job.Status != store.JobDone || job.CSV != "a,b" || job.Title != "Anh bai 1" || job.Creative || job.ImageCount != 2 ||
		job.ExportType != nil {
		t.Fatalf("job %+v", job)
	}
	if len(env.gen.images) != 2 || env.gen.creative || env.gen.images[0].ContentType != "application/octet-stream" ||
		string(env.gen.images[0].Data) != "png-bytes" {
		t.Fatalf("generator got %+v", env.gen)
	}
}

func TestCreateJobCreativeModeWithoutImages(t *testing.T) {
	env := newEnv(t)
	token, _ := env.login(t, "alice", "pw")

	// The single lessonNumber of a page from before several lessons could be chosen is read as a list of one.
	rec := env.upload(t, upload{token: token, query: "?isCreative=True&exportType=1&courseType=2&courseName=Boya&lessonNumbers=3"})
	if rec.Code != http.StatusAccepted {
		t.Fatalf("create: %d %q", rec.Code, rec.Body)
	}
	if !env.gen.creative || len(env.gen.images) != 0 || env.gen.opts.ExportType != csvgen.Blooket ||
		env.gen.opts.CourseName != "Boya" || !slices.Equal(env.gen.opts.LessonNumbers, []int{3}) {
		t.Fatalf("generator got %+v", env.gen)
	}
	job := env.onlyJob(t, "alice")
	if !job.Creative || job.ExportType == nil || *job.ExportType != int(csvgen.Blooket) || job.Title != "AI tự nghĩ câu hỏi" ||
		job.Intelligence != csvgen.DefaultIntelligence {
		t.Fatalf("job %+v", job)
	}
	if job.CourseType == nil || *job.CourseType != int(csvgen.Other) || job.CourseName != "Boya" ||
		job.HskStandard != nil || job.Level != nil || !slices.Equal(job.LessonNumbers, []int{3}) {
		t.Fatalf("job lesson %+v", job)
	}
}

func TestCreateJobStoresHskLesson(t *testing.T) {
	env := newEnv(t)
	token, _ := env.login(t, "alice", "pw")

	rec := env.upload(t, upload{token: token, query: "?isCreative=true&exportType=2&courseType=0&hskStandard=3&level=7&lessonNumbers=5,4"})
	if rec.Code != http.StatusAccepted {
		t.Fatalf("create: %d %q", rec.Code, rec.Body)
	}
	if !slices.Equal(env.gen.opts.LessonNumbers, []int{4, 5}) {
		t.Fatalf("generator got %+v", env.gen.opts)
	}
	// The lessons are stored ascending, in the new field alone: the one the old jobs used is never written.
	job := env.onlyJob(t, "alice")
	if job.CourseType == nil || *job.CourseType != int(csvgen.Hsk) || job.HskStandard == nil || *job.HskStandard != 3 ||
		job.Level == nil || *job.Level != 7 || !slices.Equal(job.LessonNumbers, []int{4, 5}) ||
		job.CourseName != "" {
		t.Fatalf("job %+v", job)
	}
}

func TestCreateJobStoresGestureQuizChoice(t *testing.T) {
	env := newEnv(t)
	env.srv.AICallsPerRound = 3
	token, _ := env.login(t, "alice", "pw")

	const lesson = "?isCreative=true&courseType=0&level=1&lessonNumbers=2"
	for _, query := range []string{
		lesson + "&exportType=3&gestureStages=6,4&questionsPerStage=7",
		lesson + "&exportType=3",
		// The choice belongs to the Game alone: another platform keeps none, even when it is sent.
		lesson + "&exportType=0&gestureStages=1",
	} {
		if rec := env.upload(t, upload{token: token, query: query}); rec.Code != http.StatusAccepted {
			t.Fatalf("create %s: %d %q", query, rec.Code, rec.Body)
		}
		time.Sleep(2 * time.Millisecond) // createdAt has millisecond resolution
	}

	type choice struct {
		stages   []int
		perStage *int
	}
	want := []choice{
		{nil, nil},
		{csvgen.AllGestureStages(), ptr(csvgen.DefaultQuestionsPerStage)},
		{[]int{4, 6}, ptr(7)},
	}
	stored, _ := env.jobs.List(context.Background(), "alice", 100)
	for i, w := range want {
		job := stored[i]
		if !slices.Equal(job.GestureStages, w.stages) || (job.QuestionsPerStage == nil) != (w.perStage == nil) ||
			(job.QuestionsPerStage != nil && *job.QuestionsPerStage != *w.perStage) {
			t.Errorf("job %d: %+v", i, job)
		}
	}
}

func TestCreateJobTitleIsCapped(t *testing.T) {
	if got := jobTitle(strings.Repeat("好", 300), true); len([]rune(got)) != maxTitleRunes {
		t.Fatalf("title has %d runes", len([]rune(got)))
	}
}

func TestCreateJobRequestErrors(t *testing.T) {
	env := newEnv(t)
	token, _ := env.login(t, "alice", "pw")
	env.createUser(t, "guest", "pw", []string{"Guest"})
	guestToken, _ := env.login(t, "guest", "pw")
	ghostToken, _ := env.srv.JWT.Issue("ghost", []string{"User"})

	tests := []struct {
		name       string
		upload     upload
		wantStatus int
		wantBody   string
	}{
		{"no token", upload{files: 1}, http.StatusUnauthorized, ""},
		{"bad token", upload{token: "garbage", files: 1}, http.StatusUnauthorized, ""},
		{"unknown user", upload{token: ghostToken, files: 1}, http.StatusNotFound, "User not found"},
		{"missing role", upload{token: guestToken, files: 1}, http.StatusForbidden, ""},
		{"no content type", upload{token: token, ctype: ptr("")}, http.StatusBadRequest, "Missing Content-Type header"},
		{"not multipart", upload{token: token, ctype: ptr("application/json")}, http.StatusBadRequest, "Expected multipart/form-data"},
		{"no boundary", upload{token: token, ctype: ptr("multipart/form-data")}, http.StatusBadRequest, "Missing multipart boundary"},
		{"empty body", upload{token: token, ctype: ptr("multipart/form-data; boundary=xyz"), rawBody: ptr("")}, http.StatusBadRequest, "Malformed multipart body."},
		{"truncated", upload{token: token, ctype: ptr("multipart/form-data; boundary=xyz"), rawBody: ptr("--xyz\r\nContent-Disposition: form-data; name=\"images\"; filename=\"a.png\"\r\n\r\nabc")}, http.StatusBadRequest, "Malformed multipart body."},
		{"no image", upload{token: token}, http.StatusBadRequest, "Image is required."},
		{"bad creative options", upload{token: token, query: "?isCreative=true&exportType=9"}, http.StatusBadRequest, "Invalid or missing exportType parameter."},
		{"bad gesture stages", upload{token: token, query: "?isCreative=true&exportType=3&courseType=0&level=1&lessonNumbers=1&gestureStages=7"}, http.StatusBadRequest, "Invalid gestureStages parameter."},
		{"bad questions per stage", upload{token: token, query: "?isCreative=true&exportType=3&courseType=0&level=1&lessonNumbers=1&questionsPerStage=11"}, http.StatusBadRequest, "Invalid questionsPerStage parameter."},
		{"no lessons", upload{token: token, query: "?isCreative=true&exportType=0&courseType=0&level=1"}, http.StatusBadRequest, "Invalid or missing lessonNumbers parameter."},
		{"repeated lesson", upload{token: token, query: "?isCreative=true&exportType=0&courseType=0&level=1&lessonNumbers=2,2"}, http.StatusBadRequest, "Invalid or missing lessonNumbers parameter."},
		{"empty lesson", upload{token: token, query: "?isCreative=true&exportType=0&courseType=0&level=1&lessonNumbers=2,,3"}, http.StatusBadRequest, "Invalid or missing lessonNumbers parameter."},
		{"too many lessons", upload{token: token, query: "?isCreative=true&exportType=0&courseType=0&level=1&lessonNumbers=1,2,3,4,5,6"}, http.StatusBadRequest, "At most 5 lessons per quiz."},
		{"lesson beyond the book", upload{token: token, query: "?isCreative=true&exportType=0&courseType=0&hskStandard=3&level=2&lessonNumbers=3,16"}, http.StatusBadRequest, "Lesson must be 1 to 15 for 《新HSK教程2》."},
	}
	for _, tt := range tests {
		rec := env.upload(t, tt.upload)
		if rec.Code != tt.wantStatus || rec.Body.String() != tt.wantBody {
			t.Errorf("%s: got %d %q, want %d %q", tt.name, rec.Code, rec.Body, tt.wantStatus, tt.wantBody)
		}
	}
	if env.gen.calls != 0 {
		t.Fatalf("generator called %d times for rejected requests", env.gen.calls)
	}
}

func TestCreateJobRateLimit(t *testing.T) {
	env := newEnv(t)
	token, _ := env.login(t, "alice", "pw")
	now := time.Now()
	env.users.Now = func() time.Time { return now }

	for i := range 2 {
		if rec := env.upload(t, upload{token: token, files: 1}); rec.Code != http.StatusAccepted {
			t.Fatalf("call %d: %d", i+1, rec.Code)
		}
	}
	rec := env.upload(t, upload{token: token, files: 1})
	if rec.Code != http.StatusForbidden || rec.Body.String() != "You have reached the limit for AI calls." {
		t.Fatalf("third call: %d %q", rec.Code, rec.Body)
	}

	now = now.Add(61 * time.Second)
	if rec := env.upload(t, upload{token: token, files: 1}); rec.Code != http.StatusAccepted {
		t.Fatalf("call in the next round: %d", rec.Code)
	}
}

func TestCreateJobUpstreamFailure(t *testing.T) {
	env := newEnv(t)
	token, _ := env.login(t, "alice", "pw")
	env.gen.err = errors.New("boom")
	// The failure is not the request's: it is recorded on the job.
	if rec := env.upload(t, upload{token: token, files: 1}); rec.Code != http.StatusAccepted {
		t.Fatalf("got %d", rec.Code)
	}
	job := env.onlyJob(t, "alice")
	if job.Status != store.JobFailed || job.ErrorStatus != http.StatusBadGateway || job.ErrorMessage != "AI generation failed." || job.CSV != "" {
		t.Fatalf("job %+v", job)
	}

	env.srv.Generator = nil
	if rec := env.upload(t, upload{token: token, files: 1}); rec.Code != http.StatusInternalServerError {
		t.Fatalf("unconfigured generator: %d", rec.Code)
	}
}

func TestCreateJobFailureDoesNotUseQuota(t *testing.T) {
	env := newEnv(t)
	token, _ := env.login(t, "alice", "pw")
	now := time.Now()
	env.users.Now = func() time.Time { return now }

	env.gen.err = errors.New("boom")
	for i := range 3 {
		if rec := env.upload(t, upload{token: token, files: 1}); rec.Code != http.StatusAccepted {
			t.Fatalf("failing call %d: %d", i+1, rec.Code)
		}
	}
	env.gen.err = nil
	for i := range 2 {
		if rec := env.upload(t, upload{token: token, files: 1}); rec.Code != http.StatusAccepted {
			t.Fatalf("retry %d after failures: %d %q", i+1, rec.Code, rec.Body)
		}
	}
}

func TestCreateJobTimeout(t *testing.T) {
	env := newEnv(t)
	token, _ := env.login(t, "alice", "pw")
	env.gen.block = true
	env.srv.LLMTimeout = 10 * time.Millisecond
	if rec := env.upload(t, upload{token: token, files: 1}); rec.Code != http.StatusAccepted {
		t.Fatalf("got %d %q", rec.Code, rec.Body.String())
	}
	job := env.onlyJob(t, "alice")
	if job.Status != store.JobFailed || job.ErrorStatus != http.StatusGatewayTimeout || job.ErrorMessage != "AI generation timed out." {
		t.Fatalf("job %+v", job)
	}
}

// The point of jobs: the model call must finish and be recorded although the client is gone.
func TestCreateJobSurvivesClientDisconnect(t *testing.T) {
	env := newEnv(t)
	token, _ := env.login(t, "alice", "pw")
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // the client left before the handler even started

	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	fw, _ := mw.CreateFormFile("images", "lesson.png")
	_, _ = fw.Write([]byte("png-bytes"))
	_ = mw.Close()
	req := httptest.NewRequest(http.MethodPost, "/api/csv/jobs", &body).WithContext(ctx)
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	env.do(req)

	if job := env.onlyJob(t, "alice"); job.Status != store.JobDone || job.CSV != "a,b" {
		t.Fatalf("job %+v", job)
	}
}

func (e *testEnv) listJobs(t *testing.T, token string) []map[string]any {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/api/csv/jobs", nil)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := e.do(req)
	if rec.Code != http.StatusOK {
		t.Fatalf("list: %d %q", rec.Code, rec.Body)
	}
	var body struct{ Jobs []map[string]any }
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	return body.Jobs
}

func TestListJobsReturnsOnlyOwnJobsNewestFirst(t *testing.T) {
	env := newEnv(t)
	env.createUser(t, "bob", "pw", []string{"User"})
	alice, _ := env.login(t, "alice", "pw")
	bob, _ := env.login(t, "bob", "pw")

	env.upload(t, upload{token: alice, files: 1, query: "?title=first"})
	time.Sleep(2 * time.Millisecond) // createdAt has millisecond resolution
	env.upload(t, upload{token: alice, files: 1, query: "?title=second"})
	env.upload(t, upload{token: bob, files: 1, query: "?title=bobs"})

	jobs := env.listJobs(t, alice)
	if len(jobs) != 2 || jobs[0]["title"] != "second" || jobs[1]["title"] != "first" {
		t.Fatalf("alice's jobs: %v", jobs)
	}
	if jobs[0]["status"] != "done" || jobs[0]["csv"] != "a,b" || jobs[0]["creative"] != false || jobs[0]["imageCount"] != float64(1) {
		t.Fatalf("job view: %v", jobs[0])
	}
	if jobs = env.listJobs(t, bob); len(jobs) != 1 || jobs[0]["title"] != "bobs" {
		t.Fatalf("bob's jobs: %v", jobs)
	}

	if rec := env.do(httptest.NewRequest(http.MethodGet, "/api/csv/jobs", nil)); rec.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous list: %d", rec.Code)
	}
}

func TestCreateJobKeepsOnlyNewestJobs(t *testing.T) {
	env := newEnv(t)
	token, _ := env.login(t, "alice", "pw")
	env.srv.AICallsPerRound = maxJobsPerUser + 5
	for range maxJobsPerUser + 3 {
		env.upload(t, upload{token: token, files: 1})
		time.Sleep(time.Millisecond)
	}
	if jobs := env.listJobs(t, token); len(jobs) != maxJobsPerUser {
		t.Fatalf("kept %d jobs, want %d", len(jobs), maxJobsPerUser)
	}
}

func TestListJobsExpiresAbandonedJobs(t *testing.T) {
	env := newEnv(t)
	token, _ := env.login(t, "alice", "pw")
	now := time.Now()
	env.users.Now = func() time.Time { return now }
	env.srv.LLMTimeout = time.Minute
	env.upload(t, upload{token: token, files: 1}) // consumes one of the two calls in the round
	roundStart := now.UTC()

	// A job whose process died: still running well past the LLM deadline.
	err := env.jobs.Create(context.Background(), &store.Job{
		ID: "stuck", Username: "alice", Status: store.JobRunning, Title: "stuck",
		RoundStart: roundStart, CreatedAt: time.Now().Add(-10 * time.Minute),
	})
	if err != nil {
		t.Fatal(err)
	}
	// A recent one is left alone.
	err = env.jobs.Create(context.Background(), &store.Job{
		ID: "fresh", Username: "alice", Status: store.JobRunning, Title: "fresh", CreatedAt: time.Now(),
	})
	if err != nil {
		t.Fatal(err)
	}

	byTitle := map[string]map[string]any{}
	for _, j := range env.listJobs(t, token) {
		byTitle[j["title"].(string)] = j
	}
	if byTitle["stuck"]["status"] != "failed" || byTitle["stuck"]["errorMessage"] != "AI generation was interrupted." ||
		byTitle["fresh"]["status"] != "running" {
		t.Fatalf("jobs: %v", byTitle)
	}
	// Its call was given back: the round counted the upload above once, and the refund takes it to zero.
	u, _ := env.users.FindByUsername(context.Background(), "alice")
	if u.AICallCountInRound != 0 {
		t.Fatalf("calls counted in the round: %d", u.AICallCountInRound)
	}
}

func TestDeleteJob(t *testing.T) {
	env := newEnv(t)
	env.createUser(t, "bob", "pw", []string{"User"})
	alice, _ := env.login(t, "alice", "pw")
	bob, _ := env.login(t, "bob", "pw")
	env.upload(t, upload{token: alice, files: 1})
	id := env.onlyJob(t, "alice").ID

	del := func(token, id string) int {
		req := httptest.NewRequest(http.MethodDelete, "/api/csv/jobs/"+id, nil)
		req.Header.Set("Authorization", "Bearer "+token)
		return env.do(req).Code
	}
	if got := del(bob, id); got != http.StatusNotFound {
		t.Fatalf("another user's job: %d", got)
	}
	if got := del(alice, id); got != http.StatusNoContent {
		t.Fatalf("own job: %d", got)
	}
	if got := del(alice, id); got != http.StatusNotFound {
		t.Fatalf("deleted job: %d", got)
	}
	if jobs := env.listJobs(t, alice); len(jobs) != 0 {
		t.Fatalf("jobs after delete: %v", jobs)
	}
}

func (e *testEnv) retry(t *testing.T, token, id string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/csv/jobs/"+id+"/retry", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	return e.do(req)
}

func TestRetryJobSendsTheSameRequestAgain(t *testing.T) {
	env := newEnv(t)
	token, _ := env.login(t, "alice", "pw")
	env.gen.err = errors.New("boom")
	env.upload(t, upload{token: token, query: "?title=HSK3-Bai2&isCreative=true&exportType=3&courseType=0&hskStandard=3" +
		"&level=4&lessonNumbers=5,2&intelligence=2&gestureStages=4,6&questionsPerStage=7"})
	failed := env.onlyJob(t, "alice")
	want := env.gen.opts
	// Without images there is nothing to expire.
	if view := env.listJobs(t, token)[0]; view["retryable"] != true || view["retryUntil"] != nil {
		t.Fatalf("failed job: %v", view)
	}

	env.gen.err, env.gen.opts = nil, csvgen.Options{}
	rec := env.retry(t, token, failed.ID)
	job := env.onlyJob(t, "alice")
	if rec.Code != http.StatusAccepted || strings.TrimSpace(rec.Body.String()) != `{"id":"`+job.ID+`"}` || job.ID == failed.ID {
		t.Fatalf("retry: %d %q", rec.Code, rec.Body)
	}
	if job.Status != store.JobDone || job.Title != "HSK3-Bai2" || !job.Creative || *job.HskStandard != 3 || *job.Level != 4 ||
		!slices.Equal(job.LessonNumbers, []int{2, 5}) || job.Intelligence != 2 ||
		!slices.Equal(job.GestureStages, []int{4, 6}) || *job.QuestionsPerStage != 7 {
		t.Fatalf("new job %+v", job)
	}
	if !reflect.DeepEqual(env.gen.opts, want) || !env.gen.creative || len(env.gen.images) != 0 {
		t.Fatalf("generator got %+v, want %+v", env.gen.opts, want)
	}

	if view := env.listJobs(t, token)[0]; view["retryable"] != false {
		t.Fatalf("done job: %v", view)
	}
	if rec := env.retry(t, token, job.ID); rec.Code != http.StatusConflict || rec.Body.String() != "Job has not failed." {
		t.Fatalf("retry of a done job: %d %q", rec.Code, rec.Body)
	}
	if rec := env.retry(t, token, failed.ID); rec.Code != http.StatusNotFound {
		t.Fatalf("retry of the replaced job: %d", rec.Code)
	}
}

func TestListJobsReturnsLessonNumbers(t *testing.T) {
	env := newEnv(t)
	token, _ := env.login(t, "alice", "pw")
	ctx := context.Background()
	_ = env.jobs.Create(ctx, &store.Job{ID: "one", Username: "alice", Status: store.JobDone, Title: "one", Creative: true,
		ExportType: ptr(0), CourseType: ptr(1), Level: ptr(6), LessonNumbers: []int{4}, CreatedAt: testClockStart})
	_ = env.jobs.Create(ctx, &store.Job{ID: "plain", Username: "alice", Status: store.JobDone, Title: "plain",
		CreatedAt: testClockStart.Add(time.Millisecond)})
	_ = env.jobs.Create(ctx, &store.Job{ID: "new", Username: "alice", Status: store.JobDone, Title: "new", Creative: true,
		ExportType: ptr(0), CourseType: ptr(1), Level: ptr(6), LessonNumbers: []int{3, 4, 5}, CreatedAt: testClockStart.Add(2 * time.Millisecond)})

	byTitle := map[string]map[string]any{}
	for _, view := range env.listJobs(t, token) {
		byTitle[view["title"].(string)] = view
	}
	if got := byTitle["new"]["lessonNumbers"]; !reflect.DeepEqual(got, []any{3.0, 4.0, 5.0}) {
		t.Errorf("new job: %v", got)
	}
	if got := byTitle["one"]["lessonNumbers"]; !reflect.DeepEqual(got, []any{4.0}) {
		t.Errorf("one-lesson job: %v", got)
	}
	// A job with no lesson sends null, as the other lesson fields do.
	if got, ok := byTitle["plain"]["lessonNumbers"]; !ok || got != nil {
		t.Errorf("job without a lesson: %v, present %v", got, ok)
	}
}

func TestRetryJobKeepsImagesForAWhile(t *testing.T) {
	env := newEnv(t)
	env.createUser(t, "bob", "pw", []string{"User"})
	token, _ := env.login(t, "alice", "pw")
	bob, _ := env.login(t, "bob", "pw")
	env.gen.err = errors.New("boom")
	env.upload(t, upload{token: token, files: 2, query: "?title=Anh"})
	failed := env.onlyJob(t, "alice")
	if view := env.listJobs(t, token)[0]; view["retryable"] != true ||
		view["retryUntil"] != testClockStart.Add(retryImagesTTL).Format(time.RFC3339Nano) {
		t.Fatalf("failed job: %v", view)
	}
	if rec := env.retry(t, bob, failed.ID); rec.Code != http.StatusNotFound {
		t.Fatalf("another user's job: %d", rec.Code)
	}

	// The retry fails too, and its images are kept again, for the full time from this failure.
	env.clock.Advance(30 * time.Minute)
	env.gen.images = nil
	if rec := env.retry(t, token, failed.ID); rec.Code != http.StatusAccepted {
		t.Fatalf("retry: %d %q", rec.Code, rec.Body)
	}
	retried := env.onlyJob(t, "alice")
	if retried.Creative || retried.ImageCount != 2 || retried.Title != "Anh" || len(env.gen.images) != 2 ||
		string(env.gen.images[1].Data) != "png-bytes" {
		t.Fatalf("retried job %+v, generator got %+v", retried, env.gen.images)
	}

	env.clock.Advance(retryImagesTTL - time.Second)
	if view := env.listJobs(t, token)[0]; view["retryable"] != true {
		t.Fatalf("just before the images expire: %v", view)
	}
	env.clock.Advance(time.Second)
	if view := env.listJobs(t, token)[0]; view["retryable"] != false || view["retryUntil"] != nil {
		t.Fatalf("once the images expired: %v", view)
	}
	if rec := env.retry(t, token, retried.ID); rec.Code != http.StatusGone || rec.Body.String() != "Images expired." {
		t.Fatalf("retry without images: %d %q", rec.Code, rec.Body)
	}
	if env.onlyJob(t, "alice").ID != retried.ID {
		t.Fatal("a refused retry must keep the failed job")
	}
}

func TestRetryJobRefusals(t *testing.T) {
	env := newEnv(t)
	token, _ := env.login(t, "alice", "pw")
	now := time.Now()
	env.users.Now = func() time.Time { return now }

	// From before the server kept the lesson, or the games of a Game: sending it again would ask for another quiz.
	ctx := context.Background()
	_ = env.jobs.Create(ctx, &store.Job{ID: "no-lesson", Username: "alice", Status: store.JobFailed, Creative: true,
		ExportType: ptr(0), CreatedAt: now})
	_ = env.jobs.Create(ctx, &store.Job{ID: "no-games", Username: "alice", Status: store.JobFailed, Creative: true,
		ExportType: ptr(3), CourseType: ptr(1), Level: ptr(6), LessonNumbers: []int{1}, CreatedAt: now.Add(time.Millisecond)})
	for _, view := range env.listJobs(t, token) {
		if view["retryable"] != false {
			t.Fatalf("old job: %v", view)
		}
		if rec := env.retry(t, token, view["id"].(string)); rec.Code != http.StatusConflict || rec.Body.String() != "Job cannot be retried." {
			t.Fatalf("retry of %v: %d %q", view["id"], rec.Code, rec.Body)
		}
	}

	env.gen.err = errors.New("boom")
	env.upload(t, upload{token: token, files: 1})
	jobs, _ := env.jobs.List(ctx, "alice", 100)
	failed := jobs[slices.IndexFunc(jobs, func(j store.Job) bool { return j.ImageCount == 1 })]
	env.gen.err = nil
	for range 2 {
		env.upload(t, upload{token: token, query: "?isCreative=true&exportType=0&courseType=1&level=6&lessonNumbers=1"})
	}
	if rec := env.retry(t, token, failed.ID); rec.Code != http.StatusForbidden {
		t.Fatalf("retry over the rate limit: %d %q", rec.Code, rec.Body)
	}
	if _, err := env.jobs.Get(ctx, "alice", failed.ID); err != nil {
		t.Fatalf("the failed job must stay: %v", err)
	}

	// Deleting the job lets its images go.
	req := httptest.NewRequest(http.MethodDelete, "/api/csv/jobs/"+failed.ID, nil)
	req.Header.Set("Authorization", "Bearer "+token)
	if rec := env.do(req); rec.Code != http.StatusNoContent {
		t.Fatalf("delete: %d", rec.Code)
	}
	if _, _, ok := env.srv.retryImages.get(failed.ID, "alice", env.clock.Now()); ok {
		t.Fatal("images kept after the job was deleted")
	}
}

func TestRefreshTokenReuseRevokesSessions(t *testing.T) {
	env := newEnv(t)
	_, stolen := env.login(t, "alice", "pw")
	_, laptop := env.login(t, "alice", "pw")

	req := httptest.NewRequest(http.MethodPost, "/api/auth/refresh", nil)
	req.AddCookie(stolen)
	if rec := env.do(req); rec.Code != http.StatusOK {
		t.Fatalf("first refresh: %d", rec.Code)
	}
	// Age the spent entry past the grace period instead of sleeping.
	_ = env.users.UpdateSessions(context.Background(), "alice", func(s *store.Sessions) bool {
		s.Spent[0].SpentAt = s.Spent[0].SpentAt.Add(-time.Hour)
		return true
	})

	req = httptest.NewRequest(http.MethodPost, "/api/auth/refresh", nil)
	req.AddCookie(stolen)
	if rec := env.do(req); rec.Code != http.StatusUnauthorized || rec.Body.String() != "Invalid refresh token" {
		t.Fatalf("replayed token: %d %q", rec.Code, rec.Body)
	}
	req = httptest.NewRequest(http.MethodPost, "/api/auth/refresh", nil)
	req.AddCookie(laptop)
	if rec := env.do(req); rec.Code != http.StatusUnauthorized {
		t.Fatalf("other session survived reuse detection: %d", rec.Code)
	}
}
