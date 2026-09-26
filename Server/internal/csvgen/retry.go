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

// Bounded retry of gateway failures, following the gateway's policy
// (https://shineshop.dev/docs/errors/): retry only 429 and 502/503/504 (and transport failures),
// with exponential backoff and jitter, honouring Retry-After. Every other status means the request
// itself must change first.
//
// All attempts share the caller's deadline (LLM_TIMEOUT_SECONDS, under Vercel's function limit), so
// retrying never keeps the function alive longer; a retry is skipped when too little time is left
// for it to finish. A call that used up the whole deadline is retried by the client instead, as a
// new request with a fresh function budget.
const (
	maxAttempts        = 3
	defaultBaseBackoff = 500 * time.Millisecond
	maxBackoff         = 8 * time.Second
	// maxRetryAfter is the longest Retry-After worth waiting for inside one request; a longer one
	// (e.g. a monthly limit) fails the call.
	maxRetryAfter = 30 * time.Second
	// minAttemptBudget is the least time left before the deadline worth starting another attempt
	// with: a generation takes tens of seconds, so a shorter attempt would only time out.
	minAttemptBudget = 30 * time.Second
)

// StatusError is a non-2xx answer from the LLM gateway.
type StatusError struct {
	Status int
	// Code is the gateway's error.code, when the body carried one.
	Code string
	// RetryAfter is the gateway's Retry-After; zero when it sent none.
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

// withRetry runs attempt until it succeeds, fails for good, runs out of attempts, or the next try
// would not fit before ctx's deadline. It returns the last attempt's error.
func (c *Client) withRetry(ctx context.Context, path string, attempt func() ([]byte, error)) ([]byte, error) {
	for n := 0; ; n++ {
		body, err := attempt()
		if err == nil || ctx.Err() != nil || n+1 >= maxAttempts {
			return body, err
		}
		wait, retryable := c.retryDelay(err, n)
		if !retryable {
			return nil, err
		}
		if deadline, ok := ctx.Deadline(); ok && time.Until(deadline) < wait+minAttemptBudget {
			return nil, err
		}
		c.logger.Warn("retrying LLM call", "path", path, "attempt", n+2, "wait", wait, "error", err)
		timer := time.NewTimer(wait)
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil, err
		case <-timer.C:
		}
	}
}

// retryDelay reports whether err, from 0-based attempt n, is worth retrying, and how long to wait.
func (c *Client) retryDelay(err error, n int) (time.Duration, bool) {
	var statusErr *StatusError
	var transportErr *transportError
	switch {
	case errors.As(err, &statusErr):
		switch statusErr.Status {
		case http.StatusTooManyRequests, http.StatusBadGateway, http.StatusServiceUnavailable, http.StatusGatewayTimeout:
		default:
			return 0, false
		}
		if statusErr.RetryAfter > maxRetryAfter {
			return 0, false
		}
		if statusErr.RetryAfter > 0 {
			return statusErr.RetryAfter + c.jitter(), true
		}
	case errors.As(err, &transportErr):
	default:
		// Decoding failures and incomplete responses came with a 200: the same request would be
		// billed again and most likely fail the same way.
		return 0, false
	}
	return min(maxBackoff, c.baseBackoff<<n) + c.jitter(), true
}

func (c *Client) jitter() time.Duration {
	return time.Duration(rand.Int64N(int64(c.baseBackoff/2) + 1))
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
