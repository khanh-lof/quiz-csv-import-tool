package store

import (
	"context"
	"slices"
	"sync"
	"time"
)

// Memory is an in-process Users implementation for tests.
type Memory struct {
	mu    sync.Mutex
	users map[string]User
	Now   func() time.Time
}

func NewMemory() *Memory {
	return &Memory{users: map[string]User{}, Now: time.Now}
}

func (m *Memory) FindByUsername(_ context.Context, username string) (*User, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	u, ok := m.users[username]
	if !ok {
		return nil, ErrNotFound
	}
	return clone(u), nil
}

func (m *Memory) FindByRefreshToken(_ context.Context, token string) (*User, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, u := range m.users {
		for _, t := range u.RefreshTokens {
			if t.Token == token {
				return clone(u), nil
			}
		}
	}
	return nil, ErrNotFound
}

func (m *Memory) Create(_ context.Context, user *User) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.users[user.Username]; ok {
		return ErrDuplicate
	}
	m.users[user.Username] = *clone(*user)
	return nil
}

func (m *Memory) UpdateRefreshTokens(_ context.Context, username string,
	mutate func([]RefreshToken) ([]RefreshToken, bool)) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	u, ok := m.users[username]
	if !ok {
		return ErrNotFound
	}
	tokens, changed := mutate(slices.Clone(u.RefreshTokens))
	if changed {
		u.RefreshTokens = tokens
		u.Version++
		m.users[username] = u
	}
	return nil
}

func (m *Memory) TryConsumeAICall(_ context.Context, username string, limit int, round time.Duration) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	u, ok := m.users[username]
	if !ok {
		return false, nil
	}
	now := m.Now().UTC()
	running := u.StartRoundTime != nil && u.StartRoundTime.After(now.Add(-round))
	switch {
	case running && u.AICallCountInRound < limit:
		u.AICallCountInRound++
	case !running:
		u.AICallCountInRound = 1
		u.StartRoundTime = &now
	default:
		return false, nil
	}
	m.users[username] = u
	return true, nil
}

func clone(u User) *User {
	u.Roles = slices.Clone(u.Roles)
	u.RefreshTokens = slices.Clone(u.RefreshTokens)
	return &u
}
