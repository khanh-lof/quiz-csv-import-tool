// Command server runs the QuizTool HTTP API.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"quiz-csv-import-tool/server/internal/api"
	"quiz-csv-import-tool/server/internal/auth"
	"quiz-csv-import-tool/server/internal/config"
	"quiz-csv-import-tool/server/internal/csvgen"
	"quiz-csv-import-tool/server/internal/store"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	if err := run(logger); err != nil {
		logger.Error("server stopped", "error", err)
		os.Exit(1)
	}
}

func run(logger *slog.Logger) error {
	if err := config.LoadDotEnv(".env"); err != nil {
		return fmt.Errorf("reading .env: %w", err)
	}
	cfg, err := config.FromEnv()
	if err != nil {
		return fmt.Errorf("configuration: %w", err)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	client, err := mongo.Connect(options.Client().ApplyURI(cfg.MongoURI))
	if err != nil {
		return fmt.Errorf("connecting to MongoDB: %w", err)
	}
	defer func() {
		disconnectCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = client.Disconnect(disconnectCtx)
	}()

	startupCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	if err := client.Ping(startupCtx, nil); err != nil {
		return fmt.Errorf("pinging MongoDB: %w", err)
	}
	users := store.NewMongo(client.Database(cfg.MongoDatabase).Collection(cfg.MongoCollection))
	if err := users.EnsureIndexes(startupCtx); err != nil {
		return fmt.Errorf("creating MongoDB indexes: %w", err)
	}

	if len(cfg.JWTSecret) < 32 {
		logger.Warn("JWT_SECRET is shorter than 32 bytes; use a longer secret for HS256")
	}
	if cfg.AdminAPIKey == "" {
		logger.Warn("ADMIN_API_KEY is not set; POST /api/users rejects every request")
	}
	var generator api.Generator
	if missing := cfg.LLM.Missing(); len(missing) > 0 {
		logger.Warn("CSV generation disabled, missing settings: " + strings.Join(missing, ", "))
	} else {
		generator = csvgen.NewClient(cfg.LLM.BaseURL, cfg.LLM.APIKey, cfg.LLM.Model, logger)
	}

	jwt := auth.NewJWT(cfg.JWTSecret, cfg.JWTIssuer, cfg.JWTAudience, cfg.AccessTokenTTL)
	srv := &api.Server{
		Users:           users,
		Auth:            auth.NewService(users, jwt, cfg.RefreshTokenTTL, cfg.MaxRefreshTokensPerUser),
		JWT:             jwt,
		Generator:       generator,
		AllowedOrigins:  cfg.AllowedOrigins,
		AdminAPIKey:     cfg.AdminAPIKey,
		RefreshTokenTTL: cfg.RefreshTokenTTL,
		AICallsPerRound: cfg.AICallsPerRound,
		RoundDuration:   cfg.RoundDuration,
		Logger:          logger,
	}

	httpServer := &http.Server{
		Addr:              net.JoinHostPort("", cfg.Port),
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       2 * time.Minute,
		// Must outlast the LLM call (up to 5 minutes).
		WriteTimeout: 6 * time.Minute,
		IdleTimeout:  2 * time.Minute,
	}

	errCh := make(chan error, 1)
	go func() {
		logger.Info("listening", "addr", httpServer.Addr, "allowedOrigins", cfg.AllowedOrigins)
		errCh <- httpServer.ListenAndServe()
	}()

	select {
	case err := <-errCh:
		return err
	case <-ctx.Done():
	}
	logger.Info("shutting down")
	shutdownCtx, cancelShutdown := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancelShutdown()
	if err := httpServer.Shutdown(shutdownCtx); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}
