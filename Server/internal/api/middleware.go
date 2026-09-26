package api

import (
	"crypto/subtle"
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"quiz-csv-import-tool/server/internal/auth"
)

// authenticate validates the Bearer access token and stores its claims in the request context
// (read them back with auth.FromContext). Requests without a valid token get 401.
func (s *Server) authenticate(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token, ok := bearerToken(r)
		if !ok {
			w.Header().Set("WWW-Authenticate", "Bearer")
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		claims, err := s.JWT.Parse(token)
		if err != nil {
			level := slog.LevelWarn
			if errors.Is(err, auth.ErrTokenExpired) {
				level = slog.LevelDebug // routine: the client refreshes and retries
			}
			s.Logger.Log(r.Context(), level, "JWT validation failed", "path", r.URL.Path, "error", err)
			w.Header().Set("WWW-Authenticate", `Bearer error="invalid_token"`)
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r.WithContext(auth.NewContext(r.Context(), claims)))
	})
}

// requireRole lets a request through only if the token carries one of roles, answering 403
// otherwise. It must run inside authenticate.
func requireRole(roles ...string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			claims, ok := auth.FromContext(r.Context())
			if !ok {
				// A routing mistake, not a client error: fail closed.
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			if !claims.HasAnyRole(roles...) {
				w.WriteHeader(http.StatusForbidden)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// requireAdminKey guards admin-only endpoints with the X-Admin-Key header. An unset ADMIN_API_KEY
// rejects every request.
func (s *Server) requireAdminKey(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		key := r.Header.Get("X-Admin-Key")
		if s.AdminAPIKey == "" || subtle.ConstantTimeCompare([]byte(key), []byte(s.AdminAPIKey)) != 1 {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func bearerToken(r *http.Request) (string, bool) {
	scheme, token, found := strings.Cut(strings.TrimSpace(r.Header.Get("Authorization")), " ")
	token = strings.TrimSpace(token)
	if !found || !strings.EqualFold(scheme, "Bearer") || token == "" {
		return "", false
	}
	return token, true
}
