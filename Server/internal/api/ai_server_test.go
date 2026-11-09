package api

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"quiz-csv-import-tool/server/internal/store"
)

var errFake = errors.New("boom")

const creativeQuery = "?isCreative=true&exportType=0&courseType=0&level=1&lessonNumbers=2"

// remoteServer stands in for the AI server behind AIServerProxy: it records what reached it and answers like a
// started job.
type remoteServer struct {
	requests, authorizations []string
	wakes                    int
}

func (s *remoteServer) Wake(context.Context) { s.wakes++ }

func (s *remoteServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.requests = append(s.requests, r.Method+" "+r.URL.RequestURI())
	s.authorizations = append(s.authorizations, r.Header.Get("Authorization"))
	w.WriteHeader(http.StatusAccepted)
	_, _ = w.Write([]byte(`{"id":"remote"}`))
}

func TestCreateJobHandsCreativeJobsToTheAIServer(t *testing.T) {
	env := newEnv(t)
	token, _ := env.login(t, "alice", "pw")
	remote := &remoteServer{}
	env.srv.AIServerProxy = remote
	env.srv.AICallsPerRound = 10

	rec := env.upload(t, upload{token: token, query: creativeQuery, files: 1})
	if rec.Code != http.StatusAccepted || rec.Body.String() != `{"id":"remote"}` {
		t.Fatalf("got %d %q", rec.Code, rec.Body)
	}
	if len(remote.requests) != 1 || remote.requests[0] != "POST /api/csv/jobs"+creativeQuery || remote.authorizations[0] != "Bearer "+token {
		t.Fatalf("forwarded %v %v", remote.requests, remote.authorizations)
	}
	// The server that runs the job stores it and counts the call, not this one.
	if jobs, _ := env.jobs.List(context.Background(), "alice", 10); len(jobs) != 0 {
		t.Fatalf("jobs stored here: %v", jobs)
	}
	if user, _ := env.users.FindByUsername(context.Background(), "alice"); user.AICallCountInRound != 0 {
		t.Fatalf("calls counted here: %d", user.AICallCountInRound)
	}

	// So does one from an older page, which still sends the intelligence it no longer has.
	if rec := env.upload(t, upload{token: token, query: creativeQuery + "&intelligence=2"}); rec.Code != http.StatusAccepted ||
		len(remote.requests) != 2 {
		t.Fatalf("with an intelligence: %d %q, forwarded %v", rec.Code, rec.Body, remote.requests)
	}

	// A formatted job runs here, and a request without a token goes nowhere.
	if rec := env.upload(t, upload{token: token, files: 1}); rec.Code != http.StatusAccepted || rec.Body.String() == `{"id":"remote"}` {
		t.Fatalf("formatted: %d %q", rec.Code, rec.Body)
	}
	if rec := env.upload(t, upload{query: creativeQuery}); rec.Code != http.StatusUnauthorized {
		t.Fatalf("without a token: %d", rec.Code)
	}
	if len(remote.requests) != 2 {
		t.Fatalf("forwarded %v", remote.requests)
	}
	if jobs, _ := env.jobs.List(context.Background(), "alice", 10); len(jobs) != 1 || jobs[0].Creative {
		t.Fatalf("jobs stored here: %+v", jobs)
	}
}

func TestRetryJobHandsCreativeJobsToTheAIServer(t *testing.T) {
	env := newEnv(t)
	token, _ := env.login(t, "alice", "pw")
	env.gen.err = errFake
	env.upload(t, upload{token: token, query: creativeQuery})
	env.upload(t, upload{token: token, files: 1})
	jobs, _ := env.jobs.List(context.Background(), "alice", 10)
	var creative, formatted store.Job
	for _, job := range jobs {
		if job.Creative {
			creative = job
		} else {
			formatted = job
		}
	}
	if len(jobs) != 2 || creative.Status != store.JobFailed || formatted.Status != store.JobFailed {
		t.Fatalf("jobs %+v", jobs)
	}

	remote := &remoteServer{}
	env.srv.AIServerProxy = remote
	env.gen.err = nil
	if rec := env.retry(t, token, creative.ID); rec.Code != http.StatusAccepted || rec.Body.String() != `{"id":"remote"}` {
		t.Fatalf("creative retry: %d %q", rec.Code, rec.Body)
	}
	if rec := env.retry(t, token, formatted.ID); rec.Code != http.StatusAccepted || rec.Body.String() == `{"id":"remote"}` {
		t.Fatalf("formatted retry: %d %q", rec.Code, rec.Body)
	}
	if len(remote.requests) != 1 || remote.requests[0] != "POST /api/csv/jobs/"+creative.ID+"/retry" {
		t.Fatalf("forwarded %v", remote.requests)
	}
}

