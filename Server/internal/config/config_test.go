package config

import (
	"strings"
	"testing"
)

func TestFromEnvJWTSettings(t *testing.T) {
	t.Setenv("MONGODB_URI", "mongodb://localhost")
	t.Setenv("JWT_ISSUER", "")
	t.Setenv("JWT_AUDIENCE", "")

	t.Setenv("JWT_SECRET", "too-short")
	if _, err := FromEnv(); err == nil || !strings.Contains(err.Error(), "JWT_SECRET must be at least 32 bytes") {
		t.Fatalf("short secret: %v", err)
	}

	t.Setenv("JWT_SECRET", strings.Repeat("x", 32))
	cfg, err := FromEnv()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.JWTIssuer != "quiztool" || cfg.JWTAudience != "quiztool-api" {
		t.Fatalf("issuer/audience defaults: %q %q", cfg.JWTIssuer, cfg.JWTAudience)
	}
}

func TestFromEnvAssignmentCollections(t *testing.T) {
	t.Setenv("MONGODB_URI", "mongodb://localhost")
	t.Setenv("JWT_SECRET", strings.Repeat("x", 32))
	t.Setenv("MONGODB_ASSIGNMENTS_COLLECTION", "")
	t.Setenv("MONGODB_PLAYERS_COLLECTION", "")

	cfg, err := FromEnv()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.MongoAssignmentsCollection != "Assignments" || cfg.MongoPlayersCollection != "AssignmentPlayers" {
		t.Fatalf("defaults: %q %q", cfg.MongoAssignmentsCollection, cfg.MongoPlayersCollection)
	}

	t.Setenv("MONGODB_ASSIGNMENTS_COLLECTION", " Classes ")
	t.Setenv("MONGODB_PLAYERS_COLLECTION", "Students")
	cfg, err = FromEnv()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.MongoAssignmentsCollection != "Classes" || cfg.MongoPlayersCollection != "Students" {
		t.Fatalf("overrides: %q %q", cfg.MongoAssignmentsCollection, cfg.MongoPlayersCollection)
	}
}
