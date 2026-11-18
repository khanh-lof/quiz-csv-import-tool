package main

import (
	"errors"
	"net/http"
	"strconv"
	"time"

	"quiz-csv-import-tool/server/internal/store"
)

func (a *app) dashboard(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	since := time.Now().AddDate(0, 0, -30)
	o, err := a.db.Overview(ctx)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	running, err := a.db.RunningJobs(ctx)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	failures, err := a.db.RecentFailures(ctx, 8)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	usage, err := a.db.UsageByModel(ctx, since)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	top, err := a.db.TopUsers(ctx, since, 10)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	days, err := a.db.JobsPerDay(ctx, 14)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	busiest := 0
	for _, d := range days {
		busiest = max(busiest, d.Total())
	}
	a.render(w, r, "dashboard", "Dashboard", "dashboard", struct {
		Overview overview
		Running  []store.Job
		Failures []store.Job
		Usage    []modelUsage
		TopUsers []userActivity
		Days     []dayCount
		Busiest  int
		Back     string
	}{o, running, failures, usage, top, days, busiest, r.URL.RequestURI()})
}

func (a *app) listQuestions(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	q := r.URL.Query()
	lesson, _ := strconv.Atoi(q.Get("lesson"))
	f := questionFilter{Book: q.Get("book"), Lesson: lesson, Status: q.Get("status"), Q: q.Get("q"), Page: pageParam(r)}
	summary, err := a.db.BankSummary(ctx)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	list, total, err := a.db.ListQuestions(ctx, f)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	a.render(w, r, "bank", "Question bank", "bank", struct {
		Summary   []bookSummary
		Questions []store.Question
		Filter    questionFilter
		Pager     pager
		Back      string
	}{summary, list, f, newPager(r, f.Page, total, len(list)), r.URL.RequestURI()})
}

func (a *app) setQuestionStatus(w http.ResponseWriter, r *http.Request) {
	status := r.FormValue("status")
	back := backTo(r, "/bank")
	if status != store.QuestionActive && status != store.QuestionRetired {
		a.failBack(w, r, back, errors.New("status must be active or retired"))
		return
	}
	if err := a.db.SetQuestionStatus(r.Context(), r.PathValue("id"), status); err != nil {
		a.failBack(w, r, back, err)
		return
	}
	if status == store.QuestionActive {
		a.done(w, r, back, "Question brought back")
		return
	}
	a.done(w, r, back, "Question retired")
}
