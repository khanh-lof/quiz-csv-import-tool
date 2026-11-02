package store

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

func TestMemoryLoginAttempts(t *testing.T) {
	m := NewMemoryLoginAttempts()
	clock := time.Now().UTC().Truncate(time.Millisecond)
	m.Now = func() time.Time { return clock }
	testLoginAttempts(t, m, func() time.Time { return clock }, func(d time.Duration) { clock = clock.Add(d) })
}

func TestMongoLoginAttempts(t *testing.T) {
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
	m := NewMongoLoginAttempts(db.Collection("LoginAttempts"))
	if err := m.EnsureIndexes(context.Background()); err != nil {
		t.Fatal(err)
	}
	clock := time.Now().UTC().Truncate(time.Millisecond)
	m.now = func() time.Time { return clock }
	testLoginAttempts(t, m, func() time.Time { return clock }, func(d time.Duration) { clock = clock.Add(d) })
}

func testLoginAttempts(t *testing.T, attempts LoginAttempts, now func() time.Time, advance func(time.Duration)) {
	ctx := context.Background()
	const limit, window = 2, 10 * time.Minute
	consume := func(key string) (time.Time, bool) {
		t.Helper()
		retryAt, ok, err := attempts.TryConsume(ctx, key, limit, window)
		if err != nil {
			t.Fatal(err)
		}
		return retryAt, ok
	}

	windowStart := now()
	if _, ok := consume("a"); !ok {
		t.Fatal("first attempt refused")
	}
	advance(4 * time.Minute)
	if _, ok := consume("a"); !ok {
		t.Fatal("second attempt refused")
	}
	if _, ok := consume("b"); !ok {
		t.Fatal("another key shares the count")
	}
	advance(time.Minute)
	retryAt, ok := consume("a")
	if ok {
		t.Fatal("attempt over the limit accepted")
	}
	if !retryAt.Equal(windowStart.Add(window)) {
		t.Fatalf("retryAt %v, want the window's end %v", retryAt, windowStart.Add(window))
	}

	advance(5 * time.Minute)
	if _, ok := consume("a"); !ok {
		t.Fatal("attempt after the window refused")
	}
	consume("a")
	if _, ok := consume("a"); ok {
		t.Fatal("new window not limited")
	}
	if err := attempts.Reset(ctx, "a"); err != nil {
		t.Fatal(err)
	}
	if _, ok := consume("a"); !ok {
		t.Fatal("attempt after Reset refused")
	}
	if err := attempts.Reset(ctx, "never-seen"); err != nil {
		t.Fatal(err)
	}
}
