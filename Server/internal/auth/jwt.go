package auth

import (
	"errors"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// ErrTokenExpired is matched (errors.Is) by Parse errors for an expired token — routine traffic
// the client answers with a silent refresh, unlike a forged or malformed token.
var ErrTokenExpired = jwt.ErrTokenExpired

// Claims identifies the user by the standard "sub" claim and lists their roles in "roles".
type Claims struct {
	Roles []string `json:"roles,omitempty"`
	jwt.RegisteredClaims
}

// Username is the subject of the token.
func (c *Claims) Username() string { return c.Subject }

// HasAnyRole reports whether the token carries one of roles (case-insensitive).
func (c *Claims) HasAnyRole(roles ...string) bool {
	for _, have := range c.Roles {
		for _, want := range roles {
			if strings.EqualFold(have, want) {
				return true
			}
		}
	}
	return false
}

// JWT issues and validates HS256 access tokens.
type JWT struct {
	secret   []byte
	issuer   string
	audience string
	ttl      time.Duration
	now      func() time.Time
}

func NewJWT(secret []byte, issuer, audience string, ttl time.Duration) *JWT {
	return &JWT{secret: secret, issuer: issuer, audience: audience, ttl: ttl, now: time.Now}
}

func (j *JWT) Issue(username string, roles []string) (string, error) {
	now := j.now()
	claims := Claims{
		Roles: roles,
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   username,
			Issuer:    j.issuer,
			IssuedAt:  jwt.NewNumericDate(now),
			NotBefore: jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(j.ttl)),
		},
	}
	if j.audience != "" {
		claims.Audience = jwt.ClaimStrings{j.audience}
	}
	return jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString(j.secret)
}

// Parse validates signature, lifetime (with 2 minutes of clock skew) and, when configured,
// issuer and audience. config.FromEnv always configures both.
func (j *JWT) Parse(token string) (*Claims, error) {
	opts := []jwt.ParserOption{
		jwt.WithValidMethods([]string{jwt.SigningMethodHS256.Alg()}),
		jwt.WithLeeway(2 * time.Minute),
		jwt.WithExpirationRequired(),
		jwt.WithTimeFunc(j.now),
	}
	if j.issuer != "" {
		opts = append(opts, jwt.WithIssuer(j.issuer))
	}
	if j.audience != "" {
		opts = append(opts, jwt.WithAudience(j.audience))
	}

	var claims Claims
	if _, err := jwt.ParseWithClaims(token, &claims, func(*jwt.Token) (any, error) {
		return j.secret, nil
	}, opts...); err != nil {
		return nil, err
	}
	if claims.Subject == "" {
		return nil, errors.New("token has no sub claim")
	}
	return &claims, nil
}
