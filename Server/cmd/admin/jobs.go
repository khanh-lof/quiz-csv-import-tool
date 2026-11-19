package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"

	"quiz-csv-import-tool/server/internal/api"
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

// abandonedCutoffs are the server's own (api.AbandonedCutoffs), with the AI server's longer wait when this
// configuration has one.
func (a *app) abandonedCutoffs(now time.Time) store.ExpiryCutoffs {
	return api.AbandonedCutoffs(now, a.cfg.AIServer != nil)
}

// staleRule words the cutoffs for the pages, e.g. "no heartbeat for 3 minutes".
func (a *app) staleRule() string {
	now := time.Now()
	cutoffs := a.abandonedCutoffs(now)
	rule := "no heartbeat for " + minutes(now.Sub(cutoffs.Before))
	if cutoffs.Resumable {
		rule += ", or " + minutes(now.Sub(cutoffs.ResumableBefore)) + " for a quiz the AI server can still resume"
	}
	return rule
}

func minutes(d time.Duration) string {
	n := int(d.Round(time.Minute).Minutes())
	if n == 1 {
		return "1 minute"
	}
	return strconv.Itoa(n) + " minutes"
}

// refund gives the teacher back the AI call the job was counted as, as the server does for a job that failed.
// A failed refund only costs the teacher one call until their round ends, so it does not fail the action.
func (a *app) refund(ctx context.Context, job store.Job) {
	if err := a.users.RefundAICall(ctx, job.Username, job.RoundStart); err != nil {
		a.log.Warn("refunding AI call failed", "user", job.Username, "job", job.ID, "error", err)
	}
}

// failJob fails one running job the way the server fails an interrupted one, keeping what it cost so far, and gives
// the teacher the call back.
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
	a.refund(ctx, *job)
	a.done(w, r, back, "Job marked as failed. The teacher got the AI call back.")
}

// failStaleJobs does for every user at once what the server does for a teacher when they open their jobs: it fails
// the abandoned ones and gives the calls back.
func (a *app) failStaleJobs(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	back := backTo(r, "/jobs")
	usernames, err := a.db.RunningJobUsernames(ctx)
	if err != nil {
		a.failBack(w, r, back, err)
		return
	}
	cutoffs := a.abandonedCutoffs(time.Now())
	expired := 0
	for _, username := range usernames {
		jobs, err := a.jobs.ExpireRunning(ctx, username, cutoffs, "No heartbeat; failed from the admin app")
		for _, job := range jobs {
			a.refund(ctx, job)
		}
		expired += len(jobs)
		if err != nil {
			a.failBack(w, r, back, err)
			return
		}
	}
	switch expired {
	case 0:
		a.done(w, r, back, "No job was stale: "+a.staleRule()+".")
	case 1:
		a.done(w, r, back, "1 stale job marked as failed. Its teacher got the AI call back.")
	default:
		a.done(w, r, back, fmt.Sprintf("%d stale jobs marked as failed. Their teachers got the AI calls back.", expired))
	}
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
