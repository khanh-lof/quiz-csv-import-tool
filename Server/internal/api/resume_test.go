package api

import (
	"context"
	"testing"
	"time"

	"quiz-csv-import-tool/server/internal/csvgen"
	"quiz-csv-import-tool/server/internal/store"
)

// interruptedJob stores a High intelligence job of alice that has been running without a heartbeat since age
// ago, counted in the rate-limit round of roundStart, with images kept in env's image store.
func interruptedJob(t *testing.T, env *testEnv, id string, intelligence int, age time.Duration, roundStart time.Time) *store.Job {
	t.Helper()
	ctx := context.Background()
	refs, err := env.images.Store(ctx, []csvgen.Image{{ContentType: "image/jpeg", Data: []byte("page-" + id)}})
	if err != nil {
		t.Fatal(err)
	}
	storedAt := testClockStart
	job := &store.Job{
		ID: id, Username: "alice", Status: store.JobRunning, Title: id, Creative: true, ExportType: ptr(0), Intelligence: intelligence,
		CourseType: ptr(1), Level: ptr(6), LessonNumbers: []int{1}, ImageCount: 1, Images: refs, ImagesStoredAt: &storedAt,
		ProgressRows: 5, RoundStart: roundStart, CreatedAt: time.Now().Add(-age).UTC().Truncate(time.Millisecond),
	}
	if err := env.jobs.Create(ctx, job); err != nil {
		t.Fatal(err)
	}
	return job
}

func aiCallsInRound(t *testing.T, env *testEnv) int {
	t.Helper()
	user, err := env.users.FindByUsername(context.Background(), "alice")
	if err != nil {
		t.Fatal(err)
	}
	return user.AICallCountInRound
}

func TestResumeJobRunsAnInterruptedJobAgain(t *testing.T) {
	env := newEnv(t)
	ctx := context.Background()
	roundStart, _, _ := env.users.TryConsumeAICall(ctx, "alice", 2, time.Minute)
	interruptedJob(t, env, "stuck", csvgen.HighIntelligence, 5*time.Minute, roundStart)
	interruptedJob(t, env, "low", 1, 5*time.Minute, roundStart)
	interruptedJob(t, env, "fresh", csvgen.HighIntelligence, 0, roundStart)

	job, err := env.srv.ClaimInterruptedJob(ctx)
	if err != nil || job == nil || job.ID != "stuck" || job.Resumes != 1 || job.ProgressRows != 0 {
		t.Fatalf("claimed %+v %v", job, err)
	}
	if again, err := env.srv.ClaimInterruptedJob(ctx); err != nil || again != nil {
		t.Fatalf("claimed again %+v %v", again, err)
	}

	env.srv.ResumeJob(ctx, job)
	done, _ := env.jobs.Get(ctx, "alice", "stuck")
	if done.Status != store.JobDone || done.Resumes != 1 || len(done.Images) != 1 {
		t.Fatalf("resumed job %+v", done)
	}
	if len(env.gen.images) != 1 || string(env.gen.images[0].Data) != "page-stuck" || !env.gen.creative ||
		env.gen.opts.Intelligence != csvgen.HighIntelligence || env.gen.opts.Level == nil || *env.gen.opts.Level != 6 {
		t.Fatalf("generator got %+v %+v", env.gen.images, env.gen.opts)
	}
	// The images were kept already: nothing stored again. The call the job was counted as stays counted.
	if env.images.stored() != 3 || aiCallsInRound(t, env) != 1 {
		t.Fatalf("%d images stored, %d calls in the round", env.images.stored(), aiCallsInRound(t, env))
	}
}

func TestResumeJobFailsAJobItCannotRunAgain(t *testing.T) {
	env := newEnv(t)
	ctx := context.Background()
	roundStart, _, _ := env.users.TryConsumeAICall(ctx, "alice", 2, time.Minute)
	stuck := interruptedJob(t, env, "stuck", csvgen.HighIntelligence, 5*time.Minute, roundStart)
	env.images.forget(stuck.Images[0].PublicID)

	job, _ := env.srv.ClaimInterruptedJob(ctx)
	env.srv.ResumeJob(ctx, job)
	failed, _ := env.jobs.Get(ctx, "alice", "stuck")
	if failed.Status != store.JobFailed || failed.ErrorCode != store.ExpiredJobCode || failed.ErrorMessage != interruptedMessage ||
		env.gen.calls != 0 {
		t.Fatalf("job %+v, generator called %d times", failed, env.gen.calls)
	}
	if aiCallsInRound(t, env) != 0 {
		t.Fatal("the call was not given back")
	}
}

func TestListJobsLeavesInterruptedHighJobsToTheirServer(t *testing.T) {
	env := newEnv(t)
	token, _ := env.login(t, "alice", "pw")
	remote := &remoteServer{}
	env.srv.HighIntelligenceProxy = remote
	interruptedJob(t, env, "high-waiting", csvgen.HighIntelligence, 5*time.Minute, time.Time{})
	interruptedJob(t, env, "low-dead", 1, 5*time.Minute, time.Time{})
	interruptedJob(t, env, "high-dead", csvgen.HighIntelligence, resumeGiveUp+time.Minute, time.Time{})

	status := map[string]any{}
	for _, view := range env.listJobs(t, token) {
		status[view["title"].(string)] = view["status"]
	}
	if status["high-waiting"] != "running" || status["low-dead"] != "failed" || status["high-dead"] != "failed" {
		t.Fatalf("statuses %v", status)
	}
	// It woke the High intelligence server for the waiting job, and does not again within wakeEvery.
	env.listJobs(t, token)
	if remote.wakes != 1 {
		t.Fatalf("woke it %d times", remote.wakes)
	}

	// Without a High intelligence server, nobody would take the job over: it fails like the others.
	env.srv.HighIntelligenceProxy = nil
	if view := env.listJobs(t, token); view[0]["status"] != "failed" || view[1]["status"] != "failed" || view[2]["status"] != "failed" {
		t.Fatalf("jobs %v", view)
	}
}
