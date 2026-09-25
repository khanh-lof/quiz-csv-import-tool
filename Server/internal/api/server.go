// Package api is the HTTP layer: routing and the handlers for every /api endpoint.
package api

import (
	"context"
	"log/slog"
	"net/http"
	"time"

	"quiz-csv-import-tool/server/internal/auth"
	"quiz-csv-import-tool/server/internal/csvgen"
	"quiz-csv-import-tool/server/internal/store"
)

// Generator produces quiz CSV from lesson images; implemented by *csvgen.Client.
type Generator interface {
	Generate(ctx context.Context, images []csvgen.Image, creative bool, opts csvgen.Options) (string, error)
}

type Server struct {
	Users store.Users
	Auth  *auth.Service
	JWT   *auth.JWT
	// Generator is nil when the LLM settings are incomplete; CSV generation then fails with 500.
	Generator Generator

	AdminAPIKey     string
	RefreshTokenTTL time.Duration
	AICallsPerRound int
	RoundDuration   time.Duration
	// LLMTimeout bounds each Generator call; zero means no limit beyond the request context.
	LLMTimeout time.Duration

	Logger *slog.Logger
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/auth/login", s.login)
	mux.HandleFunc("POST /api/auth/refresh", s.refresh)
	mux.HandleFunc("POST /api/auth/logout", s.logout)
	mux.HandleFunc("POST /api/auth/logout-all", s.logoutAll)
	mux.HandleFunc("POST /api/users", s.createUser)
	mux.HandleFunc("POST /api/csv/generate-from-image", s.generateCSV)
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		writeText(w, http.StatusOK, "ok")
	})
	return s.logRequests(mux)
}

func (s *Server) logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rec, r)
		s.Logger.Info("request", "method", r.Method, "path", r.URL.Path,
			"status", rec.status, "duration", time.Since(start))
	})
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(status int) {
	r.status = status
	r.ResponseWriter.WriteHeader(status)
}

func (r *statusRecorder) Unwrap() http.ResponseWriter { return r.ResponseWriter }

func writeText(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write([]byte(msg))
}

func (s *Server) internalError(w http.ResponseWriter, r *http.Request, msg string, err error) {
	s.Logger.Error(msg, "path", r.URL.Path, "error", err)
	w.WriteHeader(http.StatusInternalServerError)
}
