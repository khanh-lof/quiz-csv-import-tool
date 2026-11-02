package store

import (
	"context"
	"sync"
	"time"
)

// LoginAttempts counts the password checks made for each key (a username), so a password cannot be
// guessed faster than the limit allows. It is stored, not kept in memory, so every instance of the server
// shares the count.
type LoginAttempts interface {
	// TryConsume counts one attempt for key: at most limit per window, a window starting with the first
	// attempt after the previous one ended. When the limit is already reached it returns ok=false and the
	// moment the window ends.
	TryConsume(ctx context.Context, key string, limit int, window time.Duration) (retryAt time.Time, ok bool, err error)
	// Reset forgets the attempts of key, after a successful login.
	Reset(ctx context.Context, key string) error
}

// MemoryLoginAttempts is an in-process LoginAttempts implementation for tests.
type MemoryLoginAttempts struct {
	mu      sync.Mutex
	windows map[string]loginWindow
	Now     func() time.Time
}

type loginWindow struct {
	count int
	start time.Time
}

func NewMemoryLoginAttempts() *MemoryLoginAttempts {
	return &MemoryLoginAttempts{windows: map[string]loginWindow{}, Now: time.Now}
}

func (m *MemoryLoginAttempts) TryConsume(_ context.Context, key string, limit int, window time.Duration) (time.Time, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	now := m.Now().UTC()
	w, ok := m.windows[key]
	running := ok && w.start.After(now.Add(-window))
	switch {
	case !running:
		m.windows[key] = loginWindow{count: 1, start: now}
	case w.count < limit:
		w.count++
		m.windows[key] = w
	default:
		return w.start.Add(window), false, nil
	}
	return time.Time{}, true, nil
}

func (m *MemoryLoginAttempts) Reset(_ context.Context, key string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.windows, key)
	return nil
}
