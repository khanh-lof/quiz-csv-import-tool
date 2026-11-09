package config

import (
	"slices"
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

func TestFromEnvQuestionBank(t *testing.T) {
	t.Setenv("MONGODB_URI", "mongodb://localhost")
	t.Setenv("JWT_SECRET", strings.Repeat("x", 32))
	t.Setenv("MONGODB_QUESTIONS_COLLECTION", "")
	t.Setenv("QUESTION_BANK", "")
	cfg, err := FromEnv()
	if err != nil || cfg.QuestionBank || cfg.MongoQuestionsCollection != "QuestionBank" {
		t.Fatalf("defaults: %v %q, %v", cfg.QuestionBank, cfg.MongoQuestionsCollection, err)
	}
	for _, on := range []string{"on", " ON ", "true", "1"} {
		t.Setenv("QUESTION_BANK", on)
		if cfg, err := FromEnv(); err != nil || !cfg.QuestionBank {
			t.Errorf("QUESTION_BANK=%q: %v, %v", on, cfg.QuestionBank, err)
		}
	}
	t.Setenv("QUESTION_BANK", "yes please")
	if _, err := FromEnv(); err == nil || !strings.Contains(err.Error(), "QUESTION_BANK must be on or off") {
		t.Errorf("QUESTION_BANK=yes please: %v", err)
	}
}

func TestFromEnvHighIntelligenceServer(t *testing.T) {
	t.Setenv("MONGODB_URI", "mongodb://localhost")
	t.Setenv("JWT_SECRET", strings.Repeat("x", 32))

	t.Setenv("HIGH_INTELLIGENCE_PROXY_SECRET", strings.Repeat("p", 32))
	t.Setenv("HIGH_INTELLIGENCE_SERVER_URL", " ")
	if cfg, err := FromEnv(); err != nil || cfg.HighIntelligenceServer != nil {
		t.Fatalf("unset: %v %v", cfg.HighIntelligenceServer, err)
	}
	t.Setenv("HIGH_INTELLIGENCE_SERVER_URL", " https://ai.example.com/ ")
	if cfg, err := FromEnv(); err != nil || cfg.HighIntelligenceServer.String() != "https://ai.example.com" {
		t.Fatalf("set: %v %v", cfg.HighIntelligenceServer, err)
	}
	for _, bad := range []string{"ai.example.com", "ftp://ai.example.com", "https://ai.example.com/?x=1", "https://u:p@ai.example.com"} {
		t.Setenv("HIGH_INTELLIGENCE_SERVER_URL", bad)
		if _, err := FromEnv(); err == nil || !strings.Contains(err.Error(), "HIGH_INTELLIGENCE_SERVER_URL") {
			t.Errorf("%q: %v", bad, err)
		}
	}
}

func TestFromEnvHighIntelligenceProxySecret(t *testing.T) {
	t.Setenv("MONGODB_URI", "mongodb://localhost")
	t.Setenv("JWT_SECRET", strings.Repeat("x", 32))

	t.Setenv("HIGH_INTELLIGENCE_SERVER_URL", "")
	t.Setenv("HIGH_INTELLIGENCE_PROXY_SECRET", "")
	if _, err := FromEnv(); err != nil {
		t.Fatalf("neither set: %v", err)
	}

	t.Setenv("HIGH_INTELLIGENCE_SERVER_URL", "https://ai.example.com")
	if _, err := FromEnv(); err == nil || !strings.Contains(err.Error(), "HIGH_INTELLIGENCE_PROXY_SECRET is required") {
		t.Fatalf("server without secret: %v", err)
	}

	t.Setenv("HIGH_INTELLIGENCE_PROXY_SECRET", "too-short")
	if _, err := FromEnv(); err == nil || !strings.Contains(err.Error(), "HIGH_INTELLIGENCE_PROXY_SECRET must be at least 32 bytes") {
		t.Fatalf("short secret: %v", err)
	}

	t.Setenv("HIGH_INTELLIGENCE_PROXY_SECRET", " "+strings.Repeat("p", 32)+" ")
	if cfg, err := FromEnv(); err != nil || cfg.HighIntelligenceSecret != strings.Repeat("p", 32) {
		t.Fatalf("valid: %q %v", cfg.HighIntelligenceSecret, err)
	}
}

func TestFromEnvCloudinaryURL(t *testing.T) {
	t.Setenv("MONGODB_URI", "mongodb://localhost")
	t.Setenv("JWT_SECRET", strings.Repeat("x", 32))

	t.Setenv("CLOUDINARY_URL", "")
	if cfg, err := FromEnv(); err != nil || cfg.CloudinaryURL != "" {
		t.Fatalf("unset: %q %v", cfg.CloudinaryURL, err)
	}
	t.Setenv("CLOUDINARY_URL", " cloudinary://123:abc@demo ")
	if cfg, err := FromEnv(); err != nil || cfg.CloudinaryURL != "cloudinary://123:abc@demo" {
		t.Fatalf("set: %q %v", cfg.CloudinaryURL, err)
	}
	t.Setenv("CLOUDINARY_URL", "https://demo")
	if _, err := FromEnv(); err == nil || !strings.Contains(err.Error(), "CLOUDINARY_URL") {
		t.Fatalf("malformed: %v", err)
	}
}

func TestFromEnvGameStageSeconds(t *testing.T) {
	t.Setenv("MONGODB_URI", "mongodb://localhost")
	t.Setenv("JWT_SECRET", strings.Repeat("x", 32))

	// Unset, empty and blank all mean the default table.
	for _, raw := range []string{"", "   "} {
		t.Setenv("GAME_STAGE_SECONDS", raw)
		cfg, err := FromEnv()
		if err != nil {
			t.Fatalf("%q: %v", raw, err)
		}
		if want := []int{12, 12, 15, 15, 20, 45}; !slices.Equal(cfg.GameStageSeconds, want) {
			t.Fatalf("%q: %v, want %v", raw, cfg.GameStageSeconds, want)
		}
	}

	// A custom table, with the spaces a person would type, and the limits themselves.
	for raw, want := range map[string][]int{
		"10,10,20,20,30,60":        {10, 10, 20, 20, 30, 60},
		" 10 , 11,12 ,13, 14 ,15 ": {10, 11, 12, 13, 14, 15},
		"5,5,5,600,600,600":        {5, 5, 5, 600, 600, 600},
	} {
		t.Setenv("GAME_STAGE_SECONDS", raw)
		cfg, err := FromEnv()
		if err != nil || !slices.Equal(cfg.GameStageSeconds, want) {
			t.Fatalf("%q: %v, %v; want %v", raw, cfg.GameStageSeconds, err, want)
		}
	}

	// Anything else stops the server from starting, with the setting named in the message; the config that
	// comes back alongside is still whole.
	for raw, msg := range map[string]string{
		"12,12,15,15,20":             "GAME_STAGE_SECONDS must list 6 numbers of seconds, one per stage, got 5",
		"12,12,15,15,20,45,60":       "got 7",
		"12":                         "got 1",
		"12,12,15,15,20,":            "must list whole numbers",
		"12,12,15,15,20,abc":         `got "abc" for stage 6`,
		"12,12,15.5,15,20,45":        `got "15.5" for stage 3`,
		"12;12;15;15;20;45":          "got 1",
		"12,12,15,15,20,1e2":         `got "1e2" for stage 6`,
		"4,12,15,15,20,45":           "must be 5 to 600 seconds per stage, got 4 for stage 1",
		"12,12,15,15,20,601":         "got 601 for stage 6",
		"0,12,15,15,20,45":           "got 0 for stage 1",
		"12,12,-15,15,20,45":         "got -15 for stage 3",
		"12,12,15,15,20,99999999999": "must be 5 to 600 seconds per stage, got",
	} {
		t.Setenv("GAME_STAGE_SECONDS", raw)
		cfg, err := FromEnv()
		if err == nil || !strings.Contains(err.Error(), "GAME_STAGE_SECONDS") || !strings.Contains(err.Error(), msg) {
			t.Errorf("%q: error %v, want one containing %q", raw, err, msg)
		}
		if len(cfg.GameStageSeconds) != 6 {
			t.Errorf("%q: %v", raw, cfg.GameStageSeconds)
		}
	}

	// The default does not alias the package's table: a caller changing its copy changes nothing.
	t.Setenv("GAME_STAGE_SECONDS", "")
	cfg, _ := FromEnv()
	cfg.GameStageSeconds[0] = 99
	if again, _ := FromEnv(); again.GameStageSeconds[0] != 12 {
		t.Fatalf("the default was changed: %v", again.GameStageSeconds)
	}
}
