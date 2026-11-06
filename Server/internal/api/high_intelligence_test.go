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

const (
	highQuery = "?isCreative=true&exportType=0&courseType=0&level=1&lessonNumbers=2&intelligence=2"
	lowQuery  = "?isCreative=true&exportType=0&courseType=0&level=1&lessonNumbers=2&intelligence=1"
)

// remoteServer stands in for the High intelligence server behind HighIntelligenceProxy: it records what reached
// it and answers like a started job.
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

func TestCreateJobHandsHighIntelligenceJobsToTheirServer(t *testing.T) {
	env := newEnv(t)
	token, _ := env.login(t, "alice", "pw")
	remote := &remoteServer{}
	env.srv.HighIntelligenceProxy = remote
	env.srv.AICallsPerRound = 10

	rec := env.upload(t, upload{token: token, query: highQuery, files: 1})
	if rec.Code != http.StatusAccepted || rec.Body.String() != `{"id":"remote"}` {
		t.Fatalf("got %d %q", rec.Code, rec.Body)
	}
	if len(remote.requests) != 1 || remote.requests[0] != "POST /api/csv/jobs"+highQuery || remote.authorizations[0] != "Bearer "+token {
		t.Fatalf("forwarded %v %v", remote.requests, remote.authorizations)
	}
	// The server that runs the job stores it and counts the call, not this one.
	if jobs, _ := env.jobs.List(context.Background(), "alice", 10); len(jobs) != 0 {
		t.Fatalf("jobs stored here: %v", jobs)
	}
	if user, _ := env.users.FindByUsername(context.Background(), "alice"); user.AICallCountInRound != 0 {
		t.Fatalf("calls counted here: %d", user.AICallCountInRound)
	}

	// Every other job runs here, and so does a request this server refuses itself.
	for _, u := range []upload{
		{token: token, query: lowQuery},
		{token: token, query: "?isCreative=true&exportType=0&courseType=0&level=1&lessonNumbers=2"},
		{token: token, files: 1},
	} {
		if rec := env.upload(t, u); rec.Code != http.StatusAccepted {
			t.Fatalf("%q: %d %q", u.query, rec.Code, rec.Body)
		}
	}
	if rec := env.upload(t, upload{token: token, query: strings.Replace(highQuery, "intelligence=2", "intelligence=3", 1)}); rec.Code != http.StatusBadRequest {
		t.Fatalf("bad intelligence: %d %q", rec.Code, rec.Body)
	}
	if rec := env.upload(t, upload{query: highQuery}); rec.Code != http.StatusUnauthorized {
		t.Fatalf("without a token: %d", rec.Code)
	}
	if len(remote.requests) != 1 {
		t.Fatalf("forwarded %v", remote.requests)
	}
}

func TestRetryJobHandsHighIntelligenceJobsToTheirServer(t *testing.T) {
	env := newEnv(t)
	token, _ := env.login(t, "alice", "pw")
	env.gen.err = errFake
	env.upload(t, upload{token: token, query: highQuery})
	env.upload(t, upload{token: token, query: lowQuery})
	jobs, _ := env.jobs.List(context.Background(), "alice", 10)
	var high, low store.Job
	for _, job := range jobs {
		if job.Intelligence == 2 {
			high = job
		} else {
			low = job
		}
	}
	if len(jobs) != 2 || high.Intelligence != 2 || low.Intelligence != 1 || high.Status != store.JobFailed || low.Status != store.JobFailed {
		t.Fatalf("jobs %+v", jobs)
	}

	remote := &remoteServer{}
	env.srv.HighIntelligenceProxy = remote
	env.gen.err = nil
	if rec := env.retry(t, token, high.ID); rec.Code != http.StatusAccepted || rec.Body.String() != `{"id":"remote"}` {
		t.Fatalf("High retry: %d %q", rec.Code, rec.Body)
	}
	if rec := env.retry(t, token, low.ID); rec.Code != http.StatusAccepted || rec.Body.String() == `{"id":"remote"}` {
		t.Fatalf("Low retry: %d %q", rec.Code, rec.Body)
	}
	if len(remote.requests) != 1 || remote.requests[0] != "POST /api/csv/jobs/"+high.ID+"/retry" {
		t.Fatalf("forwarded %v", remote.requests)
	}
}

