package csvgen

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

const okResponse = `{"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"a,b"}]}]}`

// flakyLLM answers the first len(statuses) calls with those statuses, then succeeds.
func flakyLLM(t *testing.T, statuses []int, header http.Header) (*Client, *atomic.Int32) {
	t.Helper()
	var calls atomic.Int32
	llm := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		n := int(calls.Add(1))
		if n <= len(statuses) {
			for k, v := range header {
				w.Header()[k] = v
			}
			w.WriteHeader(statuses[n-1])
			_, _ = w.Write([]byte(`{"error":{"code":"upstream_capacity_unavailable"}}`))
			return
		}
		_, _ = w.Write([]byte(okResponse))
	}))
	t.Cleanup(llm.Close)
	c := NewClient(llm.URL, "key", "m", nil, slog.New(slog.DiscardHandler))
	c.baseBackoff = time.Millisecond
	return c, &calls
}

func TestGenerateRetriesTransientStatuses(t *testing.T) {
	for _, status := range []int{http.StatusTooManyRequests, http.StatusBadGateway, http.StatusServiceUnavailable, http.StatusGatewayTimeout} {
		c, calls := flakyLLM(t, []int{status, status}, nil)
		got, err := c.Generate(context.Background(), nil, true, Options{})
		if err != nil || got != "a,b" || calls.Load() != 3 {
			t.Errorf("status %d: got %q, %v after %d calls", status, got, err, calls.Load())
		}
	}
}

func TestGenerateGivesUpAfterMaxAttempts(t *testing.T) {
	c, calls := flakyLLM(t, []int{503, 503, 503, 503}, nil)
	_, err := c.Generate(context.Background(), nil, true, Options{})
	var statusErr *StatusError
	if !errors.As(err, &statusErr) || statusErr.Status != 503 || statusErr.Code != "upstream_capacity_unavailable" {
		t.Fatalf("want 503 StatusError, got %v", err)
	}
	if calls.Load() != maxAttempts {
		t.Fatalf("got %d calls, want %d", calls.Load(), maxAttempts)
	}
}

func TestGenerateDoesNotRetryClientErrors(t *testing.T) {
	for _, status := range []int{400, 401, 402, 403, 404, 413} {
		c, calls := flakyLLM(t, []int{status}, nil)
		if _, err := c.Generate(context.Background(), nil, true, Options{}); err == nil || calls.Load() != 1 {
			t.Errorf("status %d: err %v after %d calls", status, err, calls.Load())
		}
	}
}

func TestGenerateHonoursRetryAfter(t *testing.T) {
	c, calls := flakyLLM(t, []int{429}, http.Header{"Retry-After": {"1"}})
	start := time.Now()
	if _, err := c.Generate(context.Background(), nil, true, Options{}); err != nil || calls.Load() != 2 {
		t.Fatalf("err %v after %d calls", err, calls.Load())
	}
	if elapsed := time.Since(start); elapsed < time.Second {
		t.Fatalf("retried after %v, before Retry-After", elapsed)
	}

	// A Retry-After too long to wait out inside one request fails the call instead.
	c, calls = flakyLLM(t, []int{429}, http.Header{"Retry-After": {"3600"}})
	if _, err := c.Generate(context.Background(), nil, true, Options{}); err == nil || calls.Load() != 1 {
		t.Fatalf("err %v after %d calls", err, calls.Load())
	}
}

func TestGenerateSkipsRetryThatWouldMissTheDeadline(t *testing.T) {
	c, calls := flakyLLM(t, []int{503}, nil)
	ctx, cancel := context.WithTimeout(context.Background(), minAttemptBudget/2)
	defer cancel()
	if _, err := c.Generate(ctx, nil, true, Options{}); err == nil || calls.Load() != 1 {
		t.Fatalf("err %v after %d calls", err, calls.Load())
	}
}

func TestGenerateRetriesTransportErrors(t *testing.T) {
	llm := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	url := llm.URL
	llm.Close() // connection refused from now on
	c := NewClient(url, "key", "m", nil, slog.New(slog.DiscardHandler))
	c.baseBackoff = time.Millisecond
	_, err := c.Generate(context.Background(), nil, true, Options{})
	var transportErr *transportError
	if !errors.As(err, &transportErr) {
		t.Fatalf("want transport error, got %v", err)
	}
}

func TestParseRetryAfter(t *testing.T) {
	future := time.Now().Add(90 * time.Second).UTC().Format(http.TimeFormat)
	for header, want := range map[string]time.Duration{"": 0, "5": 5 * time.Second, "-3": 0, "junk": 0} {
		if got := parseRetryAfter(header); got != want {
			t.Errorf("parseRetryAfter(%q) = %v, want %v", header, got, want)
		}
	}
	if got := parseRetryAfter(future); got < 80*time.Second || got > 90*time.Second {
		t.Errorf("parseRetryAfter(date) = %v", got)
	}
}
