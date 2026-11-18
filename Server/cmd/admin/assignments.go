package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"quiz-csv-import-tool/server/internal/store"
)

type assignmentRow struct {
	store.Assignment
	Players int
}

func assignmentPath(id string) string {
	return "/assignments/" + url.PathEscape(id)
}

func (a *app) assignmentRows(ctx context.Context, list []store.Assignment) ([]assignmentRow, error) {
	ids := make([]string, len(list))
	for i, asg := range list {
		ids[i] = asg.ID
	}
	counts, err := a.assignments.CountPlayers(ctx, ids)
	if err != nil {
		return nil, err
	}
	rows := make([]assignmentRow, len(list))
	for i, asg := range list {
		rows[i] = assignmentRow{Assignment: asg, Players: counts[asg.ID]}
	}
	return rows, nil
}

func (a *app) listAssignments(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	q := r.URL.Query()
	f := assignmentFilter{User: q.Get("user"), State: q.Get("state"), Q: q.Get("q"), Page: pageParam(r)}
	list, total, err := a.db.ListAssignments(ctx, f)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	rows, err := a.assignmentRows(ctx, list)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	users, err := a.db.AssignmentUsernames(ctx)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	a.render(w, r, "assignments", "Assignments", "assignments", struct {
		Assignments []assignmentRow
		Filter      assignmentFilter
		Users       []string
		Pager       pager
	}{rows, f, users, newPager(r, f.Page, total, len(rows))})
}

func (a *app) showAssignment(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	asg, err := a.db.Assignment(ctx, r.PathValue("id"))
	if err != nil {
		a.fail(w, r, err)
		return
	}
	players, err := a.assignments.ListPlayers(ctx, asg.ID)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	a.render(w, r, "assignment", asg.Title, "assignments", struct {
		Assignment *store.Assignment
		Players    []store.Player
	}{asg, players})
}

// updateAssignment applies the change through the store, which needs the owner's username.
func (a *app) updateAssignment(w http.ResponseWriter, r *http.Request, change store.AssignmentUpdate, message string) {
	ctx := r.Context()
	id := r.PathValue("id")
	asg, err := a.db.Assignment(ctx, id)
	if err != nil {
		a.failBack(w, r, assignmentPath(id), err)
		return
	}
	if _, err := a.assignments.Update(ctx, asg.Username, id, change); err != nil {
		a.failBack(w, r, assignmentPath(id), err)
		return
	}
	a.done(w, r, assignmentPath(id), message)
}

func (a *app) closeAssignment(w http.ResponseWriter, r *http.Request) {
	now := time.Now().UTC()
	a.updateAssignment(w, r, store.AssignmentUpdate{ClosedAt: store.TimeChange{Set: true, Value: &now}}, "Assignment closed")
}

func (a *app) reopenAssignment(w http.ResponseWriter, r *http.Request) {
	a.updateAssignment(w, r, store.AssignmentUpdate{ClosedAt: store.TimeChange{Set: true}}, "Assignment reopened (its deadline still applies)")
}

func (a *app) setDeadline(w http.ResponseWriter, r *http.Request) {
	value := strings.TrimSpace(r.FormValue("closesAt"))
	if value == "" || r.FormValue("clear") != "" {
		a.updateAssignment(w, r, store.AssignmentUpdate{ClosesAt: store.TimeChange{Set: true}}, "Deadline removed")
		return
	}
	closesAt, err := time.ParseInLocation("2006-01-02T15:04", value, time.Local)
	if err != nil {
		a.failBack(w, r, assignmentPath(r.PathValue("id")), errors.New("the deadline is not a valid date and time"))
		return
	}
	a.updateAssignment(w, r, store.AssignmentUpdate{ClosesAt: store.TimeChange{Set: true, Value: &closesAt}},
		"Deadline set to "+closesAt.Format("2006-01-02 15:04"))
}

func (a *app) deleteAssignment(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	id := r.PathValue("id")
	asg, err := a.db.Assignment(ctx, id)
	if err != nil {
		a.failBack(w, r, assignmentPath(id), err)
		return
	}
	if err := a.assignments.Delete(ctx, asg.Username, id); err != nil {
		a.failBack(w, r, assignmentPath(id), err)
		return
	}
	a.done(w, r, backTo(r, "/assignments"), fmt.Sprintf("Assignment %q deleted with its players", asg.Title))
}

func (a *app) deletePlayer(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if err := a.assignments.DeletePlayer(r.Context(), id, r.PathValue("player")); err != nil {
		a.failBack(w, r, assignmentPath(id), err)
		return
	}
	a.done(w, r, assignmentPath(id), "Player removed")
}
