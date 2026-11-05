package store

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// newTestPool connects to the database of POSTGRES_TEST_URL, in a schema of the test's own that is dropped
// afterwards, with the tables of Migrate. It skips the test when the variable is not set, e.g.
// POSTGRES_TEST_URL=postgres://quiz:quiz@localhost:5432/quiz go test ./internal/store/
func newTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	base := os.Getenv("POSTGRES_TEST_URL")
	if base == "" {
		t.Skip("POSTGRES_TEST_URL not set")
	}
	ctx := context.Background()
	schema := fmt.Sprintf("quiztool_test_%d", time.Now().UnixNano())
	admin, err := pgx.Connect(ctx, base)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+schema); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = admin.Exec(context.Background(), "DROP SCHEMA "+schema+" CASCADE")
		_ = admin.Close(context.Background())
	})

	u, err := url.Parse(base)
	if err != nil {
		t.Fatal(err)
	}
	q := u.Query()
	q.Set("search_path", schema)
	u.RawQuery = q.Encode()
	pool, err := OpenPostgres(ctx, u.String())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if err := Migrate(ctx, pool); err != nil {
		t.Fatal(err)
	}
	// Migrate runs on every start, so a second run must change nothing and fail on nothing.
	if err := Migrate(ctx, pool); err != nil {
		t.Fatalf("second Migrate: %v", err)
	}
	return pool
}

func TestPostgresUsersCreateAndFind(t *testing.T) {
	ctx := context.Background()
	m := NewPostgresUsers(newTestPool(t))

	created := time.Date(2025, 8, 14, 10, 0, 0, 0, time.UTC)
	if err := m.Create(ctx, &User{Username: "alice", PasswordHash: "h", CreatedAt: created}); err != nil {
		t.Fatal(err)
	}
	if err := m.Create(ctx, &User{Username: "alice", PasswordHash: "h2"}); !errors.Is(err, ErrDuplicate) {
		t.Fatalf("want ErrDuplicate, got %v", err)
	}

	u, err := m.FindByUsername(ctx, "alice")
	if err != nil || u.PasswordHash != "h" || !u.CreatedAt.Equal(created) || u.CreatedAt.Location() != time.UTC ||
		u.Roles == nil || u.StartRoundTime != nil || u.RefreshTokens == nil || u.SpentRefreshTokens == nil {
		t.Fatalf("FindByUsername: %+v %v", u, err)
	}
	if _, err := m.FindByUsername(ctx, "bob"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("want ErrNotFound, got %v", err)
	}
}

func TestPostgresUsersRefreshTokens(t *testing.T) {
	ctx := context.Background()
	pool := newTestPool(t)
	m := NewPostgresUsers(pool)
	_ = m.Create(ctx, &User{Username: "alice", PasswordHash: "h"})

	add := func(hash string) func(*Sessions) bool {
		return func(s *Sessions) bool {
			s.Active = append(s.Active, RefreshToken{Hash: hash, ExpiresAt: time.Now().Add(time.Hour), CreatedAt: time.Now()})
			return true
		}
	}
	if err := m.UpdateSessions(ctx, "alice", add("t1")); err != nil {
		t.Fatal(err)
	}
	u, err := m.FindByRefreshTokenHash(ctx, "t1")
	if err != nil || u.Username != "alice" || u.Version != 1 || len(u.RefreshTokens) != 1 ||
		u.RefreshTokens[0].ExpiresAt.Location() != time.UTC {
		t.Fatalf("FindByRefreshTokenHash: %+v %v", u, err)
	}
	if _, err := m.FindByRefreshTokenHash(ctx, "nope"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("want ErrNotFound, got %v", err)
	}
	if err := m.UpdateSessions(ctx, "bob", add("x")); !errors.Is(err, ErrNotFound) {
		t.Fatalf("want ErrNotFound for missing user, got %v", err)
	}

	// Skipped writes leave the version alone.
	_ = m.UpdateSessions(ctx, "alice", func(*Sessions) bool { return false })
	if u, _ := m.FindByUsername(ctx, "alice"); u.Version != 1 {
		t.Fatalf("version bumped by a skipped write: %d", u.Version)
	}

	// Spent tokens are found too.
	_ = m.UpdateSessions(ctx, "alice", func(s *Sessions) bool {
		s.Spent = append(s.Spent, SpentRefreshToken{Hash: "old", SpentAt: time.Now(), ExpiresAt: time.Now().Add(time.Hour)})
		return true
	})
	if u, err := m.FindByRefreshTokenHash(ctx, "old"); err != nil || u.Username != "alice" || len(u.SpentRefreshTokens) != 1 {
		t.Fatalf("FindByRefreshTokenHash(spent): %+v %v", u, err)
	}

	// Clearing stores empty arrays, not null.
	_ = m.UpdateSessions(ctx, "alice", func(s *Sessions) bool { *s = Sessions{}; return true })
	var active, spent string
	if err := pool.QueryRow(ctx, `SELECT refresh_tokens::text, spent_refresh_tokens::text FROM users WHERE username = 'alice'`).
		Scan(&active, &spent); err != nil || active != "[]" || spent != "[]" {
		t.Fatalf("cleared sessions stored as %q and %q (%v)", active, spent, err)
	}
}

