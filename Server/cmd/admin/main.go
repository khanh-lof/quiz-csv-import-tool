// Command admin runs a web page to manage QuizTool by hand: users, AI jobs, assignments and the question
// bank. It is meant to run on the admin's own machine against the database in .env, so it has no login and
// only listens on 127.0.0.1:
//
//	go run ./cmd/admin    # http://127.0.0.1:7072 (ADMIN_PORT)
package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"html/template"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"quiz-csv-import-tool/server/internal/config"
	"quiz-csv-import-tool/server/internal/store"
)

type app struct {
	cfg         config.Config
	clientURL   string
	db          *queries
	users       *store.Mongo
	jobs        *store.MongoJobs
	assignments *store.MongoAssignments
	logins      *store.MongoLoginAttempts
	templates   map[string]*template.Template
	log         *slog.Logger
}

func main() {
	log := slog.New(slog.NewTextHandler(os.Stderr, nil))
	if err := run(log); err != nil {
		log.Error("admin stopped", "error", err)
		os.Exit(1)
	}
}

func run(log *slog.Logger) error {
	if err := config.LoadDotEnv(".env"); err != nil {
		return fmt.Errorf("reading .env: %w", err)
	}
	// Only the MongoDB settings matter here; other missing settings are not an error.
	cfg, _ := config.FromEnv()
	if cfg.MongoURI == "" {
		return errors.New("MONGODB_URI is required")
	}
	addr := "127.0.0.1:" + envOr("ADMIN_PORT", "7072")

	client, err := mongo.Connect(options.Client().ApplyURI(cfg.MongoURI).SetServerSelectionTimeout(5 * time.Second))
	if err != nil {
		return fmt.Errorf("connecting to MongoDB: %w", err)
	}
	defer func() {
		disconnectCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = client.Disconnect(disconnectCtx)
	}()
	pingCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	if err := client.Ping(pingCtx, nil); err != nil {
		log.Warn("MongoDB does not answer yet; the pages show the error until it does", "error", err)
	}
	cancel()

	db := client.Database(cfg.MongoDatabase)
	a := &app{
		cfg:         cfg,
		clientURL:   strings.TrimRight(envOr("ADMIN_CLIENT_URL", "http://localhost:4200"), "/"),
		db:          newQueries(db, cfg),
		users:       store.NewMongo(db.Collection(cfg.MongoCollection)),
		jobs:        store.NewMongoJobs(db.Collection(cfg.MongoJobsCollection)),
		assignments: store.NewMongoAssignments(db.Collection(cfg.MongoAssignmentsCollection), db.Collection(cfg.MongoPlayersCollection)),
		logins:      store.NewMongoLoginAttempts(db.Collection(cfg.MongoLoginAttemptsCollection)),
		log:         log,
	}
	if a.templates, err = a.loadTemplates(); err != nil {
		return err
	}

	server := &http.Server{Addr: addr, Handler: a.routes(), ReadHeaderTimeout: 10 * time.Second}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdownCtx)
	}()

	log.Info("QuizTool admin running", "url", "http://"+addr, "mongo", a.mongoHost(), "database", cfg.MongoDatabase)
	if err := server.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

func envOr(key, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return fallback
}

// mongoHost is the URI's host without its credentials, safe to show on every page.
func (a *app) mongoHost() string {
	u, err := url.Parse(a.cfg.MongoURI)
	if err != nil {
		return "?"
	}
	return u.Host
}

// localMongo says whether the database runs on this machine or in a local VM (a private address), so the
// header can warn when the pages change a remote one.
func (a *app) localMongo() bool {
	host := a.mongoHost()
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && (ip.IsLoopback() || ip.IsPrivate())
}

