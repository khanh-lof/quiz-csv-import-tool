package auth

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"quiz-csv-import-tool/server/internal/store"
)

func TestVerifyPasswordAcceptsHashFromDotNet(t *testing.T) {
	// Produced by the former .NET PasswordHasher (Rfc2898DeriveBytes.Pbkdf2, SHA-256, 100k iterations).
	const dotnetHash = "100000.gkppEGEAkDntPBtk4hPeUw==.U7esYdlN4545cet4PzrnqEWOrv/FQkp7VSVbzoL8UeU="
	if !VerifyPassword("Mật khẩu-123", dotnetHash) {
		t.Fatal("hash written by .NET did not verify")
	}
	if VerifyPassword("wrong", dotnetHash) {
		t.Fatal("wrong password verified")
	}
}

func TestHashPasswordRoundTrip(t *testing.T) {
	hash, err := HashPassword("secret")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(hash, "100000.") || strings.Count(hash, ".") != 2 {
		t.Fatalf("unexpected hash format %q", hash)
	}
	if !VerifyPassword("secret", hash) || VerifyPassword("Secret", hash) {
		t.Fatal("round trip failed")
	}
	if VerifyPassword("", dummyHash) || VerifyPassword("secret", dummyHash) {
		t.Fatal("dummy hash verified")
	}
	for _, bad := range []string{"", "abc", "x.y.z", "0.AA==.AA==", "100000.!!.AA=="} {
		if VerifyPassword("secret", bad) {
			t.Fatalf("malformed hash %q verified", bad)
		}
	}
}

func testJWT(issuer, audience string) *JWT {
	return NewJWT([]byte("0123456789abcdef0123456789abcdef"), issuer, audience, 15*time.Minute)
}

func TestJWTIssueAndParse(t *testing.T) {
	j := testJWT("quiz", "spa")
	token, err := j.Issue("alice", []string{"User"})
	if err != nil {
		t.Fatal(err)
	}
	claims, err := j.Parse(token)
	if err != nil {
		t.Fatal(err)
	}
	if claims.Username() != "alice" || !claims.HasAnyRole("admin", "user") || claims.HasAnyRole("Admin") {
		t.Fatalf("unexpected claims %+v", claims)
	}

	if _, err := testJWT("other", "spa").Parse(token); err == nil {
		t.Fatal("wrong issuer accepted")
	}
	if _, err := testJWT("quiz", "other").Parse(token); err == nil {
		t.Fatal("wrong audience accepted")
	}
	if _, err := NewJWT([]byte("another-secret-another-secret-32"), "quiz", "spa", time.Minute).Parse(token); err == nil {
		t.Fatal("wrong secret accepted")
	}
}

func TestJWTSkipsIssuerAudienceWhenUnset(t *testing.T) {
	token, _ := testJWT("quiz", "spa").Issue("alice", nil)
	if _, err := testJWT("", "").Parse(token); err != nil {
		t.Fatalf("issuer/audience should not be validated when unset: %v", err)
	}
}

func TestJWTExpiryHonorsClockSkew(t *testing.T) {
	j := testJWT("", "")
	issued := time.Now()
	j.now = func() time.Time { return issued }
	token, _ := j.Issue("alice", nil)

	j.now = func() time.Time { return issued.Add(16 * time.Minute) }
	if _, err := j.Parse(token); err != nil {
		t.Fatalf("token within the 2 minute skew rejected: %v", err)
	}
	j.now = func() time.Time { return issued.Add(18 * time.Minute) }
	if _, err := j.Parse(token); err == nil {
		t.Fatal("expired token accepted")
	}
}

func TestJWTRejectsOtherAlgorithms(t *testing.T) {
	j := testJWT("", "")
	unsigned, _ := jwt.NewWithClaims(jwt.SigningMethodNone, Claims{
		RegisteredClaims: jwt.RegisteredClaims{Subject: "alice", ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Hour))},
	}).SignedString(jwt.UnsafeAllowNoneSignatureType)
	if _, err := j.Parse(unsigned); err == nil {
		t.Fatal("alg=none accepted")
	}
}

func TestJWTUsesStandardClaimNames(t *testing.T) {
	token, _ := testJWT("quiz", "spa").Issue("alice", []string{"User"})
	payload, err := base64.RawURLEncoding.DecodeString(strings.Split(token, ".")[1])
	if err != nil {
		t.Fatal(err)
	}
	var raw map[string]any
	_ = json.Unmarshal(payload, &raw)
	if raw["sub"] != "alice" || raw["iss"] != "quiz" || raw["aud"] == nil || raw["roles"] == nil {
		t.Fatalf("payload %s", payload)
	}
	if _, ok := raw["unique_name"]; ok {
		t.Fatalf("legacy claim still issued: %s", payload)
	}
}

