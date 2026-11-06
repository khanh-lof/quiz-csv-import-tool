package main

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"quiz-csv-import-tool/server/internal/store"
)

func TestActivityCountsRunningRequestsButNotTheHealthCheck(t *testing.T) {
	var a activity
	release := make(chan struct{})
	seen := make(chan int64, 2)
	handler := a.track(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen <- a.running.Load()
		if r.URL.Path != "/healthz" {
			<-release
		}
	}))

	done := make(chan struct{})
	go func() {
		handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodPost, "/api/csv/jobs", nil))
		close(done)
	}()
	if n := <-seen; n != 1 {
		t.Fatalf("running during a job: %d", n)
	}
	handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/healthz", nil))
	if n := <-seen; n != 1 {
		t.Fatalf("the health check was counted: %d", n)
	}
	close(release)
	<-done
	if n := a.running.Load(); n != 0 {
		t.Fatalf("running after the job: %d", n)
	}
}

// fakeResumer hands out its jobs one claim at a time, then nil, and holds each resumed job until released.
type fakeResumer struct {
	mu      sync.Mutex
	waiting []*store.Job
	resumed chan string
	release chan struct{}
}

func (f *fakeResumer) ClaimInterruptedJob(context.Context) (*store.Job, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.waiting) == 0 {
		return nil, nil
	}
	job := f.waiting[0]
	f.waiting = f.waiting[1:]
	return job, nil
}

func (f *fakeResumer) ResumeJob(_ context.Context, job *store.Job) {
	f.resumed <- job.ID
	<-f.release
}

func TestResumeInterruptedRunsEveryClaimedJobAsRunning(t *testing.T) {
	jobs := &fakeResumer{waiting: []*store.Job{{ID: "a"}, {ID: "b"}}, resumed: make(chan string, 3), release: make(chan struct{})}
	var a activity
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go a.resumeInterrupted(ctx, jobs, time.Millisecond, slog.New(slog.NewTextHandler(io.Discard, nil)))

	got := map[string]bool{<-jobs.resumed: true, <-jobs.resumed: true}
	if !got["a"] || !got["b"] || a.running.Load() != 2 {
		t.Fatalf("resumed %v, %d running", got, a.running.Load())
	}
	// A job claimed later, on a following check, is resumed too.
	jobs.mu.Lock()
	jobs.waiting = append(jobs.waiting, &store.Job{ID: "c"})
	jobs.mu.Unlock()
	if id := <-jobs.resumed; id != "c" {
		t.Fatalf("resumed %s", id)
	}

	waitCtx, cancelWait := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancelWait()
	if a.waitResumed(waitCtx) {
		t.Fatal("waitResumed returned while jobs still run")
	}
	close(jobs.release)
	if !a.waitResumed(context.Background()) || a.running.Load() != 0 {
		t.Fatalf("after the jobs: %d running", a.running.Load())
	}
}

func TestKeepAwakeRequestsItselfOnlyWhileBusy(t *testing.T) {
	var hits atomic.Int64
	self := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { hits.Add(1) }))
	defer self.Close()

	var a activity
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go a.keepAwake(ctx, self.URL+"/healthz", time.Millisecond, slog.New(slog.NewTextHandler(io.Discard, nil)))

	time.Sleep(50 * time.Millisecond)
	if n := hits.Load(); n != 0 {
		t.Fatalf("requested itself while idle: %d", n)
	}
	a.running.Add(1)
	for deadline := time.Now().Add(5 * time.Second); hits.Load() == 0; time.Sleep(time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatal("never requested itself while busy")
		}
	}
}
