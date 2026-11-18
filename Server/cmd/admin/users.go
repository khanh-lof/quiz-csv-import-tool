package main

import (
	"context"
	"errors"
	"fmt"
	"math"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"time"

	"quiz-csv-import-tool/server/internal/auth"
	"quiz-csv-import-tool/server/internal/store"
)

type userRow struct {
	store.User
	Stats   userStats
	Lockout *lockout
}

type lockout struct {
	loginAttempt
	Username string
	Locked   bool
}

func userPath(username string) string {
	return "/users/" + url.PathEscape(username)
}

// lockouts pairs the running login-attempt windows with the users they count, by the key the server
// stores them under.
func (a *app) lockouts(ctx context.Context, users []store.User) ([]lockout, error) {
	attempts, err := a.db.LoginAttempts(ctx)
	if err != nil {
		return nil, err
	}
	byKey := map[string]string{}
	for _, u := range users {
		byKey[auth.HashKey(u.Username)] = u.Username
	}
	out := make([]lockout, len(attempts))
	for i, at := range attempts {
		out[i] = lockout{loginAttempt: at, Username: byKey[at.Key], Locked: at.Count >= a.cfg.LoginMaxAttempts}
	}
	return out, nil
}

func (a *app) listUsers(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	users, err := a.db.ListUsers(ctx)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	stats, err := a.db.UserStats(ctx)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	lockouts, err := a.lockouts(ctx, users)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	byUser := map[string]*lockout{}
	for i := range lockouts {
		if lockouts[i].Username != "" {
			byUser[lockouts[i].Username] = &lockouts[i]
		}
	}

	q := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("q")))
	role := r.URL.Query().Get("role")
	var rows []userRow
	for _, u := range users {
		if q != "" && !strings.Contains(strings.ToLower(u.Username), q) {
			continue
		}
		if role != "" && !hasRole(u, role) {
			continue
		}
		row := userRow{User: u, Lockout: byUser[u.Username]}
		if s := stats[u.Username]; s != nil {
			row.Stats = *s
		}
		rows = append(rows, row)
	}

	a.render(w, r, "users", "Users", "users", struct {
		Users       []userRow
		Total       int
		Q           string
		Role        string
		Lockouts    []lockout
		MaxAttempts int
	}{rows, len(users), r.URL.Query().Get("q"), role, lockouts, a.cfg.LoginMaxAttempts})
}

func rolesFromForm(r *http.Request) []string {
	roles := []string{}
	add := func(role string) {
		role = strings.TrimSpace(role)
		if role != "" && !slices.ContainsFunc(roles, func(have string) bool { return strings.EqualFold(have, role) }) {
			roles = append(roles, role)
		}
	}
	for _, role := range r.Form["role"] {
		add(role)
	}
	for role := range strings.SplitSeq(r.FormValue("otherRoles"), ",") {
		add(role)
	}
	return roles
}

// createUser stores the user the way POST /api/users does.
func (a *app) createUser(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseForm(); err != nil {
		a.failBack(w, r, "/users", err)
		return
	}
	username := strings.TrimSpace(r.FormValue("username"))
	password := r.FormValue("password")
	if username == "" || strings.TrimSpace(password) == "" {
		a.failBack(w, r, "/users", errors.New("username and password are required"))
		return
	}
	hash, err := auth.HashPassword(password)
	if err != nil {
		a.failBack(w, r, "/users", err)
		return
	}
	err = a.users.Create(r.Context(), &store.User{
		Username:     username,
		PasswordHash: hash,
		Roles:        rolesFromForm(r),
		CreatedAt:    time.Now().UTC(),
	})
	if errors.Is(err, store.ErrDuplicate) {
		a.failBack(w, r, "/users", fmt.Errorf("user %q already exists", username))
		return
	}
	if err != nil {
		a.failBack(w, r, "/users", err)
		return
	}
	a.done(w, r, userPath(username), "User created")
}

func (a *app) showUser(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	name := r.PathValue("name")
	u, err := a.users.FindByUsername(ctx, name)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	jobs, jobTotal, err := a.db.ListJobs(ctx, jobFilter{User: name, Page: 1})
	if err != nil {
		a.fail(w, r, err)
		return
	}
	assignments, err := a.assignments.List(ctx, name, 10)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	assignmentTotal, err := a.assignments.Count(ctx, name)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	rows, err := a.assignmentRows(ctx, assignments)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	lockouts, err := a.lockouts(ctx, []store.User{*u})
	if err != nil {
		a.fail(w, r, err)
		return
	}
	var userLockout *lockout
	for i := range lockouts {
		if lockouts[i].Username == name {
			userLockout = &lockouts[i]
		}
	}

	a.render(w, r, "user", u.Username, "users", struct {
		User            *store.User
		Sessions        []store.RefreshToken
		Jobs            []store.Job
		JobTotal        int64
		Assignments     []assignmentRow
		AssignmentTotal int
		Lockout         *lockout
		OtherRoles      string
		RoundEnds       *time.Time
		Back            string
	}{u, activeSessions(*u), jobs[:min(len(jobs), 10)], jobTotal, rows, assignmentTotal, userLockout,
		otherRoles(u.Roles), a.roundEnd(u), r.URL.RequestURI()})
}

