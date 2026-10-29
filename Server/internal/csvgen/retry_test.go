package csvgen

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
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
	for _, status := range []int{http.StatusTooManyRequests, http.StatusInternalServerError, http.StatusBadGateway,
		http.StatusServiceUnavailable, http.StatusGatewayTimeout} {
		c, calls := flakyLLM(t, []int{status, status}, nil)
		got, err := c.Generate(context.Background(), nil, true, Options{})
		if err != nil || got != "a,b" || calls.Load() != 3 {
			t.Errorf("status %d: got %q, %v after %d calls", status, got, err, calls.Load())
		}
	}
}

func TestGenerateGivesUpAfterMaxAttempts(t *testing.T) {
	statuses := make([]int, maxAttempts)
	for i := range statuses {
		statuses[i] = http.StatusServiceUnavailable
	}
	c, calls := flakyLLM(t, statuses, nil)
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
	for _, status := range []int{400, 401, 402, 403, 404, 413, 422} {
		c, calls := flakyLLM(t, []int{status}, nil)
		if _, err := c.Generate(context.Background(), nil, true, Options{}); err == nil || calls.Load() != 1 {
			t.Errorf("status %d: err %v after %d calls", status, err, calls.Load())
		}
	}
}

// answeringLLM answers 200 with bodies in turn, repeating the last one.
func answeringLLM(t *testing.T, bodies ...string) (*Client, *atomic.Int32) {
	t.Helper()
	var calls atomic.Int32
	llm := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		n := min(int(calls.Add(1)), len(bodies))
		_, _ = w.Write([]byte(bodies[n-1]))
	}))
	t.Cleanup(llm.Close)
	c := NewClient(llm.URL, "key", "m", nil, slog.New(slog.DiscardHandler))
	c.baseBackoff = time.Millisecond
	return c, &calls
}

func TestGenerateRetriesInterruptedGenerations(t *testing.T) {
	const okCompletion = `{"choices":[{"message":{"content":"a,b"},"finish_reason":"stop"}]}`
	cases := map[string]struct {
		creative          bool
		interrupted, done string
	}{
		"insufficient resource": {false, `{"choices":[{"message":{"content":"a,"},"finish_reason":"insufficient_system_resource"}]}`, okCompletion},
		"aborted":               {false, `{"choices":[{"message":{"content":""},"finish_reason":"aborted"}]}`, okCompletion},
		"response failed":       {true, `{"status":"failed","error":{"code":"server_error","message":"boom"},"output":[]}`, okResponse},
		"keep-alive only":       {true, "\n\n\n", "\n\n" + okResponse},
	}
	for name, tc := range cases {
		c, calls := answeringLLM(t, tc.interrupted, tc.done)
		got, err := c.Generate(context.Background(), nil, tc.creative, Options{})
		if err != nil || got != "a,b" || calls.Load() != 2 {
			t.Errorf("%s: got %q, %v after %d calls", name, got, err, calls.Load())
		}
	}
}

func TestGenerateDoesNotRetryTruncatedCompletions(t *testing.T) {
	for _, reason := range []string{"length", "content_filter"} {
		c, calls := answeringLLM(t, `{"choices":[{"message":{"content":"a,"},"finish_reason":"`+reason+`"}]}`)
		_, err := c.Generate(context.Background(), nil, false, Options{})
		if err == nil || !strings.Contains(err.Error(), reason) || calls.Load() != 1 {
			t.Errorf("%s: err %v after %d calls", reason, err, calls.Load())
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
