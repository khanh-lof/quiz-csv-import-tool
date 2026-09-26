// Package store persists QuizTool users. The only document type is User: credentials, active
// refresh tokens and AI rate-limit state all live in one document keyed by username.
package store

import (
	"context"
	"errors"
	"time"
)

var (
	ErrNotFound  = errors.New("user not found")
	ErrDuplicate = errors.New("user already exists")
	// ErrConflict means a read-modify-write kept losing to concurrent writers.
	ErrConflict = errors.New("too many concurrent updates")
)

type RefreshToken struct {
	Token     string    `bson:"token"`
	ExpiresAt time.Time `bson:"expiresAt"`
	CreatedAt time.Time `bson:"createdAt"`
}

type User struct {
	Username      string         `bson:"_id"`
	PasswordHash  string         `bson:"passwordHash"`
	Roles         []string       `bson:"roles"`
	CreatedAt     time.Time      `bson:"createdAt"`
	RefreshTokens []RefreshToken `bson:"refreshTokens"`

	AICallCountInRound int        `bson:"aiCallCountInRound"`
	StartRoundTime     *time.Time `bson:"startRoundTime,omitempty"`

	// Version guards refresh-token read-modify-writes (optimistic concurrency).
	Version int64 `bson:"version"`
}

// Users is implemented by Mongo (production) and Memory (tests).
type Users interface {
	FindByUsername(ctx context.Context, username string) (*User, error)
	FindByRefreshToken(ctx context.Context, token string) (*User, error)
	Create(ctx context.Context, user *User) error

	// UpdateRefreshTokens applies mutate to the user's current token list and stores the result,
	// re-reading and retrying when another writer got there first, so concurrent logins from two
	// devices cannot drop each other's tokens. mutate returns false to skip the write.
	UpdateRefreshTokens(ctx context.Context, username string,
		mutate func(tokens []RefreshToken) ([]RefreshToken, bool)) error

	// TryConsumeAICall atomically counts one AI call against the user's rate limit: at most limit
	// calls per round, a round starting with the first call after the previous one ended.
	// It returns the start of the round the call was counted in, and ok=false when the limit is
	// already reached.
	TryConsumeAICall(ctx context.Context, username string, limit int, round time.Duration) (roundStart time.Time, ok bool, err error)

	// RefundAICall gives back one call counted in the round that started at roundStart, so a failed
	// generation does not use up the user's quota (and the client can retry it). It does nothing
	// once a newer round has replaced that one.
	RefundAICall(ctx context.Context, username string, roundStart time.Time) error
}

const maxUpdateAttempts = 5