func TestJWTExpiredErrorIsDistinguishable(t *testing.T) {
	j := testJWT("", "")
	issued := time.Now()
	j.now = func() time.Time { return issued }
	token, _ := j.Issue("alice", nil)
	j.now = func() time.Time { return issued.Add(time.Hour) }
	if _, err := j.Parse(token); !errors.Is(err, ErrTokenExpired) {
		t.Fatalf("want ErrTokenExpired, got %v", err)
	}
	if _, err := j.Parse("garbage"); errors.Is(err, ErrTokenExpired) {
		t.Fatal("malformed token reported as expired")
	}
}

func newTestService(t *testing.T, maxTokens int) (*Service, *store.Memory, *time.Time) {
	t.Helper()
	users := store.NewMemory()
	hash, _ := HashPassword("pw")
	if err := users.Create(context.Background(), &store.User{Username: "alice", PasswordHash: hash, Roles: []string{"User"}}); err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	svc := NewService(users, testJWT("", ""), 30*24*time.Hour, maxTokens)
	svc.now = func() time.Time { return now }
	return svc, users, &now
}

func TestLoginRefreshLogout(t *testing.T) {
	ctx := context.Background()
	svc, users, _ := newTestService(t, 5)

	if _, err := svc.Login(ctx, "alice", "bad"); err != ErrInvalidCredentials {
		t.Fatalf("bad password: %v", err)
	}
	if _, err := svc.Login(ctx, "bob", "pw"); err != ErrInvalidCredentials {
		t.Fatalf("unknown user: %v", err)
	}

	phone, err := svc.Login(ctx, "alice", "pw")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := base64.RawURLEncoding.DecodeString(phone.RefreshToken); err != nil {
		t.Fatalf("refresh token is not URL-safe: %v", err)
	}
	laptop, _ := svc.Login(ctx, "alice", "pw")

	rotated, err := svc.Refresh(ctx, phone.RefreshToken)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Refresh(ctx, phone.RefreshToken); err != ErrInvalidRefreshToken {
		t.Fatalf("old refresh token still valid after rotation: %v", err)
	}
	if u, _ := users.FindByUsername(ctx, "alice"); len(u.RefreshTokens) != 2 {
		t.Fatalf("want 2 sessions, got %d", len(u.RefreshTokens))
	}

	if ok, err := svc.Logout(ctx, rotated.RefreshToken); !ok || err != nil {
		t.Fatalf("logout: %v %v", ok, err)
	}
	if _, err := svc.Refresh(ctx, laptop.RefreshToken); err != nil {
		t.Fatalf("logout of one device revoked another: %v", err)
	}
	if ok, _ := svc.Logout(ctx, "unknown"); ok {
		t.Fatal("logout with unknown token reported success")
	}
}

func TestLogoutAllRevokesEverySession(t *testing.T) {
	ctx := context.Background()
	svc, users, _ := newTestService(t, 5)
	a, _ := svc.Login(ctx, "alice", "pw")
	_, _ = svc.Login(ctx, "alice", "pw")

	if ok, err := svc.LogoutAll(ctx, a.RefreshToken); !ok || err != nil {
		t.Fatalf("logout-all: %v %v", ok, err)
	}
	if u, _ := users.FindByUsername(ctx, "alice"); len(u.RefreshTokens) != 0 {
		t.Fatalf("tokens left: %d", len(u.RefreshTokens))
	}
	if ok, _ := svc.LogoutAll(ctx, a.RefreshToken); ok {
		t.Fatal("logout-all with a revoked token reported success")
	}
}

func TestLoginEvictsOldestSessionAndPrunesExpired(t *testing.T) {
	ctx := context.Background()
	svc, users, now := newTestService(t, 2)

	first, _ := svc.Login(ctx, "alice", "pw")
	*now = now.Add(time.Minute)
	_, _ = svc.Login(ctx, "alice", "pw")
	*now = now.Add(time.Minute)
	third, _ := svc.Login(ctx, "alice", "pw")

	if _, err := svc.Refresh(ctx, first.RefreshToken); err != ErrInvalidRefreshToken {
		t.Fatalf("oldest session should have been evicted: %v", err)
	}
	u, _ := users.FindByUsername(ctx, "alice")
	if len(u.RefreshTokens) != 2 {
		t.Fatalf("want 2 sessions, got %d", len(u.RefreshTokens))
	}

	// Past expiry: refresh fails, and the next login prunes the dead entries.
	*now = now.Add(31 * 24 * time.Hour)
	if _, err := svc.Refresh(ctx, third.RefreshToken); err != ErrInvalidRefreshToken {
		t.Fatalf("expired token accepted: %v", err)
	}
	_, _ = svc.Login(ctx, "alice", "pw")
	if u, _ := users.FindByUsername(ctx, "alice"); len(u.RefreshTokens) != 1 {
		t.Fatalf("expired tokens not pruned: %d left", len(u.RefreshTokens))
	}
}

