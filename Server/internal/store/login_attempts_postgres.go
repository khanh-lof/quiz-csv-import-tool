package store

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// PostgresLoginAttempts keeps one row per key: how many attempts its window has counted and when it started.
type PostgresLoginAttempts struct {
	pool *pgxpool.Pool
	now  func() time.Time
}

func NewPostgresLoginAttempts(pool *pgxpool.Pool) *PostgresLoginAttempts {
	return &PostgresLoginAttempts{pool: pool, now: time.Now}
}

// TryConsume counts the attempt in one statement: it starts a window when none is running (no row, or an
// ended one) and counts in the running one while it has room. A full window makes the update skip the row, so
// nothing is returned and the window's end is read instead. The ended windows of other keys are dropped first.
func (p *PostgresLoginAttempts) TryConsume(ctx context.Context, key string, limit int, window time.Duration) (time.Time, bool, error) {
	now := storedTime(p.now())
	windowStartedAfter := now.Add(-window)
	if _, err := p.pool.Exec(ctx, `DELETE FROM login_attempts WHERE expires_at <= $1 AND key <> $2`, now, key); err != nil {
		return time.Time{}, false, err
	}

	var counted int
	err := p.pool.QueryRow(ctx, `INSERT INTO login_attempts AS a (key, count, window_start, expires_at)
		VALUES ($1, 1, $2, $3)
		ON CONFLICT (key) DO UPDATE SET
			count = CASE WHEN a.window_start <= $4 THEN 1 ELSE a.count + 1 END,
			window_start = CASE WHEN a.window_start <= $4 THEN $2 ELSE a.window_start END,
			expires_at = CASE WHEN a.window_start <= $4 THEN $3 ELSE a.expires_at END
		WHERE a.window_start <= $4 OR a.count < $5
		RETURNING count`, key, now, now.Add(window), windowStartedAfter, limit).Scan(&counted)
	if err == nil {
		return time.Time{}, true, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return time.Time{}, false, err
	}

	var windowStart time.Time
	if err := p.pool.QueryRow(ctx, `SELECT window_start FROM login_attempts WHERE key = $1`, key).Scan(&windowStart); err != nil {
		return time.Time{}, false, err
	}
	return windowStart.Add(window), false, nil
}

func (p *PostgresLoginAttempts) Reset(ctx context.Context, key string) error {
	_, err := p.pool.Exec(ctx, `DELETE FROM login_attempts WHERE key = $1`, key)
	return err
}
