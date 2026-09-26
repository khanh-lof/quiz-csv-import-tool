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

type testEnv struct {
	srv   *Server
	h     http.Handler
	users *store.Memory
	gen   *fakeGenerator
}

func newEnv(t *testing.T) *testEnv {
	t.Helper()
	users := store.NewMemory()
	jwt := auth.NewJWT([]byte("0123456789abcdef0123456789abcdef"), "", "", 15*time.Minute)
	gen := &fakeGenerator{}
	srv := &Server{
		Users:           users,
		Auth:            auth.NewService(users, jwt, 30*24*time.Hour, 5),
		JWT:             jwt,
		Generator:       gen,
		AdminAPIKey:     "admin-key",
		RefreshTokenTTL: 30 * 24 * time.Hour,
		AICallsPerRound: 2,
		RoundDuration:   time.Minute,
		Logger:          slog.New(slog.DiscardHandler),
	}
	env := &testEnv{srv: srv, h: srv.Handler(), users: users, gen: gen}
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
	req := httptest.NewRequest(http.MethodPost, "/api/csv/generate-from-image"+u.query, reader)
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

func TestGenerateCSVFormattedMode(t *testing.T) {
	env := newEnv(t)
	token, _ := env.login(t, "alice", "pw")

	rec := env.upload(t, upload{token: token, files: 2})
	if rec.Code != http.StatusOK || rec.Body.String() != "a,b" || rec.Header().Get("Content-Type") != "text/csv; charset=utf-8" {
		t.Fatalf("generate: %d %q %v", rec.Code, rec.Body, rec.Header())
	}
	if len(env.gen.images) != 2 || env.gen.creative || env.gen.images[0].ContentType != "application/octet-stream" ||
		string(env.gen.images[0].Data) != "png-bytes" {
		t.Fatalf("generator got %+v", env.gen)
	}
}

func TestGenerateCSVCreativeModeWithoutImages(t *testing.T) {
	env := newEnv(t)
	token, _ := env.login(t, "alice", "pw")

	rec := env.upload(t, upload{token: token, query: "?isCreative=True&exportType=1&courseType=2&courseName=Boya&lessonNumber=3"})
	if rec.Code != http.StatusOK {
		t.Fatalf("generate: %d %q", rec.Code, rec.Body)
	}
	if !env.gen.creative || len(env.gen.images) != 0 || env.gen.opts.ExportType != csvgen.Blooket ||
		env.gen.opts.CourseName != "Boya" || *env.gen.opts.LessonNumber != 3 {
		t.Fatalf("generator got %+v", env.gen)
	}
}

func TestGenerateCSVRequestErrors(t *testing.T) {
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

func TestGenerateCSVRateLimit(t *testing.T) {
	env := newEnv(t)
	token, _ := env.login(t, "alice", "pw")
	now := time.Now()
	env.users.Now = func() time.Time { return now }

	for i := range 2 {
		if rec := env.upload(t, upload{token: token, files: 1}); rec.Code != http.StatusOK {
			t.Fatalf("call %d: %d", i+1, rec.Code)
		}
	}
	rec := env.upload(t, upload{token: token, files: 1})
	if rec.Code != http.StatusForbidden || rec.Body.String() != "You have reached the limit for AI calls." {
		t.Fatalf("third call: %d %q", rec.Code, rec.Body)
	}

	now = now.Add(61 * time.Second)
	if rec := env.upload(t, upload{token: token, files: 1}); rec.Code != http.StatusOK {
		t.Fatalf("call in the next round: %d", rec.Code)
	}
}

func TestGenerateCSVUpstreamFailure(t *testing.T) {
	env := newEnv(t)
	token, _ := env.login(t, "alice", "pw")
	env.gen.err = errors.New("boom")
	if rec := env.upload(t, upload{token: token, files: 1}); rec.Code != http.StatusBadGateway {
		t.Fatalf("got %d", rec.Code)
	}

	env.srv.Generator = nil
	if rec := env.upload(t, upload{token: token, files: 1}); rec.Code != http.StatusInternalServerError {
		t.Fatalf("unconfigured generator: %d", rec.Code)
	}
}

func TestGenerateCSVFailureDoesNotUseQuota(t *testing.T) {
	env := newEnv(t)
	token, _ := env.login(t, "alice", "pw")
	now := time.Now()
	env.users.Now = func() time.Time { return now }

	env.gen.err = errors.New("boom")
	for i := range 3 {
		if rec := env.upload(t, upload{token: token, files: 1}); rec.Code != http.StatusBadGateway {
			t.Fatalf("failing call %d: %d", i+1, rec.Code)
		}
	}
	env.gen.err = nil
	for i := range 2 {
		if rec := env.upload(t, upload{token: token, files: 1}); rec.Code != http.StatusOK {
			t.Fatalf("retry %d after failures: %d %q", i+1, rec.Code, rec.Body)
		}
	}
}

func TestGenerateCSVTimeout(t *testing.T) {
	env := newEnv(t)
	token, _ := env.login(t, "alice", "pw")
	env.gen.block = true
	env.srv.LLMTimeout = 10 * time.Millisecond
	rec := env.upload(t, upload{token: token, files: 1})
	if rec.Code != http.StatusGatewayTimeout || rec.Body.String() != "AI generation timed out." {
		t.Fatalf("got %d %q", rec.Code, rec.Body.String())
	}
}
