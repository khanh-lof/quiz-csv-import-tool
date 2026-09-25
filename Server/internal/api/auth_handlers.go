package api

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"net/http"
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

	session, err := s.Auth.Login(r.Context(), req.Username, req.Password)
	if errors.Is(err, auth.ErrInvalidCredentials) {
		writeText(w, http.StatusUnauthorized, "Invalid credentials")
		return
	}
	if err != nil {
		s.internalError(w, r, "login failed", err)
		return
	}
	s.writeSession(w, session)
}

func (s *Server) refresh(w http.ResponseWriter, r *http.Request) {
	token := refreshTokenFromCookie(r)
	if token == "" {
		writeText(w, http.StatusUnauthorized, "Missing refresh token")
		return
	}
	session, err := s.Auth.Refresh(r.Context(), token)
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

// createUser is an admin-only endpoint guarded by the X-Admin-Key header.
func (s *Server) createUser(w http.ResponseWriter, r *http.Request) {
	key := r.Header.Get("X-Admin-Key")
	if s.AdminAPIKey == "" || subtle.ConstantTimeCompare([]byte(key), []byte(s.AdminAPIKey)) != 1 {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}

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
		// None: the SPA calls the API cross-site and must still send the cookie.
		SameSite: http.SameSiteNoneMode,
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
		SameSite: http.SameSiteNoneMode,
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
