package auth

import (
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"fmt"
	"strconv"
	"strings"
)

// Hashes are "<iterations>.<base64 salt>.<base64 key>" using PBKDF2-HMAC-SHA256 — byte-for-byte the
// format the former .NET PasswordHasher wrote, so password hashes imported from Cosmos keep verifying.
const (
	hashIterations = 100_000
	saltSize       = 16
	keySize        = 32
)

func HashPassword(password string) (string, error) {
	salt := make([]byte, saltSize)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	key, err := pbkdf2.Key(sha256.New, password, salt, hashIterations, keySize)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("%d.%s.%s", hashIterations,
		base64.StdEncoding.EncodeToString(salt), base64.StdEncoding.EncodeToString(key)), nil
}

func VerifyPassword(password, hashed string) bool {
	parts := strings.Split(hashed, ".")
	if len(parts) != 3 {
		return false
	}
	iterations, err := strconv.Atoi(parts[0])
	if err != nil || iterations < 1 {
		return false
	}
	salt, err := base64.StdEncoding.DecodeString(parts[1])
	if err != nil {
		return false
	}
	key, err := base64.StdEncoding.DecodeString(parts[2])
	if err != nil || len(key) == 0 {
		return false
	}
	candidate, err := pbkdf2.Key(sha256.New, password, salt, iterations, len(key))
	if err != nil {
		return false
	}
	return subtle.ConstantTimeCompare(key, candidate) == 1
}
