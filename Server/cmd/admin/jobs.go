package main

import (
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"

	"quiz-csv-import-tool/server/internal/store"
)

func jobPath(id string) string {
	return "/jobs/" + url.PathEscape(id)
}

func (a *app) listJobs(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	q := r.URL.Query()
	f := jobFilter{User: q.Get("user"), Status: q.Get("status"), Platform: q.Get("platform"), Q: q.Get("q"), Page: pageParam(r)}
	jobs, total, err := a.db.ListJobs(ctx, f)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	users, err := a.db.JobUsernames(ctx)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	a.render(w, r, "jobs", "Jobs", "jobs", struct {
		Jobs   []store.Job
		Filter jobFilter
		Users  []string
		Pager  pager
		Back   string
	}{jobs, f, users, newPager(r, f.Page, total, len(jobs)), r.URL.RequestURI()})
}

func (a *app) showJob(w http.ResponseWriter, r *http.Request) {
	job, raw, err := a.db.Job(r.Context(), r.PathValue("id"))
	if err != nil {
		a.fail(w, r, err)
		return
	}
	a.render(w, r, "job", job.Title, "jobs", struct {
		Job  *store.Job
		Raw  bson.M
		Back string
	}{job, raw, r.URL.RequestURI()})
}

func (a *app) jobCSV(w http.ResponseWriter, r *http.Request) {
	job, _, err := a.db.Job(r.Context(), r.PathValue("id"))
	if err != nil {
		a.fail(w, r, err)
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	_, _ = w.Write([]byte(job.CSV))
}

// failJob fails one running job the way the server fails an interrupted one, keeping what it cost so far.
func (a *app) failJob(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	id := r.PathValue("id")
	back := backTo(r, jobPath(id))
	job, _, err := a.db.Job(ctx, id)
	if err != nil {
		a.failBack(w, r, back, err)
		return
	}
	if job.Status != store.JobRunning {
		a.failBack(w, r, back, errors.New("the job is not running any more"))
		return
	}
	var usage store.JobUsage
	if job.Usage != nil {
		usage = *job.Usage
	}
	failure := store.JobFailure{Status: store.ExpiredJobStatus, Code: store.ExpiredJobCode, Message: "Stopped from the admin app"}
	if err := a.jobs.Fail(ctx, job.Username, id, failure, usage); err != nil {
		a.failBack(w, r, back, err)
		return
	}
	a.done(w, r, back, "Job marked as failed")
}

// failStaleJobs expires, through the store, every running job that has been silent for longer than
// staleAfter, the ones the server would have resumed or expired if it were still running.
func (a *app) failStaleJobs(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	back := backTo(r, "/jobs")
	usernames, err := a.db.RunningJobUsernames(ctx)
	if err != nil {
		a.failBack(w, r, back, err)
		return
	}
	cutoffs := store.ExpiryCutoffs{Before: time.Now().Add(-staleAfter)}
	expired := 0
	for _, username := range usernames {
		jobs, err := a.jobs.ExpireRunning(ctx, username, cutoffs, "No heartbeat; failed from the admin app")
		expired += len(jobs)
		if err != nil {
			a.failBack(w, r, back, err)
			return
		}
	}
	a.done(w, r, back, fmt.Sprintf("%d stale jobs marked as failed", expired))
}

func (a *app) deleteJob(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	id := r.PathValue("id")
	job, _, err := a.db.Job(ctx, id)
	if err != nil {
		a.failBack(w, r, jobPath(id), err)
		return
	}
	if err := a.jobs.Delete(ctx, job.Username, id); err != nil {
		a.failBack(w, r, jobPath(id), err)
		return
	}
	a.done(w, r, backTo(r, "/jobs"), "Job deleted")
}
