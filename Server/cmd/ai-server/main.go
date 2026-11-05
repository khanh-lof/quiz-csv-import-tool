// Command ai-server runs the creative AI jobs at High intelligence ("Cao") on a long-lived host (Render), where
// a generation has no time limit. The main server (cmd/server, on Vercel) forwards those jobs here and serves
// everything else, the job list included; both share the MongoDB jobs and users and the JWT secret.
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
	"sync/atomic"
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

const (
	// shutdownGrace is how long a stopping server waits for running jobs, a little under Render's
	// maxShutdownDelaySeconds of 300.
	shutdownGrace = 290 * time.Second
	// keepAwakeEvery is how often a busy server requests its own public URL: well inside the 15 minutes
	// without inbound requests after which Render puts a free instance to sleep.
	keepAwakeEvery = 5 * time.Minute
)

func run(logger *slog.Logger) error {
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
	// Running AI jobs is all this server does.
	if missing := cfg.LLM.Missing(); len(missing) > 0 {
		return fmt.Errorf("configuration: missing %s", strings.Join(missing, ", "))
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
	db := client.Database(cfg.MongoDatabase)

	srv := &api.Server{
		Users: store.NewMongo(db.Collection(cfg.MongoCollection)),
		Jobs:  store.NewMongoJobs(db.Collection(cfg.MongoJobsCollection)),
		JWT:   auth.NewJWT(cfg.JWTSecret, cfg.JWTIssuer, cfg.JWTAudience, cfg.AccessTokenTTL),
		// No time limit: the call takes as long as the model needs (LLM_TIMEOUT_SECONDS is the main server's).
		Generator:       csvgen.NewClient(cfg.LLM.BaseURL, cfg.LLM.APIKey, cfg.LLM.Model, cfg.LLM.IntelligenceModels, 0, logger),
		AICallsPerRound: cfg.AICallsPerRound,
		RoundDuration:   cfg.RoundDuration,
		Logger:          logger,
	}

	var jobs activity
	if self := strings.TrimRight(os.Getenv("RENDER_EXTERNAL_URL"), "/"); self != "" {
		go jobs.keepAwake(ctx, self+"/healthz", keepAwakeEvery, logger)
	}

	httpServer := &http.Server{
		Addr:              net.JoinHostPort("", cfg.Port),
		Handler:           jobs.track(srv.HighIntelligenceHandler()),
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
	// Shutdown waits for the handlers still running, which are the AI jobs still generating, so a deploy lets
	// them finish. Render kills the process maxShutdownDelaySeconds (render.yaml) after SIGTERM; a job cut off
	// then is failed as interrupted by the main server once its heartbeat is missed.
	logger.Info("shutting down")
	shutdownCtx, cancelShutdown := context.WithTimeout(context.Background(), shutdownGrace)
	defer cancelShutdown()
	if err := httpServer.Shutdown(shutdownCtx); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

// activity counts the requests being handled, the health check aside. A job's handler runs until its job ends,
// so the count is above zero exactly while a job is generating.
type activity struct{ running atomic.Int64 }

func (a *activity) track(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/healthz" {
			a.running.Add(1)
			defer a.running.Add(-1)
		}
		next.ServeHTTP(w, r)
	})
}

// keepAwake requests url, the service's own public health check, every interval while a job runs, until ctx
// ends. A job's request ends with its 202, and Render puts a free instance to sleep after 15 minutes without
// inbound requests, which would cut off a longer job; a request through the public URL counts as inbound.
func (a *activity) keepAwake(ctx context.Context, url string, every time.Duration, logger *slog.Logger) {
	client := &http.Client{Timeout: 30 * time.Second}
	ticker := time.NewTicker(every)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		if a.running.Load() == 0 {
			continue
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		if err != nil {
			logger.Warn("keeping the instance awake failed", "error", err)
			return
		}
		resp, err := client.Do(req)
		if err != nil {
			logger.Warn("keeping the instance awake failed", "error", err)
			continue
		}
		_ = resp.Body.Close()
	}
}
