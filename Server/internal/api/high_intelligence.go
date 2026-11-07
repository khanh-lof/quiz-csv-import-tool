package api

import (
	"context"
	"crypto/subtle"
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

// HighIntelligenceServer is the main server's way to the High intelligence server: it serves the requests handed
// to it, and Wake asks it to start, should it be asleep, so it takes over its interrupted jobs.
type HighIntelligenceServer interface {
	http.Handler
	Wake(ctx context.Context)
}

// wakeWait bounds a wake call: the request only has to arrive, and a sleeping server answers once it is up.
const wakeWait = 3 * time.Second

// ProxySecretHeader carries the secret that proves a request to the High intelligence server came through the
// main server's HighIntelligenceProxy.
const ProxySecretHeader = "X-Proxy-Secret"

type highIntelligenceProxy struct {
	*httputil.ReverseProxy
	health string
	client *http.Client
}

// NewHighIntelligenceProxy forwards a request to the High intelligence server at target, with its path, query,
// body and Authorization header unchanged. That server checks the token itself, so both servers must share
// JWT_SECRET, and it only accepts a request that carries secret, so both must share that too.
func NewHighIntelligenceProxy(target *url.URL, secret string, logger *slog.Logger) HighIntelligenceServer {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.ResponseHeaderTimeout = highIntelligenceWait
	return &highIntelligenceProxy{
		ReverseProxy: &httputil.ReverseProxy{
			Rewrite: func(pr *httputil.ProxyRequest) {
				pr.SetURL(target)
				pr.SetXForwarded()
				pr.Out.Header.Set(ProxySecretHeader, secret)
			},
			Transport: transport,
			ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
				logger.Error("forwarding to the High intelligence server failed", "path", r.URL.Path, "error", err)
				writeText(w, http.StatusBadGateway, "The High intelligence AI server is unavailable.")
			},
		},
		health: target.JoinPath("healthz").String(),
		client: &http.Client{Timeout: wakeWait},
	}
}

// Wake requests the server's health check. Its answer does not matter: a timeout while the server starts is
// expected, and the request reaching it is what starts it.
func (p *highIntelligenceProxy) Wake(ctx context.Context) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, p.health, nil)
	if err != nil {
		return
	}
	if resp, err := p.client.Do(req); err == nil {
		_ = resp.Body.Close()
	}
}

// fromMainServer lets a request through only when it carries the proxy secret. Without a configured secret it
// lets nothing through. The health check stays outside it: the main server's wake call and the server's own
// keep-awake request carry no secret, and it reveals nothing.
func (s *Server) fromMainServer(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		given := []byte(r.Header.Get(ProxySecretHeader))
		if s.HighIntelligenceSecret == "" || subtle.ConstantTimeCompare(given, []byte(s.HighIntelligenceSecret)) != 1 {
			writeText(w, http.StatusForbidden, "Only the main server may call this server.")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// HighIntelligenceHandler is the whole API of the High intelligence server: starting and retrying creative jobs
// at High intelligence, refusing every other job with 400, and the health check. Logging in, the job list and
// the rest stay on the main server, whose tokens are checked here with the shared secret. The jobs are only
// taken from the main server's proxy (fromMainServer).
func (s *Server) HighIntelligenceHandler() http.Handler {
	mux := http.NewServeMux()
	mux.Handle("POST /api/csv/jobs", s.fromMainServer(s.userRoute(func(w http.ResponseWriter, r *http.Request) {
		if !isHighIntelligence(r.URL.Query()) {
			writeText(w, http.StatusBadRequest, notHighIntelligence)
			return
		}
		s.createJob(w, r)
	})))
	mux.Handle("POST /api/csv/jobs/{id}/retry", s.fromMainServer(s.userRoute(func(w http.ResponseWriter, r *http.Request) {
		s.retry(w, r, true)
	})))
	mux.HandleFunc("GET /healthz", healthz)
	return s.logRequests(mux)
}
