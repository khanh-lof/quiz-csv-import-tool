package auth

import "context"

// Role names stored on users and carried in the access token's "role" claim.
const (
	RoleUser  = "User"
	RoleAdmin = "Admin"
)

// ctxKey is unexported so no other package can read or overwrite the claims stored under it.
type ctxKey struct{}

// NewContext returns a copy of ctx carrying the validated claims of the caller.
func NewContext(ctx context.Context, c *Claims) context.Context {
	return context.WithValue(ctx, ctxKey{}, c)
}

// FromContext returns the claims stored by NewContext, if any.
func FromContext(ctx context.Context) (*Claims, bool) {
	c, ok := ctx.Value(ctxKey{}).(*Claims)
	return c, ok
}
