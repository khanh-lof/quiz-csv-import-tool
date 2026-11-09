package csvgen

import (
	"errors"
	"net/http"
)

// Failure codes say why a generation failed. They are stored on the job and the client words its message by
// them, so they are a contract: never rename one.
const (
	// FailureTruncated: the answer hit the model's output cap; fewer questions or lessons would fit.
	FailureTruncated = "truncated"
	// FailureFiltered: the provider's content filter stopped the answer.
	FailureFiltered = "filtered"
	// FailureProviderConfig: the provider refused the key, the balance or the model; only the admin can fix it.
	FailureProviderConfig = "provider_config"
	// FailureOverloaded: the provider stayed busy or unreachable through every attempt; later may work.
	FailureOverloaded = "overloaded"
	// FailureBadOutput: the answer was not in the format asked for.
	FailureBadOutput = "bad_output"
	// FailureOther is anything else.
	FailureOther = "failed"
)

// incompleteError is an answer the model itself cut short (its output cap, the content filter), which another
// attempt would most likely cut short again.
type incompleteError struct{ reason string }

func (e *incompleteError) Error() string { return "LLM response is incomplete: " + e.reason }

// badOutputError is an answer that could not be read as what was asked for.
type badOutputError struct{ err error }

func (e *badOutputError) Error() string { return e.err.Error() }
func (e *badOutputError) Unwrap() error { return e.err }

// BadOutput marks err as an answer that could not be made into what was asked for, the FailureBadOutput of a
// generation, for the packages that build quizzes from the model's answers (package bank).
func BadOutput(err error) error { return &badOutputError{err} }

// FailureCode returns the Failure* code for an error from Generate. A deadline is the caller's to recognise.
func FailureCode(err error) string {
	var (
		incomplete  *incompleteError
		badOutput   *badOutputError
		status      *StatusError
		transport   *transportError
		interrupted *interruptedError
	)
	switch {
	case errors.As(err, &incomplete):
		if incomplete.reason == "content_filter" {
			return FailureFiltered
		}
		return FailureTruncated
	case errors.As(err, &badOutput):
		return FailureBadOutput
	case errors.As(err, &status):
		switch status.Status {
		case http.StatusUnauthorized, http.StatusPaymentRequired, http.StatusForbidden, http.StatusNotFound:
			return FailureProviderConfig
		case http.StatusTooManyRequests, http.StatusInternalServerError, http.StatusBadGateway,
			http.StatusServiceUnavailable, http.StatusGatewayTimeout:
			return FailureOverloaded
		}
		return FailureOther
	case errors.As(err, &transport), errors.As(err, &interrupted):
		return FailureOverloaded
	}
	return FailureOther
}