func TestAIServerRunsOnlyCreativeJobs(t *testing.T) {
	env := newEnv(t)
	token, _ := env.login(t, "alice", "pw")
	env.srv.AICallsPerRound = 10
	env.gen.err = errFake
	env.upload(t, upload{token: token, files: 1}) // a failed formatted job, made on the main server
	failedFormatted := env.onlyJob(t, "alice")
	env.gen.err = nil

	env.srv.AIServerSecret = testProxySecret
	env.h = withProxySecret(env.srv.AIServerHandler(), testProxySecret)
	if rec := env.upload(t, upload{token: token, files: 1}); rec.Code != http.StatusBadRequest || rec.Body.String() != notCreative {
		t.Fatalf("formatted job: %d %q", rec.Code, rec.Body)
	}
	if rec := env.retry(t, token, failedFormatted.ID); rec.Code != http.StatusBadRequest || rec.Body.String() != notCreative {
		t.Fatalf("formatted retry: %d %q", rec.Code, rec.Body)
	}
	if rec := env.upload(t, upload{query: creativeQuery}); rec.Code != http.StatusUnauthorized {
		t.Fatalf("without a token: %d", rec.Code)
	}

	if rec := env.upload(t, upload{token: token, query: creativeQuery, files: 1}); rec.Code != http.StatusAccepted {
		t.Fatalf("creative job: %d %q", rec.Code, rec.Body)
	}
	jobs, _ := env.jobs.List(context.Background(), "alice", 10)
	if len(jobs) != 2 {
		t.Fatalf("jobs %+v", jobs)
	}
	for _, job := range jobs {
		if job.ID != failedFormatted.ID && (job.Status != store.JobDone || !job.Creative) {
			t.Fatalf("creative job %+v", job)
		}
	}

	// Nothing else is served: no login, no job list.
	for _, req := range []*http.Request{
		httptest.NewRequest(http.MethodPost, "/api/auth/login", strings.NewReader(`{}`)),
		httptest.NewRequest(http.MethodGet, "/api/csv/jobs", nil),
		httptest.NewRequest(http.MethodGet, "/api/assignments", nil),
	} {
		req.Header.Set("Authorization", "Bearer "+token)
		if rec := env.do(req); rec.Code != http.StatusNotFound && rec.Code != http.StatusMethodNotAllowed {
			t.Fatalf("%s %s: %d", req.Method, req.URL.Path, rec.Code)
		}
	}
	if rec := env.do(httptest.NewRequest(http.MethodGet, "/healthz", nil)); rec.Code != http.StatusOK {
		t.Fatalf("health check: %d", rec.Code)
	}
}

const testProxySecret = "test-proxy-secret-of-at-least-32-bytes"

// withProxySecret stands in for the main server's proxy: it adds the secret to every request.
func withProxySecret(next http.Handler, secret string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if secret != "" {
			r.Header.Set(ProxySecretHeader, secret)
		}
		next.ServeHTTP(w, r)
	})
}

// A valid token is not enough: a job request that did not come through the main server's proxy is refused, and
// nothing runs.
func TestAIServerRefusesRequestsNotFromTheMainServer(t *testing.T) {
	env := newEnv(t)
	token, _ := env.login(t, "alice", "pw")
	env.srv.AIServerSecret = testProxySecret
	handler := env.srv.AIServerHandler()

	for name, secret := range map[string]string{"missing": "", "wrong": "not-the-proxy-secret", "prefix": testProxySecret[:10]} {
		env.h = withProxySecret(handler, secret)
		if rec := env.upload(t, upload{token: token, query: creativeQuery}); rec.Code != http.StatusForbidden {
			t.Errorf("%s secret, create: %d", name, rec.Code)
		}
		if rec := env.retry(t, token, "any"); rec.Code != http.StatusForbidden {
			t.Errorf("%s secret, retry: %d", name, rec.Code)
		}
	}
	if jobs, _ := env.jobs.List(context.Background(), "alice", 10); len(jobs) != 0 || env.gen.calls != 0 {
		t.Fatalf("a refused request ran: %+v, %d calls", jobs, env.gen.calls)
	}

	env.srv.AIServerSecret = ""
	env.h = withProxySecret(env.srv.AIServerHandler(), "")
	if rec := env.upload(t, upload{token: token, query: creativeQuery}); rec.Code != http.StatusForbidden {
		t.Fatalf("server without a secret, no header: %d", rec.Code)
	}

	env.h = handler
	if rec := env.do(httptest.NewRequest(http.MethodGet, "/healthz", nil)); rec.Code != http.StatusOK {
		t.Fatalf("health check without the secret: %d", rec.Code)
	}
}

// The real proxy carries the request, body and token included, to an AI server sharing the main server's stores,
// which runs the job the main server then lists.
func TestAIServerProxyReachesTheAIServer(t *testing.T) {
	env := newEnv(t)
	token, _ := env.login(t, "alice", "pw")
	remoteGen := &fakeGenerator{result: "remote,csv"}
	remote := &Server{
		Users: env.users, Jobs: env.jobs, JWT: env.srv.JWT, Generator: remoteGen,
		AICallsPerRound: 2, RoundDuration: time.Minute, Logger: slog.New(slog.DiscardHandler),
		AIServerSecret: testProxySecret,
	}
	aiServer := httptest.NewServer(remote.AIServerHandler())
	defer aiServer.Close()
	target, _ := url.Parse(aiServer.URL)
	env.srv.AIServerProxy = NewAIServerProxy(target, testProxySecret, env.srv.Logger)

	rec := env.upload(t, upload{token: token, query: creativeQuery, files: 2})
	if rec.Code != http.StatusAccepted {
		t.Fatalf("got %d %q", rec.Code, rec.Body)
	}
	for deadline := time.Now().Add(5 * time.Second); ; time.Sleep(time.Millisecond) {
		if jobs := env.listJobs(t, token); len(jobs) == 1 && jobs[0]["status"] == "done" {
			if jobs[0]["csv"] != "remote,csv" || jobs[0]["creative"] != true || jobs[0]["imageCount"] != float64(2) {
				t.Fatalf("job %v", jobs[0])
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the AI server's job never finished")
		}
	}
	if env.gen.calls != 0 || remoteGen.calls != 1 || len(remoteGen.images) != 2 {
		t.Fatalf("main server's generator called %d times, remote's %d with %d images", env.gen.calls, remoteGen.calls, len(remoteGen.images))
	}

	aiServer.Close()
	if rec := env.upload(t, upload{token: token, query: creativeQuery}); rec.Code != http.StatusBadGateway ||
		rec.Body.String() != "The AI server is unavailable." {
		t.Fatalf("server down: %d %q", rec.Code, rec.Body)
	}
}
