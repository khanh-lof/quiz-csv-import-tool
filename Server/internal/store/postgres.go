package store

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed schema.sql
var schemaSQL string

// schemaLockID serialises Migrate across server instances starting at the same moment.
const schemaLockID = 7_201_455_380

// OpenPostgres connects to the database at url (a postgres:// URL or a key=value DSN) and checks that it answers.
// Every timestamptz is read back in UTC, as the memory stores keep them.
func OpenPostgres(ctx context.Context, url string) (*pgxpool.Pool, error) {
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		return nil, err
	}
	cfg.AfterConnect = func(_ context.Context, conn *pgx.Conn) error {
		conn.TypeMap().RegisterType(&pgtype.Type{
			Name: "timestamptz", OID: pgtype.TimestamptzOID, Codec: &pgtype.TimestamptzCodec{ScanLocation: time.UTC},
		})
		return nil
	}
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, err
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, err
	}
	return pool, nil
}

// Migrate creates the tables and indexes that are missing. Safe to call on every start.
func Migrate(ctx context.Context, pool *pgxpool.Pool) error {
	return pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock($1)", int64(schemaLockID)); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, schemaSQL)
		return err
	})
}

func isUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}

func notFound(err error) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	return err
}

// PostgresUsers keeps one row per user; the refresh tokens are JSONB arrays on it.
type PostgresUsers struct {
	pool *pgxpool.Pool
	now  func() time.Time
}

func NewPostgresUsers(pool *pgxpool.Pool) *PostgresUsers {
	return &PostgresUsers{pool: pool, now: time.Now}
}

const userColumns = `username, password_hash, roles, created_at, refresh_tokens, spent_refresh_tokens,
	ai_call_count_in_round, start_round_time, version`

func scanUser(row pgx.Row) (*User, error) {
	var u User
	err := row.Scan(&u.Username, &u.PasswordHash, &u.Roles, &u.CreatedAt, &u.RefreshTokens, &u.SpentRefreshTokens,
		&u.AICallCountInRound, &u.StartRoundTime, &u.Version)
	if err != nil {
		return nil, notFound(err)
	}
	if u.Roles == nil {
		u.Roles = []string{}
	}
	return &u, nil
}

func (p *PostgresUsers) FindByUsername(ctx context.Context, username string) (*User, error) {
	return scanUser(p.pool.QueryRow(ctx, `SELECT `+userColumns+` FROM users WHERE username = $1`, username))
}

func (p *PostgresUsers) FindByRefreshTokenHash(ctx context.Context, hash string) (*User, error) {
	match, err := json.Marshal([]map[string]string{{"tokenHash": hash}})
	if err != nil {
		return nil, err
	}
	return scanUser(p.pool.QueryRow(ctx, `SELECT `+userColumns+` FROM users
		WHERE refresh_tokens @> $1::jsonb OR spent_refresh_tokens @> $1::jsonb LIMIT 1`, string(match)))
}

func (p *PostgresUsers) Create(ctx context.Context, user *User) error {
	sessions := storedSessions(Sessions{Active: user.RefreshTokens, Spent: user.SpentRefreshTokens})
	roles := user.Roles
	if roles == nil {
		roles = []string{}
	}
	_, err := p.pool.Exec(ctx, `INSERT INTO users (`+userColumns+`) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
		user.Username, user.PasswordHash, roles, storedTime(user.CreatedAt), sessions.Active, sessions.Spent,
		user.AICallCountInRound, storedTimePtr(user.StartRoundTime), user.Version)
	if isUniqueViolation(err) {
		return ErrDuplicate
	}
	return err
}

// UpdateSessions locks the user's row for the read-modify-write, so concurrent logins or refreshes wait for
// each other instead of overwriting each other's tokens; mutate runs once.
func (p *PostgresUsers) UpdateSessions(ctx context.Context, username string, mutate func(*Sessions) bool) error {
	return pgx.BeginFunc(ctx, p.pool, func(tx pgx.Tx) error {
		var s Sessions
		err := tx.QueryRow(ctx, `SELECT refresh_tokens, spent_refresh_tokens FROM users WHERE username = $1 FOR UPDATE`,
			username).Scan(&s.Active, &s.Spent)
		if err != nil {
			return notFound(err)
		}
		if !mutate(&s) {
			return nil
		}
		s = storedSessions(s)
		_, err = tx.Exec(ctx, `UPDATE users SET refresh_tokens = $2, spent_refresh_tokens = $3, version = version + 1
			WHERE username = $1`, username, s.Active, s.Spent)
		return err
	})
}

// storedSessions copies the sessions with their times in UTC milliseconds and empty lists as [], not null.
func storedSessions(s Sessions) Sessions {
	active := make([]RefreshToken, len(s.Active))
	for i, t := range s.Active {
		t.ExpiresAt, t.CreatedAt = storedTime(t.ExpiresAt), storedTime(t.CreatedAt)
		active[i] = t
	}
	spent := make([]SpentRefreshToken, len(s.Spent))
	for i, t := range s.Spent {
		t.SpentAt, t.ExpiresAt = storedTime(t.SpentAt), storedTime(t.ExpiresAt)
		spent[i] = t
	}
	return Sessions{Active: active, Spent: spent}
}

// TryConsumeAICall counts the call and starts a new round when none is running, in one statement, so two
// calls at the same moment cannot both take the last place in a round.
func (p *PostgresUsers) TryConsumeAICall(ctx context.Context, username string, limit int, round time.Duration) (time.Time, bool, error) {
	now := storedTime(p.now())
	roundStartedAfter := now.Add(-round)
	var roundStart time.Time
	err := p.pool.QueryRow(ctx, `UPDATE users SET
			ai_call_count_in_round = CASE WHEN start_round_time > $2 THEN ai_call_count_in_round + 1 ELSE 1 END,
			start_round_time = CASE WHEN start_round_time > $2 THEN start_round_time ELSE $3 END
		WHERE username = $1 AND (start_round_time IS NULL OR start_round_time <= $2 OR ai_call_count_in_round < $4)
		RETURNING start_round_time`, username, roundStartedAfter, now, limit).Scan(&roundStart)
	if errors.Is(err, pgx.ErrNoRows) {
		return time.Time{}, false, nil
	}
	if err != nil {
		return time.Time{}, false, err
	}
	return roundStart, true, nil
}

func (p *PostgresUsers) RefundAICall(ctx context.Context, username string, roundStart time.Time) error {
	_, err := p.pool.Exec(ctx, `UPDATE users SET ai_call_count_in_round = ai_call_count_in_round - 1
		WHERE username = $1 AND start_round_time = $2 AND ai_call_count_in_round > 0`, username, storedTime(roundStart))
	return err
}

// checkOne turns an update or delete that matched no row into ErrNotFound.
func checkOne(tag pgconn.CommandTag, err error) error {
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}
