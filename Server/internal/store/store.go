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

// RefreshToken is one device's active session. Only a hash of the token is stored, so reading the
// database does not hand out sessions.
type RefreshToken struct {
	Hash      string    `bson:"tokenHash"`
	ExpiresAt time.Time `bson:"expiresAt"`
	CreatedAt time.Time `bson:"createdAt"`
}

// SpentRefreshToken remembers a token that was rotated away, so presenting it again can be
// recognised as reuse (a sign it was stolen) rather than an unknown token.
type SpentRefreshToken struct {
	Hash      string    `bson:"tokenHash"`
	SpentAt   time.Time `bson:"spentAt"`
	ExpiresAt time.Time `bson:"expiresAt"`
}

// Sessions is a user's refresh-token state, read and written as a unit by UpdateSessions.
type Sessions struct {
	Active []RefreshToken      `bson:"refreshTokens"`
	Spent  []SpentRefreshToken `bson:"spentRefreshTokens"`
}

type User struct {
	Username      string         `bson:"_id"`
	PasswordHash  string         `bson:"passwordHash"`
	Roles         []string       `bson:"roles"`
	CreatedAt     time.Time      `bson:"createdAt"`
	RefreshTokens []RefreshToken `bson:"refreshTokens"`

	SpentRefreshTokens []SpentRefreshToken `bson:"spentRefreshTokens"`

	AICallCountInRound int        `bson:"aiCallCountInRound"`
	StartRoundTime     *time.Time `bson:"startRoundTime,omitempty"`

	// Version guards session read-modify-writes (optimistic concurrency).
	Version int64 `bson:"version"`
}

// Users is implemented by Mongo (production) and Memory (tests).
type Users interface {
	FindByUsername(ctx context.Context, username string) (*User, error)
	// FindByRefreshTokenHash finds the user holding hash as an active or a spent refresh token.
	FindByRefreshTokenHash(ctx context.Context, hash string) (*User, error)
	Create(ctx context.Context, user *User) error

	// UpdateSessions applies mutate to the user's current sessions and stores the result,
	// re-reading and retrying when another writer got there first, so concurrent logins or
	// refreshes cannot drop or double-spend each other's tokens. mutate may run more than once and
	// returns false to skip the write.
	UpdateSessions(ctx context.Context, username string, mutate func(s *Sessions) bool) error

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
