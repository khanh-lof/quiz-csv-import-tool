package auth

import (
	"context"
	"encoding/base64"
	"encoding/json"
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
	if claims.Name != "alice" || !claims.HasAnyRole("admin", "user") || claims.HasAnyRole("Admin") {
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
		Name:             "alice",
		RegisteredClaims: jwt.RegisteredClaims{ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Hour))},
	}).SignedString(jwt.UnsafeAllowNoneSignatureType)
	if _, err := j.Parse(unsigned); err == nil {
		t.Fatal("alg=none accepted")
	}
}

func TestRolesAcceptsStringOrArray(t *testing.T) {
	var c Claims
	if err := json.Unmarshal([]byte(`{"unique_name":"a","role":"Admin"}`), &c); err != nil || !c.HasAnyRole("admin") {
		t.Fatalf("single role: %v %+v", err, c)
	}
	if err := json.Unmarshal([]byte(`{"unique_name":"a","role":["User","Admin"]}`), &c); err != nil || len(c.Roles) != 2 {
		t.Fatalf("role array: %v %+v", err, c)
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
