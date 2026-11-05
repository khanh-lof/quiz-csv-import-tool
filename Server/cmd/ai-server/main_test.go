package main

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
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
