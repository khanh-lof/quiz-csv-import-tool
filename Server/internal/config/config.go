// Package config reads the server configuration from environment variables.
package config

import (
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	"quiz-csv-import-tool/server/internal/csvgen"
)

type Config struct {
	// Port the HTTP server listens on. The client's dev environment expects 7071.
	Port string

	MongoURI        string
	MongoDatabase   string
	MongoCollection string

	JWTSecret       []byte
	JWTIssuer       string // optional; issuer validation is skipped when empty
	JWTAudience     string // optional; audience validation is skipped when empty
	AccessTokenTTL  time.Duration
	RefreshTokenTTL time.Duration
	// MaxRefreshTokensPerUser caps concurrent sessions (devices) per user; the oldest is evicted.
	MaxRefreshTokensPerUser int

	// AdminAPIKey protects POST /api/users. The endpoint rejects every request when it is empty.
	AdminAPIKey string

	LLM LLMConfig

	AICallsPerRound int
	RoundDuration   time.Duration
}

// LLMConfig is checked lazily, per call, so the server can run auth-only without an LLM.
type LLMConfig struct {
	APIKey  string
	BaseURL string
	// Model serves the formatted mode, and the creative mode when IntelligenceModels is empty.
	Model string
	// IntelligenceModels are the creative-mode models for "Độ thông minh" Thấp and Cao, cheapest first
	// (LLM_INTELLIGENCE_MODELS, comma-separated). Optional; when set it must list exactly
	// csvgen.IntelligenceLevels models.
	IntelligenceModels []string
	// Timeout bounds one generation call. Its default stays under Vercel's 300 s function limit so
	// the handler can still answer a clean 504 instead of the platform killing the request.
	Timeout time.Duration
}

func (c LLMConfig) Missing() []string {
	var missing []string
	if c.APIKey == "" {
		missing = append(missing, "OPENAI_API_KEY")
	}
	if c.BaseURL == "" {
		missing = append(missing, "OPENAI_BASE_URL")
	}
	if c.Model == "" {
		missing = append(missing, "LLM_MODEL")
	}
	return missing
}

// FromEnv builds the configuration, failing on missing required values or malformed numbers.
func FromEnv() (Config, error) {
	var errs []error
	intVar := func(key string, def int) int {
		raw := strings.TrimSpace(os.Getenv(key))
		if raw == "" {
			return def
		}
		v, err := strconv.Atoi(raw)
		if err != nil {
			errs = append(errs, fmt.Errorf("%s must be an integer, got %q", key, raw))
			return def
		}
		return v
	}

	cfg := Config{
		Port: envOr("PORT", "7071"),

		MongoURI:        os.Getenv("MONGODB_URI"),
		MongoDatabase:   envOr("MONGODB_DATABASE", "QuizDb"),
		MongoCollection: envOr("MONGODB_COLLECTION", "Users"),

		JWTSecret:               []byte(os.Getenv("JWT_SECRET")),
		JWTIssuer:               os.Getenv("JWT_ISSUER"),
		JWTAudience:             os.Getenv("JWT_AUDIENCE"),
		AccessTokenTTL:          time.Duration(intVar("JWT_ACCESS_TOKEN_EXPIRES_MINUTES", 15)) * time.Minute,
		RefreshTokenTTL:         time.Duration(intVar("JWT_REFRESH_TOKEN_EXPIRES_DAYS", 30)) * 24 * time.Hour,
		MaxRefreshTokensPerUser: intVar("MAX_REFRESH_TOKENS_PER_USER", 5),

		AdminAPIKey: os.Getenv("ADMIN_API_KEY"),

		LLM: LLMConfig{
			APIKey:             os.Getenv("OPENAI_API_KEY"),
			BaseURL:            strings.TrimRight(os.Getenv("OPENAI_BASE_URL"), "/"),
			Model:              os.Getenv("LLM_MODEL"),
			IntelligenceModels: splitList(os.Getenv("LLM_INTELLIGENCE_MODELS")),
			Timeout:            time.Duration(intVar("LLM_TIMEOUT_SECONDS", 280)) * time.Second,
		},

		AICallsPerRound: intVar("CALL_COUNT_ACCEPTED_IN_A_ROUND", 2),
		RoundDuration:   time.Duration(intVar("ROUND_MINUTES", 1)) * time.Minute,
	}

	if cfg.MongoURI == "" {
		errs = append(errs, errors.New("MONGODB_URI is required"))
	}
	if len(cfg.JWTSecret) == 0 {
		errs = append(errs, errors.New("JWT_SECRET is required"))
	}
	if cfg.LLM.Timeout <= 0 {
		errs = append(errs, errors.New("LLM_TIMEOUT_SECONDS must be positive"))
	}
	if n := len(cfg.LLM.IntelligenceModels); n != 0 && n != csvgen.IntelligenceLevels {
		errs = append(errs, fmt.Errorf("LLM_INTELLIGENCE_MODELS must list %d models, got %d", csvgen.IntelligenceLevels, n))
	}
	if cfg.MaxRefreshTokensPerUser < 1 {
		errs = append(errs, errors.New("MAX_REFRESH_TOKENS_PER_USER must be at least 1"))
	}
	return cfg, errors.Join(errs...)
}

func envOr(key, def string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return def
}

func splitList(raw string) []string {
	var out []string
	for _, part := range strings.Split(raw, ",") {
		if part = strings.TrimRight(strings.TrimSpace(part), "/"); part != "" {
			out = append(out, part)
		}
	}
	return out
}
