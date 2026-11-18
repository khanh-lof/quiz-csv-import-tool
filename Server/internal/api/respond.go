package api

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
)

// The helpers every handler answers with. Error bodies are plain text: the client matches some of them
// as strings, so they are part of the contract.

func writeText(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write([]byte(msg))
}

func (s *Server) internalError(w http.ResponseWriter, r *http.Request, msg string, err error) {
	s.Logger.Error(msg, "path", r.URL.Path, "error", err)
	w.WriteHeader(http.StatusInternalServerError)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// noStore marks the answer uncacheable: an answer the client polls, or one that must change the moment
// a teacher acts (a close, a hidden board).
func noStore(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", "no-store")
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