func TestPostgresConcurrentTokenUpdatesDoNotLoseWrites(t *testing.T) {
	ctx := context.Background()
	m := NewPostgresUsers(newTestPool(t))
	_ = m.Create(ctx, &User{Username: "alice", PasswordHash: "h"})

	const writers = 8
	var wg sync.WaitGroup
	errs := make(chan error, writers)
	for i := range writers {
		wg.Go(func() {
			errs <- m.UpdateSessions(ctx, "alice", func(s *Sessions) bool {
				s.Active = append(s.Active, RefreshToken{Hash: fmt.Sprint("t", i), ExpiresAt: time.Now().Add(time.Hour)})
				return true
			})
		})
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	if u, _ := m.FindByUsername(ctx, "alice"); len(u.RefreshTokens) != writers || u.Version != writers {
		t.Fatalf("want %d tokens and version %d, got %d and %d", writers, writers, len(u.RefreshTokens), u.Version)
	}
}

func TestPostgresTryConsumeAICall(t *testing.T) {
	ctx := context.Background()
	m := NewPostgresUsers(newTestPool(t))
	_ = m.Create(ctx, &User{Username: "alice", PasswordHash: "h"})
	now := time.Now()
	m.now = func() time.Time { return now }

	for i := range 2 {
		if _, ok, err := m.TryConsumeAICall(ctx, "alice", 2, time.Minute); !ok || err != nil {
			t.Fatalf("call %d: %v %v", i+1, ok, err)
		}
	}
	if _, ok, _ := m.TryConsumeAICall(ctx, "alice", 2, time.Minute); ok {
		t.Fatal("third call in the round allowed")
	}
	now = now.Add(61 * time.Second)
	if _, ok, _ := m.TryConsumeAICall(ctx, "alice", 2, time.Minute); !ok {
		t.Fatal("call in a new round rejected")
	}
	if u, _ := m.FindByUsername(ctx, "alice"); u.AICallCountInRound != 1 || u.StartRoundTime == nil {
		t.Fatalf("round not restarted: %+v", u)
	}
	if _, ok, _ := m.TryConsumeAICall(ctx, "bob", 2, time.Minute); ok {
		t.Fatal("unknown user allowed")
	}
}

// Many calls at the same moment still count each one once: no more than the limit get through.
func TestPostgresTryConsumeAICallConcurrently(t *testing.T) {
	ctx := context.Background()
	m := NewPostgresUsers(newTestPool(t))
	_ = m.Create(ctx, &User{Username: "alice", PasswordHash: "h"})

	const callers, limit = 10, 3
	var wg sync.WaitGroup
	var mu sync.Mutex
	allowed := 0
	for range callers {
		wg.Go(func() {
			_, ok, err := m.TryConsumeAICall(ctx, "alice", limit, time.Minute)
			if err != nil {
				t.Error(err)
			}
			if ok {
				mu.Lock()
				allowed++
				mu.Unlock()
			}
		})
	}
	wg.Wait()
	if allowed != limit {
		t.Fatalf("%d calls allowed, want %d", allowed, limit)
	}
}

func TestPostgresRefundAICall(t *testing.T) {
	ctx := context.Background()
	m := NewPostgresUsers(newTestPool(t))
	_ = m.Create(ctx, &User{Username: "alice", PasswordHash: "h"})
	now := time.Now()
	m.now = func() time.Time { return now }

	first, _, _ := m.TryConsumeAICall(ctx, "alice", 2, time.Minute)
	second, _, _ := m.TryConsumeAICall(ctx, "alice", 2, time.Minute)
	if !first.Equal(second) {
		t.Fatalf("round start changed within a round: %v vs %v", first, second)
	}
	if err := m.RefundAICall(ctx, "alice", second); err != nil {
		t.Fatal(err)
	}
	if _, ok, _ := m.TryConsumeAICall(ctx, "alice", 2, time.Minute); !ok {
		t.Fatal("refunded call not available again")
	}

	// A refund for a round that has since been replaced leaves the new round alone.
	now = now.Add(61 * time.Second)
	_, _, _ = m.TryConsumeAICall(ctx, "alice", 2, time.Minute)
	_ = m.RefundAICall(ctx, "alice", first)
	if u, _ := m.FindByUsername(ctx, "alice"); u.AICallCountInRound != 1 {
		t.Fatalf("stale refund changed the new round: %+v", u)
	}
}
