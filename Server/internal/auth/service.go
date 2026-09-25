package auth

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"slices"
	"time"

	"quiz-csv-import-tool/server/internal/store"
)

var (
	ErrInvalidCredentials  = errors.New("invalid credentials")
	ErrInvalidRefreshToken = errors.New("invalid refresh token")
)

// Session is what a successful login or refresh hands back: a short-lived access token for the
// Authorization header and a long-lived refresh token for the HttpOnly cookie.
type Session struct {
	AccessToken  string
	RefreshToken string
}

// Service issues sessions and manages the per-device refresh tokens stored on the user.
type Service struct {
	users      store.Users
	jwt        *JWT
	refreshTTL time.Duration
	maxTokens  int
	now        func() time.Time
}

func NewService(users store.Users, jwt *JWT, refreshTTL time.Duration, maxTokensPerUser int) *Service {
	return &Service{users: users, jwt: jwt, refreshTTL: refreshTTL, maxTokens: maxTokensPerUser, now: time.Now}
}

func (s *Service) Login(ctx context.Context, username, password string) (Session, error) {
	user, err := s.users.FindByUsername(ctx, username)
	if errors.Is(err, store.ErrNotFound) {
		return Session{}, ErrInvalidCredentials
	}
	if err != nil {
		return Session{}, err
	}
	if !VerifyPassword(password, user.PasswordHash) {
		return Session{}, ErrInvalidCredentials
	}

	access, err := s.jwt.Issue(user.Username, user.Roles)
	if err != nil {
		return Session{}, err
	}
	entry, err := s.newRefreshToken()
	if err != nil {
		return Session{}, err
	}
	// Add this device's token next to the others, pruning expired ones and evicting the oldest
	// once the per-user session cap is exceeded.
	err = s.users.UpdateRefreshTokens(ctx, user.Username, func(tokens []store.RefreshToken) ([]store.RefreshToken, bool) {
		tokens = append(s.withoutExpired(tokens), entry)
		if len(tokens) > s.maxTokens {
			slices.SortStableFunc(tokens, func(a, b store.RefreshToken) int { return b.CreatedAt.Compare(a.CreatedAt) })
			tokens = tokens[:s.maxTokens]
		}
		return tokens, true
	})
	if err != nil {
		return Session{}, err
	}
	return Session{AccessToken: access, RefreshToken: entry.Token}, nil
}

// Refresh exchanges a valid refresh token for a new access token and rotates the refresh token.
func (s *Service) Refresh(ctx context.Context, refreshToken string) (Session, error) {
	user, err := s.users.FindByRefreshToken(ctx, refreshToken)
	if errors.Is(err, store.ErrNotFound) {
		return Session{}, ErrInvalidRefreshToken
	}
	if err != nil {
		return Session{}, err
	}
	i := slices.IndexFunc(user.RefreshTokens, func(t store.RefreshToken) bool { return t.Token == refreshToken })
	if i < 0 || !user.RefreshTokens[i].ExpiresAt.After(s.now()) {
		return Session{}, ErrInvalidRefreshToken
	}

	access, err := s.jwt.Issue(user.Username, user.Roles)
	if err != nil {
		return Session{}, err
	}
	entry, err := s.newRefreshToken()
	if err != nil {
		return Session{}, err
	}
	err = s.users.UpdateRefreshTokens(ctx, user.Username, func(tokens []store.RefreshToken) ([]store.RefreshToken, bool) {
		tokens = slices.DeleteFunc(s.withoutExpired(tokens), func(t store.RefreshToken) bool { return t.Token == refreshToken })
		return append(tokens, entry), true
	})
	if err != nil {
		return Session{}, err
	}
	return Session{AccessToken: access, RefreshToken: entry.Token}, nil
}

// Logout revokes one device's refresh token. It reports whether the token belonged to a user.
func (s *Service) Logout(ctx context.Context, refreshToken string) (bool, error) {
	user, err := s.users.FindByRefreshToken(ctx, refreshToken)
	if errors.Is(err, store.ErrNotFound) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	err = s.users.UpdateRefreshTokens(ctx, user.Username, func(tokens []store.RefreshToken) ([]store.RefreshToken, bool) {
		kept := slices.DeleteFunc(s.withoutExpired(slices.Clone(tokens)), func(t store.RefreshToken) bool { return t.Token == refreshToken })
		return kept, len(kept) != len(tokens)
	})
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		return false, err
	}
	return true, nil
}

// LogoutAll revokes every refresh token of the user owning refreshToken.
func (s *Service) LogoutAll(ctx context.Context, refreshToken string) (bool, error) {
	user, err := s.users.FindByRefreshToken(ctx, refreshToken)
	if errors.Is(err, store.ErrNotFound) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	err = s.users.UpdateRefreshTokens(ctx, user.Username, func(tokens []store.RefreshToken) ([]store.RefreshToken, bool) {
		return nil, len(tokens) > 0
	})
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		return false, err
	}
	return true, nil
}

func (s *Service) withoutExpired(tokens []store.RefreshToken) []store.RefreshToken {
	now := s.now()
	return slices.DeleteFunc(tokens, func(t store.RefreshToken) bool { return !t.ExpiresAt.After(now) })
}

func (s *Service) newRefreshToken() (store.RefreshToken, error) {
	b := make([]byte, 64)
	if _, err := rand.Read(b); err != nil {
		return store.RefreshToken{}, err
	}
	now := s.now().UTC()
	return store.RefreshToken{
		// URL-safe so the cookie value needs no escaping.
		Token:     base64.RawURLEncoding.EncodeToString(b),
		ExpiresAt: now.Add(s.refreshTTL),
		CreatedAt: now,
	}, nil
}
