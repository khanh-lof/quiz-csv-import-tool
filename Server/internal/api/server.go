// Package api is the HTTP layer: routing and the handlers for every /api endpoint.
package api

import (
	"context"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"quiz-csv-import-tool/server/internal/auth"
	"quiz-csv-import-tool/server/internal/csvgen"
	"quiz-csv-import-tool/server/internal/store"
)

// Generator produces quiz CSV from lesson images; implemented by *csvgen.Client.
type Generator interface {
	GenerateWithProgress(ctx context.Context, images []csvgen.Image, creative bool, opts csvgen.Options, onRows func(rows int)) (csvgen.Result, error)
}

type Server struct {
	Users store.Users
	// Jobs holds the AI generations, which outlive the request that started them.
	Jobs store.Jobs
	// Assignments holds the quizzes teachers handed to students, and those students.
	Assignments store.Assignments
	// LoginAttempts counts the password checks per username for the login limit.
	LoginAttempts store.LoginAttempts

	Auth *auth.Service
	JWT  *auth.JWT
	// Generator is nil when the LLM settings are incomplete; CSV generation then fails with 500.
	Generator Generator

	AdminAPIKey     string
	RefreshTokenTTL time.Duration
	AICallsPerRound int
	RoundDuration   time.Duration
	// LoginMaxAttempts password checks are allowed per username in each LoginWindow.
	LoginMaxAttempts int
	LoginWindow      time.Duration
	// LLMTimeout bounds each Generator call; zero means no limit.
	LLMTimeout time.Duration
	// HighIntelligenceProxy, when set, takes the creative jobs at High intelligence ("Cao") instead of this
	// server: createJob and retryJob hand such a request to it untouched, and the AI server behind it
	// (HighIntelligenceHandler) runs the job, writing it to the same job store and taking it over should its
	// process die (ResumeJob). Nil runs them here.
	HighIntelligenceProxy HighIntelligenceServer
	// HighIntelligenceSecret is what the AI server (HighIntelligenceHandler) requires in the ProxySecretHeader of
	// every job request, so only the main server's proxy can start one. Empty refuses them all.
	HighIntelligenceSecret string
	// ImageStore keeps the images of jobs for imagesKeptFor, so a failed job can be retried and an interrupted one
	// resumed without an upload, on any server. Nil keeps none: a job with images then cannot be sent again.
	ImageStore ImageStore

	// StageSeconds is how many seconds a question of each Game stage (1 to 6, in order) lasts in the standard
	// time mode, from the server's own configuration (GAME_STAGE_SECONDS). A shared quiz is timed here and
	// nowhere else; the students' page is told the limits in the replies. Empty means gesturequiz's
	// defaults, which is also what a Server that was not given any reads as.
	StageSeconds []int

	// Now is the clock the assignment handlers read (opening times, results, closing); nil means
	// time.Now. Tests set it to step through a closing time without waiting.
	Now func() time.Time

	Logger *slog.Logger

	// heartbeatEvery is how often a running job's heartbeat is recorded; zero means jobHeartbeatInterval.
	// Tests shrink it.
	heartbeatEvery time.Duration

	// imageCleanupAt is when this process last deleted the images kept too long, and wokeAt when it last woke
	// the High intelligence server; each is done at most so often.
	chores         sync.Mutex
	imageCleanupAt time.Time
	wokeAt         time.Time
}

// due says whether a chore last done at *last is due again, every so often, and if so records it as done now.
func (s *Server) due(last *time.Time, every time.Duration) bool {
	s.chores.Lock()
	defer s.chores.Unlock()
	now := time.Now()
	if !last.IsZero() && now.Sub(*last) < every {
		return false
	}
	*last = now
	return true
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
	csvRoute := s.userRoute
	mux.Handle("POST /api/csv/jobs", csvRoute(s.createJob))
	mux.Handle("GET /api/csv/jobs", csvRoute(s.listJobs))
	mux.Handle("DELETE /api/csv/jobs/{id}", csvRoute(s.deleteJob))
	mux.Handle("POST /api/csv/jobs/{id}/retry", csvRoute(s.retryJob))
	mux.Handle("GET /api/csv/jobs/{id}/page", csvRoute(s.jobPage))
	mux.Handle("GET /api/csv/jobs/{id}/radicals", csvRoute(s.radicalsEdit))
	mux.Handle("PUT /api/csv/jobs/{id}/radicals", csvRoute(s.reviseRadicals))
	// The teacher's side of "Giao bài" needs a login like the jobs it hands out.
	mux.Handle("POST /api/assignments", csvRoute(s.createAssignment))
	mux.Handle("GET /api/assignments", csvRoute(s.listAssignments))
	mux.Handle("GET /api/assignments/{id}", csvRoute(s.getAssignment))
	mux.Handle("PATCH /api/assignments/{id}", csvRoute(s.patchAssignment))
	mux.Handle("DELETE /api/assignments/{id}", csvRoute(s.deleteAssignment))
	mux.Handle("DELETE /api/assignments/{id}/players/{playerId}", csvRoute(s.deleteAssignmentPlayer))
	mux.Handle("GET /api/extension", csvRoute(s.downloadExtension))
	// The students' side is anonymous: the link's code and the player's own token are the credentials,
	// and these routes never answer 401, which the SPA's interceptor would answer with a refresh.
	mux.HandleFunc("GET /api/share/{code}", s.getShared)
	mux.HandleFunc("POST /api/share/{code}/players", s.joinShared)
	mux.HandleFunc("POST /api/share/{code}/runs", s.startRun)
	mux.HandleFunc("POST /api/share/{code}/runs/{runId}/next", s.nextQuestion)
	mux.HandleFunc("POST /api/share/{code}/runs/{runId}/answers", s.answerQuestion)
	mux.HandleFunc("PATCH /api/share/{code}/player", s.updateSharedPlayer)
	mux.HandleFunc("GET /api/share/{code}/leaderboard", s.sharedLeaderboard)
	mux.HandleFunc("GET /healthz", healthz)
	return s.logRequests(mux)
}

// userRoute lets h answer logged-in users (and admins) only.
func (s *Server) userRoute(h http.HandlerFunc) http.Handler {
	return s.authenticate(requireRole(auth.RoleUser, auth.RoleAdmin)(h))
}

func healthz(w http.ResponseWriter, _ *http.Request) {
	writeText(w, http.StatusOK, "ok")
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
