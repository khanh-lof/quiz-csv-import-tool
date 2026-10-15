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
	// Jobs holds the AI generations, which outlive the request that started them.
	Jobs store.Jobs
	// Assignments holds the quizzes teachers handed to students, and those students.
	Assignments store.Assignments

	Auth *auth.Service
	JWT  *auth.JWT
	// Generator is nil when the LLM settings are incomplete; CSV generation then fails with 500.
	Generator Generator

	AdminAPIKey     string
	RefreshTokenTTL time.Duration
	AICallsPerRound int
	RoundDuration   time.Duration
	// LLMTimeout bounds each Generator call; zero means no limit.
	LLMTimeout time.Duration

	// Now is the clock the assignment handlers read (opening times, results, closing); nil means
	// time.Now. Tests set it to step through a closing time without waiting.
	Now func() time.Time

	Logger *slog.Logger
}

func (s *Server) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now()
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/auth/login", s.login)
	mux.HandleFunc("POST /api/auth/refresh", s.refresh)
	mux.HandleFunc("POST /api/auth/logout", s.logout)
	mux.HandleFunc("POST /api/auth/logout-all", s.logoutAll)
	mux.Handle("POST /api/users", s.requireAdminKey(http.HandlerFunc(s.createUser)))
	csvRoute := func(h http.HandlerFunc) http.Handler {
		return s.authenticate(requireRole(auth.RoleUser, auth.RoleAdmin)(h))
	}
	mux.Handle("POST /api/csv/jobs", csvRoute(s.createJob))
	mux.Handle("GET /api/csv/jobs", csvRoute(s.listJobs))
	mux.Handle("DELETE /api/csv/jobs/{id}", csvRoute(s.deleteJob))
	// The teacher's side of "Giao bài" needs a login like the jobs it hands out.
	mux.Handle("POST /api/assignments", csvRoute(s.createAssignment))
	mux.Handle("GET /api/assignments", csvRoute(s.listAssignments))
	mux.Handle("GET /api/assignments/{id}", csvRoute(s.getAssignment))
	mux.Handle("PATCH /api/assignments/{id}", csvRoute(s.patchAssignment))
	mux.Handle("DELETE /api/assignments/{id}", csvRoute(s.deleteAssignment))
	mux.Handle("DELETE /api/assignments/{id}/players/{playerId}", csvRoute(s.deleteAssignmentPlayer))
	// The students' side is anonymous: the link's code and the player's own token are the credentials,
	// and these routes never answer 401, which the SPA's interceptor would answer with a refresh.
	mux.HandleFunc("GET /api/share/{code}", s.getShared)
	mux.HandleFunc("POST /api/share/{code}/players", s.joinShared)
	mux.HandleFunc("POST /api/share/{code}/results", s.reportResult)
	mux.HandleFunc("PATCH /api/share/{code}/player", s.updateSharedPlayer)
	mux.HandleFunc("GET /api/share/{code}/leaderboard", s.sharedLeaderboard)
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
