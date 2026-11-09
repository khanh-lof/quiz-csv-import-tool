package csvgen

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func TestFailureCode(t *testing.T) {
	cases := []struct {
		err  error
		want string
	}{
		{&incompleteError{"length"}, FailureTruncated},
		{&incompleteError{"max_output_tokens"}, FailureTruncated},
		{&incompleteError{"content_filter"}, FailureFiltered},
		{&badOutputError{errors.New("not JSON")}, FailureBadOutput},
		{&StatusError{Status: http.StatusPaymentRequired}, FailureProviderConfig},
		{&StatusError{Status: http.StatusUnauthorized}, FailureProviderConfig},
		{&StatusError{Status: http.StatusServiceUnavailable}, FailureOverloaded},
		{&StatusError{Status: http.StatusTooManyRequests}, FailureOverloaded},
		{&StatusError{Status: http.StatusBadRequest}, FailureOther},
		{&transportError{errors.New("reset")}, FailureOverloaded},
		{&interruptedError{"aborted"}, FailureOverloaded},
		{fmt.Errorf("wrapped: %w", &incompleteError{"length"}), FailureTruncated},
		{errors.New("boom"), FailureOther},
	}
	for _, tc := range cases {
		if got := FailureCode(tc.err); got != tc.want {
			t.Errorf("FailureCode(%v) = %q, want %q", tc.err, got, tc.want)
		}
	}
}

func TestGenerateReportsUsageOverAllAttempts(t *testing.T) {
	var calls atomic.Int32
	llm := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if calls.Add(1) == 1 {
			_, _ = io.WriteString(w, `{"status":"failed","error":{"code":"x"},"usage":{"input_tokens":100,"output_tokens":5}}`)
			return
		}
		_, _ = io.WriteString(w, `{"status":"completed","usage":{"input_tokens":100,"output_tokens":20,"input_tokens_details":{"cached_tokens":80}},`+
			`"output":[{"type":"message","content":[{"type":"output_text","text":"\"a\",\"b\""}]}]}`)
	}))
	t.Cleanup(llm.Close)
	c := NewClient(llm.URL, "key", "m", "", 0, slog.New(slog.DiscardHandler))
	c.baseBackoff = time.Millisecond

	result, err := c.Generate(context.Background(), nil, true, Options{})
	want := Usage{Model: "m", Calls: 2, InputTokens: 200, CachedTokens: 80, OutputTokens: 25}
	if err != nil || result.CSV != `"a","b","","",""` || result.Usage != want {
		t.Fatalf("got %+v, %v; want usage %+v", result, err, want)
	}
}

func TestGenerateReportsUsageOfAFailureAndItsCode(t *testing.T) {
	llm := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `{"choices":[{"message":{"content":"a,"},"finish_reason":"length"}],`+
			`"usage":{"prompt_tokens":50,"completion_tokens":8000,"prompt_cache_hit_tokens":30}}`)
	}))
	t.Cleanup(llm.Close)
	c := NewClient(llm.URL, "key", "simple", "", 0, slog.New(slog.DiscardHandler))

	result, err := c.Generate(context.Background(), nil, false, Options{})
	want := Usage{Model: "simple", Calls: 1, InputTokens: 50, CachedTokens: 30, OutputTokens: 8000}
	if FailureCode(err) != FailureTruncated || result.Usage != want {
		t.Fatalf("got %+v, %v (%s); want usage %+v", result.Usage, err, FailureCode(err), want)
	}
}