func (a *app) routes() http.Handler {
	mux := http.NewServeMux()
	static, _ := fs.Sub(assets, "static")
	mux.Handle("GET /static/", http.StripPrefix("/static/", http.FileServerFS(static)))

	mux.HandleFunc("GET /{$}", a.dashboard)

	mux.HandleFunc("GET /users", a.listUsers)
	mux.HandleFunc("POST /users", a.createUser)
	mux.HandleFunc("GET /users/{name}", a.showUser)
	mux.HandleFunc("POST /users/{name}/password", a.setPassword)
	mux.HandleFunc("POST /users/{name}/roles", a.setRoles)
	mux.HandleFunc("POST /users/{name}/sessions/revoke", a.revokeSessions)
	mux.HandleFunc("POST /users/{name}/rate-limit/reset", a.resetRateLimit)
	mux.HandleFunc("POST /users/{name}/delete", a.deleteUser)
	mux.HandleFunc("POST /login-attempts/{key}/delete", a.clearLoginAttempts)

	mux.HandleFunc("GET /jobs", a.listJobs)
	mux.HandleFunc("POST /jobs/fail-stale", a.failStaleJobs)
	mux.HandleFunc("GET /jobs/{id}", a.showJob)
	mux.HandleFunc("GET /jobs/{id}/csv", a.jobCSV)
	mux.HandleFunc("POST /jobs/{id}/fail", a.failJob)
	mux.HandleFunc("POST /jobs/{id}/delete", a.deleteJob)

	mux.HandleFunc("GET /assignments", a.listAssignments)
	mux.HandleFunc("GET /assignments/{id}", a.showAssignment)
	mux.HandleFunc("POST /assignments/{id}/close", a.closeAssignment)
	mux.HandleFunc("POST /assignments/{id}/reopen", a.reopenAssignment)
	mux.HandleFunc("POST /assignments/{id}/deadline", a.setDeadline)
	mux.HandleFunc("POST /assignments/{id}/delete", a.deleteAssignment)
	mux.HandleFunc("POST /assignments/{id}/players/{player}/delete", a.deletePlayer)

	mux.HandleFunc("GET /bank", a.listQuestions)
	mux.HandleFunc("POST /bank/{id}/status", a.setQuestionStatus)

	return localOnly(http.NewCrossOriginProtection().Handler(mux))
}

// localOnly refuses requests addressed to another host name, so a web page cannot reach this app through
// DNS rebinding; CrossOriginProtection refuses the cross-site form posts.
func localOnly(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		host, _, err := net.SplitHostPort(r.Host)
		if err != nil {
			host = r.Host
		}
		if host != "127.0.0.1" && host != "localhost" && host != "::1" {
			http.Error(w, "The admin app only answers on localhost", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}

type page struct {
	Title      string
	Nav        string
	Database   string
	MongoHost  string
	LocalMongo bool
	OK         string
	Error      string
	Data       any
}

func (a *app) render(w http.ResponseWriter, r *http.Request, name, title, nav string, data any) {
	a.renderStatus(w, r, http.StatusOK, name, title, nav, data)
}

func (a *app) renderStatus(w http.ResponseWriter, r *http.Request, status int, name, title, nav string, data any) {
	t, ok := a.templates[name]
	if !ok {
		http.Error(w, "unknown template "+name, http.StatusInternalServerError)
		return
	}
	p := page{
		Title:      title,
		Nav:        nav,
		Database:   a.cfg.MongoDatabase,
		MongoHost:  a.mongoHost(),
		LocalMongo: a.localMongo(),
		OK:         r.URL.Query().Get("ok"),
		Error:      r.URL.Query().Get("err"),
		Data:       data,
	}
	var buf bytes.Buffer
	if err := t.ExecuteTemplate(&buf, "layout", p); err != nil {
		a.log.Error("rendering failed", "template", name, "error", err)
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_, _ = buf.WriteTo(w)
}

func (a *app) fail(w http.ResponseWriter, r *http.Request, err error) {
	status := http.StatusInternalServerError
	if errors.Is(err, store.ErrNotFound) {
		status = http.StatusNotFound
	} else {
		a.log.Error("request failed", "path", r.URL.Path, "error", err)
	}
	a.renderStatus(w, r, status, "error", "Error", "", err.Error())
}

// done and failBack end a form post by going back to a page that shows the outcome.
func (a *app) done(w http.ResponseWriter, r *http.Request, target, message string) {
	http.Redirect(w, r, withParam(target, "ok", message), http.StatusSeeOther)
}

func (a *app) failBack(w http.ResponseWriter, r *http.Request, target string, err error) {
	if !errors.Is(err, store.ErrNotFound) && !errors.Is(err, store.ErrDuplicate) {
		a.log.Error("action failed", "path", r.URL.Path, "error", err)
	}
	http.Redirect(w, r, withParam(target, "err", err.Error()), http.StatusSeeOther)
}

func withParam(target, key, value string) string {
	u, err := url.Parse(target)
	if err != nil {
		return target
	}
	q := u.Query()
	q.Del("ok")
	q.Del("err")
	q.Set(key, value)
	u.RawQuery = q.Encode()
	return u.String()
}

// backTo is the local page a form posted from (its "back" field), or fallback.
func backTo(r *http.Request, fallback string) string {
	back := r.FormValue("back")
	if strings.HasPrefix(back, "/") && !strings.HasPrefix(back, "//") {
		return back
	}
	return fallback
}
