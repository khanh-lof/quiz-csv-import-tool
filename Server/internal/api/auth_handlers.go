package api

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"

	"quiz-csv-import-tool/server/internal/auth"
	"quiz-csv-import-tool/server/internal/store"
)

const (
	refreshCookieName = "refreshToken"
	maxJSONBodyBytes  = 1 << 20
)

func (s *Server) login(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if !s.readJSON(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.Username) == "" || strings.TrimSpace(req.Password) == "" {
		writeText(w, http.StatusBadRequest, "Invalid payload")
		return
	}

	// Counted before the password is checked, so concurrent attempts cannot slip past the limit together.
	attemptKey := loginAttemptKey(req.Username)
	retryAt, ok, err := s.LoginAttempts.TryConsume(r.Context(), attemptKey, s.LoginMaxAttempts, s.LoginWindow)
	if err != nil {
		s.internalError(w, r, "counting login attempt failed", err)
		return
	}
	if !ok {
		retryAfter := int(math.Ceil(retryAt.Sub(s.now()).Seconds()))
		w.Header().Set("Retry-After", strconv.Itoa(max(retryAfter, 1)))
		writeText(w, http.StatusTooManyRequests, "Too many login attempts")
		return
	}

	session, err := s.Auth.Login(r.Context(), req.Username, req.Password)
	if errors.Is(err, auth.ErrInvalidCredentials) {
		writeText(w, http.StatusUnauthorized, "Invalid credentials")
		return
	}
	if err != nil {
		s.internalError(w, r, "login failed", err)
		return
	}
	if err := s.LoginAttempts.Reset(r.Context(), attemptKey); err != nil {
		s.Logger.Warn("resetting login attempts failed", "error", err)
	}
	s.writeSession(w, session)
}

// loginAttemptKey hashes the typed username, so the attempts collection never stores what was typed in the
// field (sometimes a password) and every key has the same size.
func loginAttemptKey(username string) string {
	sum := sha256.Sum256([]byte(username))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

func (s *Server) refresh(w http.ResponseWriter, r *http.Request) {
	token := refreshTokenFromCookie(r)
	if token == "" {
		writeText(w, http.StatusUnauthorized, "Missing refresh token")
		return
	}
	session, err := s.Auth.Refresh(r.Context(), token)
	if errors.Is(err, auth.ErrRefreshTokenReused) {
		s.Logger.Warn("refresh token reuse detected; revoked every session of the user", "error", err)
	}
	if errors.Is(err, auth.ErrInvalidRefreshToken) {
		writeText(w, http.StatusUnauthorized, "Invalid refresh token")
		return
	}
	if err != nil {
		s.internalError(w, r, "refresh failed", err)
		return
	}
	s.writeSession(w, session)
}

// logout revokes the calling device's refresh token only.
func (s *Server) logout(w http.ResponseWriter, r *http.Request) {
	if token := refreshTokenFromCookie(r); token != "" {
		if _, err := s.Auth.Logout(r.Context(), token); err != nil {
			s.internalError(w, r, "logout failed", err)
			return
		}
	}
	clearRefreshCookie(w)
	w.WriteHeader(http.StatusOK)
}

// logoutAll revokes every refresh token of the user owning the calling device's token.
func (s *Server) logoutAll(w http.ResponseWriter, r *http.Request) {
	token := refreshTokenFromCookie(r)
	if token == "" {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	ok, err := s.Auth.LogoutAll(r.Context(), token)
	if err != nil {
		s.internalError(w, r, "logout-all failed", err)
		return
	}
	if !ok {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	clearRefreshCookie(w)
	w.WriteHeader(http.StatusOK)
}

// createUser is admin-only; the route wraps it in requireAdminKey.
func (s *Server) createUser(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Username string   `json:"username"`
		Password string   `json:"password"`
		Roles    []string `json:"roles"`
	}
	if !s.readJSON(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.Username) == "" || strings.TrimSpace(req.Password) == "" {
		writeText(w, http.StatusBadRequest, "Invalid payload")
		return
	}

	hash, err := auth.HashPassword(req.Password)
	if err != nil {
		s.internalError(w, r, "hashing password failed", err)
		return
	}
	if req.Roles == nil {
		req.Roles = []string{}
	}
	err = s.Users.Create(r.Context(), &store.User{
		Username:     req.Username,
		PasswordHash: hash,
		Roles:        req.Roles,
		CreatedAt:    time.Now().UTC(),
	})
	if errors.Is(err, store.ErrDuplicate) {
		writeText(w, http.StatusConflict, "User already exists")
		return
	}
	if err != nil {
		s.internalError(w, r, "creating user failed", err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]string{"username": req.Username})
}

// readJSON decodes the body into dst (field names match case-insensitively). On failure it writes
// the 400 response and returns false.
func (s *Server) readJSON(w http.ResponseWriter, r *http.Request, dst any) bool {
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxJSONBodyBytes))
	if err != nil {
		writeText(w, http.StatusBadRequest, "Invalid payload")
		return false
	}
	if strings.TrimSpace(string(body)) == "" {
		writeText(w, http.StatusBadRequest, "Missing body")
		return false
	}
	if err := json.Unmarshal(body, dst); err != nil {
		writeText(w, http.StatusBadRequest, "Invalid payload")
		return false
	}
	return true
}

func (s *Server) writeSession(w http.ResponseWriter, session auth.Session) {
	http.SetCookie(w, &http.Cookie{
		Name:     refreshCookieName,
		Value:    session.RefreshToken,
		Path:     "/",
		MaxAge:   int(s.RefreshTokenTTL.Seconds()),
		HttpOnly: true,
		Secure:   true,
		// Strict: the SPA and the API share one origin (Vercel in production, the ng serve proxy
		// locally), so the cookie never has to travel cross-site.
		SameSite: http.SameSiteStrictMode,
	})
	writeJSON(w, http.StatusOK, map[string]string{"accessToken": session.AccessToken})
}

func clearRefreshCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name:     refreshCookieName,
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   true,
		SameSite: http.SameSiteStrictMode,
	})
}

func refreshTokenFromCookie(r *http.Request) string {
	c, err := r.Cookie(refreshCookieName)
	if err != nil {
		return ""
	}
	return c.Value
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
