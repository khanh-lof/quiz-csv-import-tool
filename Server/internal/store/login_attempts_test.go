package store

import (
	"context"
	"testing"
	"time"
)

func TestMemoryLoginAttempts(t *testing.T) {
	m := NewMemoryLoginAttempts()
	clock := time.Now().UTC().Truncate(time.Millisecond)
	m.Now = func() time.Time { return clock }
	testLoginAttempts(t, m, func() time.Time { return clock }, func(d time.Duration) { clock = clock.Add(d) })
}

func TestPostgresLoginAttempts(t *testing.T) {
	m := NewPostgresLoginAttempts(newTestPool(t))
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
