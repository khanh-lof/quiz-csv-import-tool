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

// shutdownGrace is how long a stopping server waits for running handlers, a little under Render's
// maxShutdownDelaySeconds of 300.
const shutdownGrace = 290 * time.Second

func run(logger *slog.Logger) error {
	// The lesson documents are embedded and checked when csvgen loads; a broken one must stop the server here,
	// not surface as quizzes quietly built without their LESSON MATERIAL.
	if err := csvgen.TextbooksError(); err != nil {
		return fmt.Errorf("textbooks: %w", err)
	}
	if err := config.LoadDotEnv(".env"); err != nil {
		return fmt.Errorf("reading .env: %w", err)
	}
	cfg, err := config.FromEnv()
	if err != nil {
		return fmt.Errorf("configuration: %w", err)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	startupCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	pool, err := store.OpenPostgres(startupCtx, cfg.DatabaseURL)
	if err != nil {
		return fmt.Errorf("connecting to PostgreSQL: %w", err)
	}
	defer pool.Close()
	if err := store.Migrate(startupCtx, pool); err != nil {
		return fmt.Errorf("creating the database tables: %w", err)
	}
	users := store.NewPostgresUsers(pool)

	if cfg.AdminAPIKey == "" {
		logger.Warn("ADMIN_API_KEY is not set; POST /api/users rejects every request")
	}
	var generator api.Generator
	if missing := cfg.LLM.Missing(); len(missing) > 0 {
		logger.Warn("CSV generation disabled, missing settings: " + strings.Join(missing, ", "))
	} else {
		generator = csvgen.NewClient(cfg.LLM.BaseURL, cfg.LLM.APIKey, cfg.LLM.Model, cfg.LLM.IntelligenceModels, logger)
	}

	jwt := auth.NewJWT(cfg.JWTSecret, cfg.JWTIssuer, cfg.JWTAudience, cfg.AccessTokenTTL)
	srv := &api.Server{
		Users:            users,
		Jobs:             store.NewPostgresJobs(pool),
		Assignments:      store.NewPostgresAssignments(pool),
		LoginAttempts:    store.NewPostgresLoginAttempts(pool),
		Auth:             auth.NewService(users, jwt, cfg.RefreshTokenTTL, cfg.MaxRefreshTokensPerUser),
		JWT:              jwt,
		Generator:        generator,
		AdminAPIKey:      cfg.AdminAPIKey,
		RefreshTokenTTL:  cfg.RefreshTokenTTL,
		AICallsPerRound:  cfg.AICallsPerRound,
		RoundDuration:    cfg.RoundDuration,
		LoginMaxAttempts: cfg.LoginMaxAttempts,
		LoginWindow:      cfg.LoginWindow,
		StageSeconds:     cfg.GameStageSeconds,
		Logger:           logger,
	}

	httpServer := &http.Server{
		Addr:              net.JoinHostPort("", cfg.Port),
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       2 * time.Minute,
		// Bounds writing a response; a job's handler goes on generating after its 202 is written, unaffected.
		WriteTimeout: 2 * time.Minute,
		IdleTimeout:  2 * time.Minute,
	}

	errCh := make(chan error, 1)
	go func() {
		logger.Info("listening", "addr", httpServer.Addr)
		errCh <- httpServer.ListenAndServe()
	}()

	select {
	case err := <-errCh:
		return err
	case <-ctx.Done():
	}
	// A second signal kills the process at once.
	stop()
	// Shutdown waits for the handlers still running, which includes AI jobs still generating, so a deploy
	// lets them finish. Render kills the process maxShutdownDelaySeconds (render.yaml) after SIGTERM; a job
	// cut off then is failed as interrupted once its heartbeat is missed.
	logger.Info("shutting down")
	shutdownCtx, cancelShutdown := context.WithTimeout(context.Background(), shutdownGrace)
	defer cancelShutdown()
	if err := httpServer.Shutdown(shutdownCtx); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}