func TestHighIntelligenceServerRunsOnlyHighIntelligenceJobs(t *testing.T) {
	env := newEnv(t)
	token, _ := env.login(t, "alice", "pw")
	env.srv.AICallsPerRound = 10
	env.gen.err = errFake
	env.upload(t, upload{token: token, query: lowQuery}) // a failed Low job, made on the main server
	failedLow := env.onlyJob(t, "alice")
	env.gen.err = nil

	env.h = env.srv.HighIntelligenceHandler()
	for _, u := range []upload{{token: token, query: lowQuery}, {token: token, files: 1}} {
		if rec := env.upload(t, u); rec.Code != http.StatusBadRequest || rec.Body.String() != notHighIntelligence {
			t.Fatalf("%q: %d %q", u.query, rec.Code, rec.Body)
		}
	}
	if rec := env.retry(t, token, failedLow.ID); rec.Code != http.StatusBadRequest || rec.Body.String() != notHighIntelligence {
		t.Fatalf("Low retry: %d %q", rec.Code, rec.Body)
	}
	if rec := env.upload(t, upload{query: highQuery}); rec.Code != http.StatusUnauthorized {
		t.Fatalf("without a token: %d", rec.Code)
	}

	if rec := env.upload(t, upload{token: token, query: highQuery, files: 1}); rec.Code != http.StatusAccepted {
		t.Fatalf("High job: %d %q", rec.Code, rec.Body)
	}
	jobs, _ := env.jobs.List(context.Background(), "alice", 10)
	if len(jobs) != 2 {
		t.Fatalf("jobs %+v", jobs)
	}
	for _, job := range jobs {
		if job.ID != failedLow.ID && (job.Status != store.JobDone || job.Intelligence != 2) {
			t.Fatalf("High job %+v", job)
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

// The real proxy carries the request, body and token included, to a High intelligence server sharing the main
// server's stores, which runs the job the main server then lists.
func TestHighIntelligenceProxyReachesTheHighIntelligenceServer(t *testing.T) {
	env := newEnv(t)
	token, _ := env.login(t, "alice", "pw")
	remoteGen := &fakeGenerator{result: "remote,csv"}
	remote := &Server{
		Users: env.users, Jobs: env.jobs, JWT: env.srv.JWT, Generator: remoteGen,
		AICallsPerRound: 2, RoundDuration: time.Minute, Logger: slog.New(slog.DiscardHandler),
	}
	aiServer := httptest.NewServer(remote.HighIntelligenceHandler())
	defer aiServer.Close()
	target, _ := url.Parse(aiServer.URL)
	env.srv.HighIntelligenceProxy = NewHighIntelligenceProxy(target, env.srv.Logger)

	rec := env.upload(t, upload{token: token, query: highQuery, files: 2})
	if rec.Code != http.StatusAccepted {
		t.Fatalf("got %d %q", rec.Code, rec.Body)
	}
	for deadline := time.Now().Add(5 * time.Second); ; time.Sleep(time.Millisecond) {
		if jobs := env.listJobs(t, token); len(jobs) == 1 && jobs[0]["status"] == "done" {
			if jobs[0]["csv"] != "remote,csv" || jobs[0]["intelligence"] != float64(2) || jobs[0]["imageCount"] != float64(2) {
				t.Fatalf("job %v", jobs[0])
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the High intelligence server's job never finished")
		}
	}
	if env.gen.calls != 0 || remoteGen.calls != 1 || len(remoteGen.images) != 2 {
		t.Fatalf("main server's generator called %d times, remote's %d with %d images", env.gen.calls, remoteGen.calls, len(remoteGen.images))
	}

	aiServer.Close()
	if rec := env.upload(t, upload{token: token, query: highQuery}); rec.Code != http.StatusBadGateway ||
		rec.Body.String() != "The High intelligence AI server is unavailable." {
		t.Fatalf("server down: %d %q", rec.Code, rec.Body)
	}
}
