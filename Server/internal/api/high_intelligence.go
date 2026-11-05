package api

import (
	"log/slog"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"time"

	"quiz-csv-import-tool/server/internal/csvgen"
	"quiz-csv-import-tool/server/internal/store"
)

// Creative jobs at High intelligence ("Cao") run on a server of their own (cmd/ai-server, on Render), whose
// requests have no time limit, while every other request stays on the main server (Vercel), whose functions
// stop after 300 s. The main server hands such a job to it through HighIntelligenceProxy, so the browser keeps
// talking to one origin. Both servers write to the same job store, and the client follows the job through the
// main server's listJobs like any other.

// notHighIntelligence is the High intelligence server's answer to any other job.
const notHighIntelligence = "Only High intelligence jobs run on this server."

// highIntelligenceWait bounds the wait for the High intelligence server's answer, the 202 of a job (the job
// goes on after it). A free Render instance that went to sleep takes about a minute to wake.
const highIntelligenceWait = 2 * time.Minute

// isHighIntelligence says whether a createJob query asks for a creative job at High intelligence. A query that
// does not parse is not one: the server it reached answers why.
func isHighIntelligence(query url.Values) bool {
	if !strings.EqualFold(strings.TrimSpace(query.Get("isCreative")), "true") {
		return false
	}
	opts, err := csvgen.ParseCreativeOptions(query)
	return err == nil && opts.Intelligence == csvgen.HighIntelligence
}

// isHighIntelligenceJob says whether retrying job, with the options retryOptions read from it, is a job at High
// intelligence.
func isHighIntelligenceJob(job *store.Job, opts csvgen.Options) bool {
	return job.Creative && opts.Intelligence == csvgen.HighIntelligence
}

// NewHighIntelligenceProxy forwards a request to the High intelligence server at target, with its path, query,
// body and Authorization header unchanged. That server checks the token itself, so both servers must share
// JWT_SECRET.
func NewHighIntelligenceProxy(target *url.URL, logger *slog.Logger) http.Handler {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.ResponseHeaderTimeout = highIntelligenceWait
	return &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.SetURL(target)
			pr.SetXForwarded()
		},
		Transport: transport,
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			logger.Error("forwarding to the High intelligence server failed", "path", r.URL.Path, "error", err)
			writeText(w, http.StatusBadGateway, "The High intelligence AI server is unavailable.")
		},
	}
}

// HighIntelligenceHandler is the whole API of the High intelligence server: starting and retrying creative jobs
// at High intelligence, refusing every other job with 400, and the health check. Logging in, the job list and
// the rest stay on the main server, whose tokens are checked here with the shared secret.
func (s *Server) HighIntelligenceHandler() http.Handler {
	mux := http.NewServeMux()
	mux.Handle("POST /api/csv/jobs", s.userRoute(func(w http.ResponseWriter, r *http.Request) {
		if !isHighIntelligence(r.URL.Query()) {
			writeText(w, http.StatusBadRequest, notHighIntelligence)
			return
		}
		s.createJob(w, r)
	}))
	mux.Handle("POST /api/csv/jobs/{id}/retry", s.userRoute(func(w http.ResponseWriter, r *http.Request) {
		s.retry(w, r, true)
	}))
	mux.HandleFunc("GET /healthz", healthz)
	return s.logRequests(mux)
}
