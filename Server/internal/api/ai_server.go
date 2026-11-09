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
)

// The creative jobs the model writes run on a server of their own (cmd/ai-server, on Render), whose requests have
// no time limit, while every other request stays on the main server (Vercel), whose functions stop after 300 s:
// the formatted jobs, and the quizzes the question bank holds whole (answerFromBank), which ask no model. The main
// server hands such a job to it through AIServerProxy, so the browser keeps talking to one origin. Both servers
// write to the same job store, and the client follows the job through the main server's listJobs like any other.

// notCreative is the AI server's answer to a formatted job.
const notCreative = "Only creative jobs run on this server."

// aiServerWait bounds the wait for the AI server's answer, the 202 of a job (the job goes on after it). A free
// Render instance that went to sleep takes about a minute to wake.
const aiServerWait = 2 * time.Minute

// isCreative says whether a createJob query asks for a creative job.
func isCreative(query url.Values) bool {
	return strings.EqualFold(strings.TrimSpace(query.Get("isCreative")), "true")
}

// AIServer is the main server's way to the AI server: it serves the requests handed to it, and Wake asks it to
// start, should it be asleep, so it takes over its interrupted jobs.
type AIServer interface {
	http.Handler
	Wake(ctx context.Context)
}

// wakeWait bounds a wake call: the request only has to arrive, and a sleeping server answers once it is up.
const wakeWait = 3 * time.Second

// ProxySecretHeader carries the secret that proves a request to the AI server came through the main server's
// AIServerProxy.
const ProxySecretHeader = "X-Proxy-Secret"

type aiServerProxy struct {
	*httputil.ReverseProxy
	health string
	client *http.Client
}

// NewAIServerProxy forwards a request to the AI server at target, with its path, query, body and Authorization
// header unchanged. That server checks the token itself, so both servers must share JWT_SECRET, and it only
// accepts a request that carries secret, so both must share that too.
func NewAIServerProxy(target *url.URL, secret string, logger *slog.Logger) AIServer {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.ResponseHeaderTimeout = aiServerWait
	return &aiServerProxy{
		ReverseProxy: &httputil.ReverseProxy{
			Rewrite: func(pr *httputil.ProxyRequest) {
				pr.SetURL(target)
				pr.SetXForwarded()
				pr.Out.Header.Set(ProxySecretHeader, secret)
			},
			Transport: transport,
			ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
				logger.Error("forwarding to the AI server failed", "path", r.URL.Path, "error", err)
				writeText(w, http.StatusBadGateway, "The AI server is unavailable.")
			},
		},
		health: target.JoinPath("healthz").String(),
		client: &http.Client{Timeout: wakeWait},
	}
}

// Wake requests the server's health check. Its answer does not matter: a timeout while the server starts is
// expected, and the request reaching it is what starts it.
func (p *aiServerProxy) Wake(ctx context.Context) {
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
		if s.AIServerSecret == "" || subtle.ConstantTimeCompare(given, []byte(s.AIServerSecret)) != 1 {
			writeText(w, http.StatusForbidden, "Only the main server may call this server.")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// AIServerHandler is the whole API of the AI server: starting and retrying creative jobs, refusing a formatted
// job with 400, and the health check. Logging in, the job list and the rest stay on the main server, whose tokens
// are checked here with the shared secret. The jobs are only taken from the main server's proxy (fromMainServer).
func (s *Server) AIServerHandler() http.Handler {
	mux := http.NewServeMux()
	mux.Handle("POST /api/csv/jobs", s.fromMainServer(s.userRoute(func(w http.ResponseWriter, r *http.Request) {
		if !isCreative(r.URL.Query()) {
			writeText(w, http.StatusBadRequest, notCreative)
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
