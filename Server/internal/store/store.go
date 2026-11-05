// Package store persists QuizTool's users, AI jobs, assignments and login attempts in PostgreSQL (the
// Postgres* types) or in memory for tests (the Memory* types). The bson tags are only read by
// cmd/migrate-mongo, which copies the data of the MongoDB the server used before; the json tags name the
// fields of the values kept as JSONB.
package store

import (
	"context"
	"errors"
	"time"
)

var (
	// ErrNotFound and ErrDuplicate are shared by every store: users, jobs, assignments and players.
	ErrNotFound  = errors.New("not found")
	ErrDuplicate = errors.New("already exists")
)

// RefreshToken is one device's active session. Only a hash of the token is stored, so reading the
// database does not hand out sessions.
type RefreshToken struct {
	Hash      string    `bson:"tokenHash" json:"tokenHash"`
	ExpiresAt time.Time `bson:"expiresAt" json:"expiresAt"`
	CreatedAt time.Time `bson:"createdAt" json:"createdAt"`
}

// SpentRefreshToken remembers a token that was rotated away, so presenting it again can be
// recognised as reuse (a sign it was stolen) rather than an unknown token.
type SpentRefreshToken struct {
	Hash      string    `bson:"tokenHash" json:"tokenHash"`
	SpentAt   time.Time `bson:"spentAt" json:"spentAt"`
	ExpiresAt time.Time `bson:"expiresAt" json:"expiresAt"`
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

	// Version counts the session writes.
	Version int64 `bson:"version"`
}

// Users is implemented by PostgresUsers (production) and Memory (tests).
type Users interface {
	FindByUsername(ctx context.Context, username string) (*User, error)
	// FindByRefreshTokenHash finds the user holding hash as an active or a spent refresh token.
	FindByRefreshTokenHash(ctx context.Context, hash string) (*User, error)
	Create(ctx context.Context, user *User) error

	// UpdateSessions applies mutate to the user's current sessions and stores the result, one writer at
	// a time, so concurrent logins or refreshes cannot drop or double-spend each other's tokens. mutate
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
