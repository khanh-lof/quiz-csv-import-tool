package auth

import (
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// Claims uses the same claim names the .NET JwtSecurityTokenHandler wrote for ClaimTypes.Name and
// ClaimTypes.Role, so tokens look the same to anything that inspects them.
type Claims struct {
	Name  string `json:"unique_name"`
	Roles Roles  `json:"role,omitempty"`
	jwt.RegisteredClaims
}

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

// Roles decodes the "role" claim from either a single string or an array, as .NET emitted a
// bare string when the user had exactly one role.
type Roles []string

func (r *Roles) UnmarshalJSON(data []byte) error {
	var one string
	if err := json.Unmarshal(data, &one); err == nil {
		*r = Roles{one}
		return nil
	}
	var many []string
	if err := json.Unmarshal(data, &many); err != nil {
		return err
	}
	*r = many
	return nil
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
		Name:  username,
		Roles: roles,
		RegisteredClaims: jwt.RegisteredClaims{
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
// issuer and audience.
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
	if claims.Name == "" {
		return nil, errors.New("token has no unique_name claim")
	}
	return &claims, nil
}
