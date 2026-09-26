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

func (m *Memory) FindByRefreshTokenHash(_ context.Context, hash string) (*User, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, u := range m.users {
		if slices.ContainsFunc(u.RefreshTokens, func(t RefreshToken) bool { return t.Hash == hash }) ||
			slices.ContainsFunc(u.SpentRefreshTokens, func(t SpentRefreshToken) bool { return t.Hash == hash }) {
			return clone(u), nil
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

func (m *Memory) UpdateSessions(_ context.Context, username string, mutate func(*Sessions) bool) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	u, ok := m.users[username]
	if !ok {
		return ErrNotFound
	}
	s := Sessions{Active: slices.Clone(u.RefreshTokens), Spent: slices.Clone(u.SpentRefreshTokens)}
	if mutate(&s) {
		u.RefreshTokens, u.SpentRefreshTokens = s.Active, s.Spent
		u.Version++
		m.users[username] = u
	}
	return nil
}

func (m *Memory) TryConsumeAICall(_ context.Context, username string, limit int, round time.Duration) (time.Time, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	u, ok := m.users[username]
	if !ok {
		return time.Time{}, false, nil
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
		return time.Time{}, false, nil
	}
	m.users[username] = u
	return *u.StartRoundTime, true, nil
}

func (m *Memory) RefundAICall(_ context.Context, username string, roundStart time.Time) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	u, ok := m.users[username]
	if !ok || u.StartRoundTime == nil || !u.StartRoundTime.Equal(roundStart) || u.AICallCountInRound <= 0 {
		return nil
	}
	u.AICallCountInRound--
	m.users[username] = u
	return nil
}

func clone(u User) *User {
	u.Roles = slices.Clone(u.Roles)
	u.RefreshTokens = slices.Clone(u.RefreshTokens)
	u.SpentRefreshTokens = slices.Clone(u.SpentRefreshTokens)
	return &u
}