func TestRefreshTokensAreStoredHashed(t *testing.T) {
	ctx := context.Background()
	svc, users, _ := newTestService(t, 5)
	s, _ := svc.Login(ctx, "alice", "pw")

	u, _ := users.FindByUsername(ctx, "alice")
	if len(u.RefreshTokens) != 1 || u.RefreshTokens[0].Hash == s.RefreshToken || u.RefreshTokens[0].Hash != hashRefreshToken(s.RefreshToken) {
		t.Fatalf("stored %+v for token %q", u.RefreshTokens, s.RefreshToken)
	}
	// Presenting the stored hash itself is not a valid token.
	if _, err := svc.Refresh(ctx, u.RefreshTokens[0].Hash); err != ErrInvalidRefreshToken {
		t.Fatalf("hash accepted as token: %v", err)
	}
}

func TestRefreshTokenReuseRevokesEverySession(t *testing.T) {
	ctx := context.Background()
	svc, users, now := newTestService(t, 5)
	stolen, _ := svc.Login(ctx, "alice", "pw")
	laptop, _ := svc.Login(ctx, "alice", "pw")

	// The thief refreshes first; later the victim presents the same (now spent) token.
	thief, err := svc.Refresh(ctx, stolen.RefreshToken)
	if err != nil {
		t.Fatal(err)
	}
	*now = now.Add(reuseGracePeriod + time.Second)
	if _, err := svc.Refresh(ctx, stolen.RefreshToken); !errors.Is(err, ErrRefreshTokenReused) || !errors.Is(err, ErrInvalidRefreshToken) {
		t.Fatalf("reuse not detected: %v", err)
	}
	for name, token := range map[string]string{"thief": thief.RefreshToken, "laptop": laptop.RefreshToken} {
		if _, err := svc.Refresh(ctx, token); err == nil {
			t.Fatalf("%s session survived reuse detection", name)
		}
	}
	if u, _ := users.FindByUsername(ctx, "alice"); len(u.RefreshTokens) != 0 {
		t.Fatalf("active sessions left: %d", len(u.RefreshTokens))
	}
	// A further replay is still recognised.
	if _, err := svc.Refresh(ctx, stolen.RefreshToken); !errors.Is(err, ErrRefreshTokenReused) {
		t.Fatalf("second replay: %v", err)
	}
}

func TestRefreshTokenReuseWithinGracePeriodIsARace(t *testing.T) {
	ctx := context.Background()
	svc, _, now := newTestService(t, 5)
	s, _ := svc.Login(ctx, "alice", "pw")

	rotated, _ := svc.Refresh(ctx, s.RefreshToken)
	*now = now.Add(reuseGracePeriod - time.Second)
	if _, err := svc.Refresh(ctx, s.RefreshToken); err != ErrInvalidRefreshToken {
		t.Fatalf("concurrent refresh treated as reuse: %v", err)
	}
	if _, err := svc.Refresh(ctx, rotated.RefreshToken); err != nil {
		t.Fatalf("winning session revoked by a racing refresh: %v", err)
	}
}

func TestSpentTokensArePrunedAndCapped(t *testing.T) {
	ctx := context.Background()
	svc, users, now := newTestService(t, 5)
	s, _ := svc.Login(ctx, "alice", "pw")
	first := s.RefreshToken
	for range maxSpentTokens + 5 {
		s, _ = svc.Refresh(ctx, s.RefreshToken)
	}
	if u, _ := users.FindByUsername(ctx, "alice"); len(u.SpentRefreshTokens) != maxSpentTokens {
		t.Fatalf("want %d spent tokens, got %d", maxSpentTokens, len(u.SpentRefreshTokens))
	}
	// The oldest spent token fell out of the list: replaying it is a plain invalid token.
	*now = now.Add(time.Hour)
	if _, err := svc.Refresh(ctx, first); err != ErrInvalidRefreshToken {
		t.Fatalf("evicted spent token: %v", err)
	}

	*now = now.Add(31 * 24 * time.Hour)
	_, _ = svc.Login(ctx, "alice", "pw")
	if u, _ := users.FindByUsername(ctx, "alice"); len(u.SpentRefreshTokens) != 0 {
		t.Fatalf("expired spent tokens not pruned: %d", len(u.SpentRefreshTokens))
	}
}

func TestLogoutAllRequiresActiveToken(t *testing.T) {
	ctx := context.Background()
	svc, users, _ := newTestService(t, 5)
	s, _ := svc.Login(ctx, "alice", "pw")
	_, _ = svc.Refresh(ctx, s.RefreshToken)

	if ok, err := svc.LogoutAll(ctx, s.RefreshToken); ok || err != nil {
		t.Fatalf("logout-all with a spent token: %v %v", ok, err)
	}
	if u, _ := users.FindByUsername(ctx, "alice"); len(u.RefreshTokens) != 1 {
		t.Fatalf("sessions revoked by a spent token: %d left", len(u.RefreshTokens))
	}
}