// roundEnd is when the user's current AI rate-limit round ends, nil when none is running.
func (a *app) roundEnd(u *store.User) *time.Time {
	if u.StartRoundTime == nil {
		return nil
	}
	end := u.StartRoundTime.Add(a.cfg.RoundDuration)
	if end.Before(time.Now()) {
		return nil
	}
	return &end
}

func otherRoles(roles []string) string {
	var other []string
	for _, role := range roles {
		if !strings.EqualFold(role, "User") && !strings.EqualFold(role, auth.RoleAdmin) {
			other = append(other, role)
		}
	}
	return strings.Join(other, ", ")
}

func signOutEverywhere(s *store.Sessions) bool {
	if len(s.Active) == 0 {
		return false
	}
	s.Active = nil
	return true
}

func (a *app) setPassword(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	name := r.PathValue("name")
	password := r.FormValue("password")
	if strings.TrimSpace(password) == "" {
		a.failBack(w, r, userPath(name), errors.New("password is required"))
		return
	}
	hash, err := auth.HashPassword(password)
	if err != nil {
		a.failBack(w, r, userPath(name), err)
		return
	}
	if err := a.db.SetPasswordHash(ctx, name, hash); err != nil {
		a.failBack(w, r, userPath(name), err)
		return
	}
	if r.FormValue("signOut") == "on" {
		if err := a.users.UpdateSessions(ctx, name, signOutEverywhere); err != nil {
			a.failBack(w, r, userPath(name), err)
			return
		}
	}
	a.done(w, r, userPath(name), "Password changed")
}

func (a *app) setRoles(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	if err := r.ParseForm(); err != nil {
		a.failBack(w, r, userPath(name), err)
		return
	}
	if err := a.db.SetRoles(r.Context(), name, rolesFromForm(r)); err != nil {
		a.failBack(w, r, userPath(name), err)
		return
	}
	minutes := int(math.Ceil(a.cfg.AccessTokenTTL.Minutes()))
	a.done(w, r, userPath(name), fmt.Sprintf("Roles saved. They apply from the user's next token refresh (within %d minutes).", minutes))
}

func (a *app) revokeSessions(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	if err := a.users.UpdateSessions(r.Context(), name, signOutEverywhere); err != nil {
		a.failBack(w, r, userPath(name), err)
		return
	}
	a.done(w, r, userPath(name), "Signed out of every device")
}

func (a *app) resetRateLimit(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	if err := a.db.ResetRateLimit(r.Context(), name); err != nil {
		a.failBack(w, r, userPath(name), err)
		return
	}
	a.done(w, r, userPath(name), "AI rate limit reset")
}

func (a *app) deleteUser(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	name := r.PathValue("name")
	if err := a.db.DeleteUser(ctx, name); err != nil {
		a.failBack(w, r, userPath(name), err)
		return
	}
	if err := a.logins.Reset(ctx, auth.HashKey(name)); err != nil {
		a.failBack(w, r, "/users", err)
		return
	}
	message := "Deleted user " + name
	if r.FormValue("withData") == "on" {
		jobs, assignments, err := a.deleteUserData(ctx, name)
		if err != nil {
			a.failBack(w, r, "/users", fmt.Errorf("user deleted, but deleting their data failed: %w", err))
			return
		}
		message += fmt.Sprintf(" with %d jobs and %d assignments", jobs, assignments)
	}
	a.done(w, r, "/users", message)
}

// deleteUserData removes every job and assignment (with its players) of the user through the stores. Running
// jobs are failed first, since the stores never delete a job still being worked on.
func (a *app) deleteUserData(ctx context.Context, username string) (jobs, assignments int, err error) {
	_, jobTotal, err := a.db.ListJobs(ctx, jobFilter{User: username, Page: 1})
	if err != nil {
		return 0, 0, err
	}
	if _, err := a.jobs.ExpireRunning(ctx, username, store.ExpiryCutoffs{Before: time.Now().Add(time.Minute)}, "User deleted"); err != nil {
		return 0, 0, err
	}
	if err := a.jobs.Prune(ctx, username, 0); err != nil {
		return 0, 0, err
	}

	count, err := a.assignments.Count(ctx, username)
	if err != nil {
		return int(jobTotal), 0, err
	}
	list, err := a.assignments.List(ctx, username, count)
	if err != nil {
		return int(jobTotal), 0, err
	}
	for _, asg := range list {
		if err := a.assignments.Delete(ctx, username, asg.ID); err != nil {
			return int(jobTotal), assignments, err
		}
		assignments++
	}
	return int(jobTotal), assignments, nil
}

func (a *app) clearLoginAttempts(w http.ResponseWriter, r *http.Request) {
	if err := a.logins.Reset(r.Context(), r.PathValue("key")); err != nil {
		a.failBack(w, r, backTo(r, "/users"), err)
		return
	}
	a.done(w, r, backTo(r, "/users"), "Login attempts cleared")
}
