package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"slices"
	"time"

	"quiz-csv-import-tool/server/internal/store"
)

var (
	ErrInvalidCredentials  = errors.New("invalid credentials")
	ErrInvalidRefreshToken = errors.New("invalid refresh token")
	// ErrRefreshTokenReused means an already rotated refresh token was presented again: someone
	// else holds a copy of it, so every session of the user has been revoked. It wraps
	// ErrInvalidRefreshToken.
	ErrRefreshTokenReused = fmt.Errorf("%w: reused after rotation", ErrInvalidRefreshToken)
)

const (
	// reuseGracePeriod tolerates a rotated token arriving again shortly after rotation: two tabs
	// refreshing at once with the same cookie is a race, not theft.
	reuseGracePeriod = 30 * time.Second
	// maxSpentTokens bounds the rotated tokens remembered per user for reuse detection.
	maxSpentTokens = 50
)

// Session is what a successful login or refresh hands back: a short-lived access token for the
// Authorization header and a long-lived refresh token for the HttpOnly cookie.
type Session struct {
	AccessToken  string
	RefreshToken string
}

// Service issues sessions and manages the per-device refresh tokens stored on the user. Refresh
// tokens are opaque random strings; the store only ever sees their SHA-256 hash.
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
		// Spend the same PBKDF2 work as a real check so response time does not reveal which
		// usernames exist.
		VerifyPassword(password, dummyHash)
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
	token, entry, err := s.newRefreshToken()
	if err != nil {
		return Session{}, err
	}
	// Add this device's token next to the others, pruning expired ones and evicting the oldest
	// once the per-user session cap is exceeded.
	err = s.users.UpdateSessions(ctx, user.Username, func(ss *store.Sessions) bool {
		s.prune(ss)
		ss.Active = append(ss.Active, entry)
		if len(ss.Active) > s.maxTokens {
			slices.SortStableFunc(ss.Active, func(a, b store.RefreshToken) int { return b.CreatedAt.Compare(a.CreatedAt) })
			ss.Active = ss.Active[:s.maxTokens]
		}
		return true
	})
	if err != nil {
		return Session{}, err
	}
	return Session{AccessToken: access, RefreshToken: token}, nil
}

// Refresh exchanges a valid refresh token for a new access token and rotates the refresh token.
// Presenting a token that was already rotated away (outside reuseGracePeriod) revokes every
// session of the user and returns ErrRefreshTokenReused.
func (s *Service) Refresh(ctx context.Context, refreshToken string) (Session, error) {
	hash := hashRefreshToken(refreshToken)
	user, err := s.users.FindByRefreshTokenHash(ctx, hash)
	if errors.Is(err, store.ErrNotFound) {
		return Session{}, ErrInvalidRefreshToken
	}
	if err != nil {
		return Session{}, err
	}

	token, entry, err := s.newRefreshToken()
	if err != nil {
		return Session{}, err
	}
	// Decided inside the update, on the freshly read sessions, so two concurrent refreshes with
	// the same token cannot both succeed.
	var outcome error
	err = s.users.UpdateSessions(ctx, user.Username, func(ss *store.Sessions) bool {
		now := s.now()
		s.prune(ss)
		if i := slices.IndexFunc(ss.Active, func(t store.RefreshToken) bool { return t.Hash == hash }); i >= 0 {
			spent := store.SpentRefreshToken{Hash: hash, SpentAt: now.UTC(), ExpiresAt: ss.Active[i].ExpiresAt}
			ss.Active = append(slices.Delete(ss.Active, i, i+1), entry)
			ss.Spent = append(ss.Spent, spent)
			if n := len(ss.Spent); n > maxSpentTokens {
				ss.Spent = ss.Spent[n-maxSpentTokens:]
			}
			outcome = nil
			return true
		}
		outcome = ErrInvalidRefreshToken
		i := slices.IndexFunc(ss.Spent, func(t store.SpentRefreshToken) bool { return t.Hash == hash })
		if i < 0 || now.Sub(ss.Spent[i].SpentAt) <= reuseGracePeriod {
			return false
		}
		outcome = fmt.Errorf("user %q: %w", user.Username, ErrRefreshTokenReused)
		// Spent tokens are kept so a further replay is reported again.
		ss.Active = nil
		return true
	})
	if err != nil {
		return Session{}, err
	}
	if outcome != nil {
		return Session{}, outcome
	}

	access, err := s.jwt.Issue(user.Username, user.Roles)
	if err != nil {
		return Session{}, err
	}
	return Session{AccessToken: access, RefreshToken: token}, nil
}

// Logout revokes one device's refresh token. It reports whether the token was an active session.
func (s *Service) Logout(ctx context.Context, refreshToken string) (bool, error) {
	return s.revoke(ctx, refreshToken, func(ss *store.Sessions, hash string) {
		ss.Active = slices.DeleteFunc(ss.Active, func(t store.RefreshToken) bool { return t.Hash == hash })
	})
}

// LogoutAll revokes every refresh token of the user owning refreshToken, which must be an active
// session. It reports whether it was.
func (s *Service) LogoutAll(ctx context.Context, refreshToken string) (bool, error) {
	return s.revoke(ctx, refreshToken, func(ss *store.Sessions, _ string) {
		ss.Active = nil
	})
}

// revoke applies remove to the sessions of the user holding refreshToken, if it is active.
func (s *Service) revoke(ctx context.Context, refreshToken string, remove func(ss *store.Sessions, hash string)) (bool, error) {
	hash := hashRefreshToken(refreshToken)
	user, err := s.users.FindByRefreshTokenHash(ctx, hash)
	if errors.Is(err, store.ErrNotFound) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	var active bool
	err = s.users.UpdateSessions(ctx, user.Username, func(ss *store.Sessions) bool {
		s.prune(ss)
		active = slices.ContainsFunc(ss.Active, func(t store.RefreshToken) bool { return t.Hash == hash })
		if active {
			remove(ss, hash)
		}
		return active
	})
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		return false, err
	}
	return active, nil
}

// prune drops expired active tokens, and spent tokens whose original lifetime is over (replaying
// those is indistinguishable from presenting any expired token).
func (s *Service) prune(ss *store.Sessions) {
	now := s.now()
	ss.Active = slices.DeleteFunc(ss.Active, func(t store.RefreshToken) bool { return !t.ExpiresAt.After(now) })
	ss.Spent = slices.DeleteFunc(ss.Spent, func(t store.SpentRefreshToken) bool { return !t.ExpiresAt.After(now) })
}

// newRefreshToken returns a fresh token for the cookie and the entry to store for it.
func (s *Service) newRefreshToken() (string, store.RefreshToken, error) {
	b := make([]byte, 64)
	if _, err := rand.Read(b); err != nil {
		return "", store.RefreshToken{}, err
	}
	// URL-safe so the cookie value needs no escaping.
	token := base64.RawURLEncoding.EncodeToString(b)
	now := s.now().UTC()
	return token, store.RefreshToken{
		Hash:      hashRefreshToken(token),
		ExpiresAt: now.Add(s.refreshTTL),
		CreatedAt: now,
	}, nil
}

// hashRefreshToken is what the store keeps instead of the token. The token carries 512 random
// bits, so a plain fast hash suffices: there is nothing to brute-force and no need for a salt.
func hashRefreshToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}
