package store

import (
	"context"
	"errors"
	"fmt"
	"os"
	"sync"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// Integration tests against a real MongoDB; skipped unless MONGODB_TEST_URI is set, e.g.
// MONGODB_TEST_URI=mongodb://localhost:27017 go test ./internal/store/
func newTestMongo(t *testing.T) (*Mongo, *mongo.Collection) {
	t.Helper()
	uri := os.Getenv("MONGODB_TEST_URI")
	if uri == "" {
		t.Skip("MONGODB_TEST_URI not set")
	}
	client, err := mongo.Connect(options.Client().ApplyURI(uri))
	if err != nil {
		t.Fatal(err)
	}
	db := client.Database(fmt.Sprintf("quiztool_test_%d", time.Now().UnixNano()))
	t.Cleanup(func() {
		_ = db.Drop(context.Background())
		_ = client.Disconnect(context.Background())
	})
	coll := db.Collection("Users")
	m := NewMongo(coll)
	if err := m.EnsureIndexes(context.Background()); err != nil {
		t.Fatal(err)
	}
	return m, coll
}

func TestMongoCreateAndFind(t *testing.T) {
	ctx := context.Background()
	m, coll := newTestMongo(t)

	created := time.Date(2025, 8, 14, 10, 0, 0, 0, time.UTC)
	if err := m.Create(ctx, &User{Username: "alice", PasswordHash: "h", CreatedAt: created}); err != nil {
		t.Fatal(err)
	}
	if err := m.Create(ctx, &User{Username: "alice", PasswordHash: "h2"}); !errors.Is(err, ErrDuplicate) {
		t.Fatalf("want ErrDuplicate, got %v", err)
	}

	u, err := m.FindByUsername(ctx, "alice")
	if err != nil || u.PasswordHash != "h" || !u.CreatedAt.Equal(created) || u.Roles == nil || u.StartRoundTime != nil {
		t.Fatalf("FindByUsername: %+v %v", u, err)
	}
	if _, err := m.FindByUsername(ctx, "bob"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("want ErrNotFound, got %v", err)
	}

	var raw bson.M
	_ = coll.FindOne(ctx, bson.M{"_id": "alice"}).Decode(&raw)
	for _, field := range []string{"passwordHash", "roles", "createdAt", "refreshTokens", "aiCallCountInRound", "version"} {
		if _, ok := raw[field]; !ok {
			t.Errorf("stored document lacks %q: %v", field, raw)
		}
	}
}

func TestMongoRefreshTokens(t *testing.T) {
	ctx := context.Background()
	m, coll := newTestMongo(t)
	_ = m.Create(ctx, &User{Username: "alice", PasswordHash: "h"})

	add := func(token string) func([]RefreshToken) ([]RefreshToken, bool) {
		return func(ts []RefreshToken) ([]RefreshToken, bool) {
			return append(ts, RefreshToken{Token: token, ExpiresAt: time.Now().Add(time.Hour), CreatedAt: time.Now()}), true
		}
	}
	if err := m.UpdateRefreshTokens(ctx, "alice", add("t1")); err != nil {
		t.Fatal(err)
	}
	u, err := m.FindByRefreshToken(ctx, "t1")
	if err != nil || u.Username != "alice" || u.Version != 1 {
		t.Fatalf("FindByRefreshToken: %+v %v", u, err)
	}
	if _, err := m.FindByRefreshToken(ctx, "nope"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("want ErrNotFound, got %v", err)
	}
	if err := m.UpdateRefreshTokens(ctx, "bob", add("x")); !errors.Is(err, ErrNotFound) {
		t.Fatalf("want ErrNotFound for missing user, got %v", err)
	}

	// Skipped writes leave the version alone.
	_ = m.UpdateRefreshTokens(ctx, "alice", func(ts []RefreshToken) ([]RefreshToken, bool) { return ts, false })
	if u, _ := m.FindByUsername(ctx, "alice"); u.Version != 1 {
		t.Fatalf("version bumped by a skipped write: %d", u.Version)
	}

	// Documents imported without a version field still update.
	_, _ = coll.InsertOne(ctx, bson.M{"_id": "legacy", "passwordHash": "h"})
	if err := m.UpdateRefreshTokens(ctx, "legacy", add("t2")); err != nil {
		t.Fatalf("legacy document: %v", err)
	}

	// Clearing stores an empty array, not null.
	_ = m.UpdateRefreshTokens(ctx, "alice", func([]RefreshToken) ([]RefreshToken, bool) { return nil, true })
	var raw bson.M
	_ = coll.FindOne(ctx, bson.M{"_id": "alice"}).Decode(&raw)
	if arr, ok := raw["refreshTokens"].(bson.A); !ok || len(arr) != 0 {
		t.Fatalf("refreshTokens = %#v", raw["refreshTokens"])
	}
}

func TestMongoConcurrentTokenUpdatesDoNotLoseWrites(t *testing.T) {
	ctx := context.Background()
	m, _ := newTestMongo(t)
	_ = m.Create(ctx, &User{Username: "alice", PasswordHash: "h"})

	const writers = 4
	var wg sync.WaitGroup
	errs := make(chan error, writers)
	for i := range writers {
		wg.Go(func() {
			errs <- m.UpdateRefreshTokens(ctx, "alice", func(ts []RefreshToken) ([]RefreshToken, bool) {
				return append(ts, RefreshToken{Token: fmt.Sprint("t", i), ExpiresAt: time.Now().Add(time.Hour)}), true
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
	if u, _ := m.FindByUsername(ctx, "alice"); len(u.RefreshTokens) != writers {
		t.Fatalf("want %d tokens, got %d", writers, len(u.RefreshTokens))
	}
}

func TestMongoTryConsumeAICall(t *testing.T) {
	ctx := context.Background()
	m, _ := newTestMongo(t)
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

func TestMongoRefundAICall(t *testing.T) {
	ctx := context.Background()
	m, _ := newTestMongo(t)
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
