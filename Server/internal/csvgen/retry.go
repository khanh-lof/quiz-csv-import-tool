package csvgen

import (
	"context"
	"errors"
	"fmt"
	"math/rand/v2"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// Bounded retry of transient LLM failures, following DeepSeek's error codes
// (https://api-docs.deepseek.com/quick_start/error_codes): 429 (rate or concurrency limit), 500 (server
// error) and 503 (overloaded) are retried, as are 502/504 from the proxy in front of it and transport
// failures, with exponential backoff and jitter, honouring Retry-After. Every other status (400, 401,
// 402 insufficient balance, 422, ...) means the request, the key or the balance must change first.
//
// DeepSeek keeps a waiting non-streaming request alive with blank lines
// (https://api-docs.deepseek.com/quick_start/rate_limit), which commits the answer to 200 before the
// generation starts, so a failure on its side during the generation shows in the body instead: a chat
// completion that finished with insufficient_system_resource or aborted, a response whose status is
// failed, or a body of nothing but the blank lines. Those are retried too (interruptedError).
//
// All attempts share the caller's deadline (LLM_TIMEOUT_SECONDS, under Vercel's function limit), so
// retrying never keeps the function alive longer; a retry is skipped when too little time is left
// for it to finish. A call that used up the whole deadline is not retried: the client does not
// re-send either, so the user is told and submits again.
const (
	maxAttempts = 5
	// defaultBaseBackoff is the first wait, doubled per retry up to maxBackoff (before jitter): an
	// overload lasts longer than a blip, so the four retries are spread over about half a minute.
	defaultBaseBackoff = 2 * time.Second
	maxBackoff         = 20 * time.Second
	// maxRetryAfter is the longest Retry-After worth waiting for inside one request; a longer one
	// (e.g. a monthly limit) fails the call.
	maxRetryAfter = 30 * time.Second
	// minAttemptBudget is the least time left before the deadline worth starting another attempt
	// with: a generation takes tens of seconds, so a shorter attempt would only time out.
	minAttemptBudget = 30 * time.Second
)

// StatusError is a non-2xx answer from the LLM provider.
type StatusError struct {
	Status int
	// Code is the provider's error.code, when the body carried one.
	Code string
	// RetryAfter is the provider's Retry-After; zero when it sent none.
	RetryAfter time.Duration
}

func (e *StatusError) Error() string {
	if e.Code != "" {
		return fmt.Sprintf("LLM returned status %d (%s)", e.Status, e.Code)
	}
	return fmt.Sprintf("LLM returned status %d", e.Status)
}

// transportError is a failure to get any response at all (connection refused, reset, ...).
type transportError struct{ err error }

func (e *transportError) Error() string { return "calling LLM: " + e.err.Error() }
func (e *transportError) Unwrap() error { return e.err }

// interruptedError is a 2xx answer whose generation the provider broke off on its side, which another
// attempt can get through, unlike an answer the model itself cut short (its token cap, the content
// filter).
type interruptedError struct{ reason string }

func (e *interruptedError) Error() string { return "LLM generation interrupted: " + e.reason }

// withRetry runs attempt until it succeeds, fails for good, runs out of attempts, or the next try
// would not fit before ctx's deadline. It returns the last attempt's error.
func (c *Client) withRetry(ctx context.Context, path string, attempt func() (string, error)) (string, error) {
	for n := 0; ; n++ {
		content, err := attempt()
		if err == nil || ctx.Err() != nil || n+1 >= maxAttempts {
			return content, err
		}
		wait, retryable := c.retryDelay(err, n)
		if !retryable {
			return "", err
		}
		if deadline, ok := ctx.Deadline(); ok && time.Until(deadline) < wait+minAttemptBudget {
			return "", err
		}
		c.logger.Warn("retrying LLM call", "path", path, "attempt", n+2, "wait", wait, "error", err)
		timer := time.NewTimer(wait)
		select {
		case <-ctx.Done():
			timer.Stop()
			return "", err
		case <-timer.C:
		}
	}
}

// retryDelay reports whether err, from 0-based attempt n, is worth retrying, and how long to wait.
func (c *Client) retryDelay(err error, n int) (time.Duration, bool) {
	var statusErr *StatusError
	var transportErr *transportError
	var interruptedErr *interruptedError
	switch {
	case errors.As(err, &statusErr):
		switch statusErr.Status {
		case http.StatusTooManyRequests, http.StatusInternalServerError, http.StatusBadGateway,
			http.StatusServiceUnavailable, http.StatusGatewayTimeout:
		default:
			return 0, false
		}
		if statusErr.RetryAfter > maxRetryAfter {
			return 0, false
		}
		if statusErr.RetryAfter > 0 {
			return statusErr.RetryAfter + c.jitter(c.baseBackoff), true
		}
	case errors.As(err, &transportErr), errors.As(err, &interruptedErr):
	default:
		// Decoding failures and answers the model cut short would most likely fail the same way, and be
		// billed again.
		return 0, false
	}
	backoff := min(maxBackoff, c.baseBackoff<<n)
	return backoff + c.jitter(backoff), true
}

// jitter is a random extra wait of up to half of d, so jobs that failed together do not retry together.
func (c *Client) jitter(d time.Duration) time.Duration {
	return time.Duration(rand.Int64N(int64(d/2) + 1))
}

// parseRetryAfter reads a Retry-After header: delay seconds or an HTTP date.
func parseRetryAfter(header string) time.Duration {
	header = strings.TrimSpace(header)
	if header == "" {
		return 0
	}
	if secs, err := strconv.Atoi(header); err == nil {
		return max(0, time.Duration(secs)*time.Second)
	}
	if at, err := http.ParseTime(header); err == nil {
		return max(0, time.Until(at))
	}
	return 0
}
