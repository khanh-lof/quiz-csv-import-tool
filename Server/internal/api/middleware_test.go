package api

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"quiz-csv-import-tool/server/internal/auth"
)

func TestAuthenticateStoresClaimsInContext(t *testing.T) {
	env := newEnv(t)
	token, _ := env.srv.JWT.Issue("alice", []string{auth.RoleAdmin})

	var got *auth.Claims
	h := env.srv.authenticate(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got, _ = auth.FromContext(r.Context())
	}))
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("Authorization", "bearer  "+token)
	h.ServeHTTP(httptest.NewRecorder(), req)
	if got == nil || got.Username() != "alice" || !got.HasAnyRole(auth.RoleAdmin) {
		t.Fatalf("claims in context: %+v", got)
	}
}

func TestAuthenticateRejects(t *testing.T) {
	env := newEnv(t)
	h := env.srv.authenticate(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Fatal("handler reached without a valid token")
	}))
	tests := []struct {
		header, wantChallenge string
	}{
		{"", "Bearer"},
		{"Bearer", "Bearer"},
		{"Basic abc", "Bearer"},
		{"Bearer garbage", `Bearer error="invalid_token"`},
	}
	for _, tt := range tests {
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		req.Header.Set("Authorization", tt.header)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusUnauthorized || rec.Header().Get("WWW-Authenticate") != tt.wantChallenge {
			t.Errorf("%q: got %d %q", tt.header, rec.Code, rec.Header().Get("WWW-Authenticate"))
		}
	}
}

func TestRequireRole(t *testing.T) {
	ok := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })
	h := requireRole(auth.RoleAdmin)(ok)
	tests := []struct {
		name   string
		claims *auth.Claims
		want   int
	}{
		{"no claims (not behind authenticate)", nil, http.StatusUnauthorized},
		{"wrong role", &auth.Claims{Roles: []string{auth.RoleUser}}, http.StatusForbidden},
		{"matching role, any case", &auth.Claims{Roles: []string{"admin"}}, http.StatusNoContent},
	}
	for _, tt := range tests {
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		if tt.claims != nil {
			req = req.WithContext(auth.NewContext(req.Context(), tt.claims))
		}
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != tt.want {
			t.Errorf("%s: got %d, want %d", tt.name, rec.Code, tt.want)
		}
	}
}
