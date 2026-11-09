package store

import (
	"context"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// The same contract runs against both implementations; the Mongo one is skipped unless
// MONGODB_TEST_URI is set, like the other integration tests.
func TestMemoryJobs(t *testing.T) {
	testJobs(t, NewMemoryJobs())
	testJobImagesAndResumes(t, NewMemoryJobs())
}

func TestMongoJobs(t *testing.T) {
	uri := os.Getenv("MONGODB_TEST_URI")
	if uri == "" {
		t.Skip("MONGODB_TEST_URI not set")
	}
	client, err := mongo.Connect(options.Client().ApplyURI(uri))
	if err != nil {
		t.Fatal(err)
	}
	db := client.Database(fmt.Sprintf("quiztool_test_%d", time.Now().UnixNano()))
	t.Cleanup(func() {
		_ = db.Drop(context.Background())
		_ = client.Disconnect(context.Background())
	})
	for _, name := range []string{"Jobs", "ResumedJobs"} {
		jobs := NewMongoJobs(db.Collection(name))
		if err := jobs.EnsureIndexes(context.Background()); err != nil {
			t.Fatal(err)
		}
		if name == "Jobs" {
			testJobs(t, jobs)
		} else {
			testJobImagesAndResumes(t, jobs)
		}
	}
}

func testJobs(t *testing.T, jobs Jobs) {
	ctx := context.Background()
	base := time.Now().UTC().Truncate(time.Millisecond)
	newJob := func(id, username string, age time.Duration) *Job {
		return &Job{ID: id, Username: username, Status: JobRunning, Title: id, CreatedAt: base.Add(-age)}
	}

	// Create, duplicate ids, listing newest first and per user.
	for _, j := range []*Job{newJob("old", "alice", 3*time.Minute), newJob("mid", "alice", 2*time.Minute),
		newJob("new", "alice", time.Minute), newJob("bobs", "bob", 0)} {
		if err := jobs.Create(ctx, j); err != nil {
			t.Fatal(err)
		}
	}
	if err := jobs.Create(ctx, newJob("new", "alice", 0)); !errors.Is(err, ErrDuplicate) {
		t.Fatalf("want ErrDuplicate, got %v", err)
	}
	list, err := jobs.List(ctx, "alice", 10)
	if err != nil || len(list) != 3 || list[0].ID != "new" || list[2].ID != "old" {
		t.Fatalf("List: %+v %v", list, err)
	}
	if list, _ = jobs.List(ctx, "alice", 2); len(list) != 2 {
		t.Fatalf("List with limit: %d jobs", len(list))
	}
	if list, _ = jobs.List(ctx, "nobody", 10); list == nil || len(list) != 0 {
		t.Fatalf("List of unknown user: %#v", list)
	}

	// Complete and Fail finish a running job once, and only for its owner.
	// Progress is recorded on the owner's running job only.
	if err := jobs.Progress(ctx, "bob", "new", 9); err != nil {
		t.Fatal(err)
	}
	if err := jobs.Progress(ctx, "alice", "new", 3); err != nil {
		t.Fatal(err)
	}
	if j, _ := jobs.Get(ctx, "alice", "new"); j.ProgressRows != 3 {
		t.Fatalf("progress of a running job: %+v", j)
	}
	if err := jobs.Complete(ctx, "bob", "new", JobResult{CSV: "stolen"}); err != nil {
		t.Fatal(err)
	}
	if err := jobs.Complete(ctx, "alice", "new", JobResult{CSV: "a,b", Source: `{"source":1}`, Usage: &JobUsage{Model: "m", Calls: 2, OutputTokens: 7}}); err != nil {
		t.Fatal(err)
	}
	// A quiz the question bank answered alone has its questions and no usage.
	if err := jobs.Complete(ctx, "bob", "bobs", JobResult{CSV: "q", BankQuestions: []string{"q1", "q2"}, FromBank: 2}); err != nil {
		t.Fatal(err)
	}
	if j, _ := jobs.Get(ctx, "bob", "bobs"); j.Status != JobDone || j.Usage != nil || j.FromBank != 2 ||
		len(j.BankQuestions) != 2 || j.BankQuestions[1] != "q2" {
		t.Fatalf("job answered by the bank: %+v", j)
	}
	if err := jobs.Fail(ctx, "alice", "new", JobFailure{Status: 502, Code: "failed", Message: "late failure"}, JobUsage{}); err != nil { // already done: ignored
		t.Fatal(err)
	}
	if err := jobs.Fail(ctx, "alice", "mid", JobFailure{Status: 504, Code: "timeout", Message: "timed out"}, JobUsage{}); err != nil {
		t.Fatal(err)
	}
	byID := map[string]Job{}
	list, _ = jobs.List(ctx, "alice", 10)
	for _, j := range list {
		byID[j.ID] = j
	}
	// The list leaves the source out; Get has it.
	if j := byID["new"]; j.Status != JobDone || j.CSV != "a,b" || j.Source != "" || j.ErrorStatus != 0 || j.FinishedAt == nil ||
		j.Usage == nil || *j.Usage != (JobUsage{Model: "m", Calls: 2, OutputTokens: 7}) {
		t.Fatalf("completed job: %+v", j)
	}
	if j := byID["mid"]; j.Status != JobFailed || j.ErrorStatus != 504 || j.ErrorCode != "timeout" || j.ErrorMessage != "timed out" ||
		j.FinishedAt == nil {
		t.Fatalf("failed job: %+v", j)
	}

	// Get returns one job of the owner, as it is now, and nobody else's.
	if j, err := jobs.Get(ctx, "alice", "new"); err != nil || j.ID != "new" || j.Username != "alice" || j.Title != "new" ||
		j.Status != JobDone || j.CSV != "a,b" || j.Source != `{"source":1}` || j.FinishedAt == nil {
		t.Fatalf("Get: %+v %v", j, err)
	}
	if j, err := jobs.Get(ctx, "alice", "old"); err != nil || j.Status != JobRunning || j.FinishedAt != nil {
		t.Fatalf("Get of a running job: %+v %v", j, err)
	}
	if _, err := jobs.Get(ctx, "bob", "new"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Get of another user's job: %v", err)
	}
	if _, err := jobs.Get(ctx, "alice", "bobs"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Get of another user's job by its id: %v", err)
	}
	if _, err := jobs.Get(ctx, "alice", "missing"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Get of a missing job: %v", err)
	}

	// Revise replaces the result of a done job of the owner, and of nothing else.
	if err := jobs.Revise(ctx, "alice", "new", "c,d", `{"source":2}`); err != nil {
		t.Fatal(err)
	}
	if j, err := jobs.Get(ctx, "alice", "new"); err != nil || j.Status != JobDone || j.CSV != "c,d" || j.Source != `{"source":2}` {
		t.Fatalf("revised job: %+v %v", j, err)
	}
	for _, c := range []struct{ username, id string }{{"bob", "new"}, {"alice", "mid"}, {"alice", "old"}, {"alice", "missing"}} {
		if err := jobs.Revise(ctx, c.username, c.id, "x", "y"); !errors.Is(err, ErrNotFound) {
			t.Fatalf("Revise of %s's %s: %v", c.username, c.id, err)
		}
	}
	if j, _ := jobs.Get(ctx, "alice", "mid"); j.CSV != "" || j.Source != "" {
		t.Fatalf("Revise changed a failed job: %+v", j)
	}

	// A heartbeat is recorded on the owner's running job only.
	if err := jobs.Create(ctx, newJob("beating", "alice", 10*time.Minute)); err != nil {
		t.Fatal(err)
	}
	if err := jobs.Heartbeat(ctx, "bob", "beating"); err != nil {
		t.Fatal(err)
	}
	if j, _ := jobs.Get(ctx, "alice", "beating"); j.HeartbeatAt != nil {
		t.Fatalf("another user's heartbeat was recorded: %+v", j)
	}
	if err := jobs.Heartbeat(ctx, "alice", "beating"); err != nil {
		t.Fatal(err)
	}
	if j, _ := jobs.Get(ctx, "alice", "beating"); j.HeartbeatAt == nil || j.HeartbeatAt.Before(base.Add(-time.Second)) {
		t.Fatalf("heartbeat of a running job: %+v", j)
	}
	if err := jobs.Heartbeat(ctx, "alice", "mid"); err != nil {
		t.Fatal(err)
	}
	if j, _ := jobs.Get(ctx, "alice", "mid"); j.HeartbeatAt != nil {
		t.Fatalf("heartbeat of a finished job: %+v", j)
	}

	// ExpireRunning fails only running jobs whose last sign of life, the heartbeat or else the creation, is
	// older than the cutoff.
	expired, err := jobs.ExpireRunning(ctx, "alice", ExpiryCutoffs{Before: base.Add(-30 * time.Second)}, "interrupted")
	if err != nil || len(expired) != 1 || expired[0].ID != "old" || expired[0].Status != JobFailed || expired[0].ErrorCode != ExpiredJobCode {
		t.Fatalf("ExpireRunning: %+v %v", expired, err)
	}
	if expired, _ = jobs.ExpireRunning(ctx, "alice", ExpiryCutoffs{Before: base.Add(-30 * time.Second)}, "interrupted"); len(expired) != 0 {
		t.Fatalf("second ExpireRunning: %+v", expired)
	}
	if err := jobs.Delete(ctx, "alice", "beating"); err != nil {
		t.Fatal(err)
	}
	// A late answer does not revive an expired job.
	if err := jobs.Complete(ctx, "alice", "old", JobResult{CSV: "late", Usage: &JobUsage{}}); err != nil {
		t.Fatal(err)
	}
	list, _ = jobs.List(ctx, "alice", 10)
	for _, j := range list {
		if j.ID == "old" && (j.Status != JobFailed || j.CSV != "") {
			t.Fatalf("expired job revived: %+v", j)
		}
	}

	// Prune keeps the newest and never deletes a running job.
	if err := jobs.Create(ctx, newJob("running-old", "alice", 10*time.Minute)); err != nil {
		t.Fatal(err)
	}
	if err := jobs.Prune(ctx, "alice", 2); err != nil {
		t.Fatal(err)
	}
	list, _ = jobs.List(ctx, "alice", 10)
	ids := map[string]bool{}
	for _, j := range list {
		ids[j.ID] = true
	}
	if len(list) != 3 || !ids["new"] || !ids["mid"] || !ids["running-old"] {
		t.Fatalf("after Prune: %+v", list)
	}

	// Delete is scoped to the owner.
	if err := jobs.Delete(ctx, "bob", "new"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("deleting another user's job: %v", err)
	}
	if err := jobs.Delete(ctx, "alice", "new"); err != nil {
		t.Fatal(err)
	}
	if err := jobs.Delete(ctx, "alice", "new"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("deleting twice: %v", err)
	}
	if _, err := jobs.Get(ctx, "alice", "new"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Get after Delete: %v", err)
	}
}

// testJobImagesAndResumes runs on a store of its own: ClaimInterrupted looks at every user's jobs.
func testJobImagesAndResumes(t *testing.T, jobs Jobs) {
	ctx := context.Background()
	base := time.Now().UTC().Truncate(time.Millisecond)
	job := func(id, username string, intelligence int, age time.Duration, resumes int) *Job {
		return &Job{ID: id, Username: username, Status: JobRunning, Title: id, Creative: true, Intelligence: intelligence,
			ImageCount: 1, CreatedAt: base.Add(-age), Resumes: resumes, ProgressRows: 7}
	}

	// SetImages records the images on the owner's job only, whatever its status.
	if err := jobs.Create(ctx, job("pic", "carol", 1, 0, 0)); err != nil {
		t.Fatal(err)
	}
	images := []JobImage{{URL: "https://img/1", PublicID: "quiztool-jobs/1", ContentType: "image/jpeg"}}
	if err := jobs.SetImages(ctx, "dave", "pic", images, base); err != nil {
		t.Fatal(err)
	}
	if j, _ := jobs.Get(ctx, "carol", "pic"); j.Images != nil || j.ImagesStoredAt != nil {
		t.Fatalf("another user's SetImages was recorded: %+v", j)
	}
	_ = jobs.Fail(ctx, "carol", "pic", JobFailure{Status: 502, Code: "failed"}, JobUsage{})
	if err := jobs.SetImages(ctx, "carol", "pic", images, base); err != nil {
		t.Fatal(err)
	}
	if j, _ := jobs.Get(ctx, "carol", "pic"); len(j.Images) != 1 || j.Images[0] != images[0] || !j.ImagesStoredAt.Equal(base) {
		t.Fatalf("images of a failed job: %+v", j)
	}
	if err := jobs.SetImages(ctx, "carol", "missing", images, base); err != nil {
		t.Fatalf("SetImages of a missing job: %v", err)
	}

	// A job some server may still resume waits longer before it is taken for abandoned; one resumed too often
	// does not.
	for _, j := range []*Job{
		job("low-stale", "carol", 1, 10*time.Minute, 0),
		job("high-stale", "carol", 2, 5*time.Minute, 0),
		job("high-dead", "carol", 2, 15*time.Minute, 0),
		job("high-exhausted", "carol", 2, 5*time.Minute, 2),
	} {
		if err := jobs.Create(ctx, j); err != nil {
			t.Fatal(err)
		}
	}
	cutoffs := ExpiryCutoffs{Before: base.Add(-3 * time.Minute), ResumableIntelligence: 2, MaxResumes: 2, ResumableBefore: base.Add(-10 * time.Minute)}
	expired, err := jobs.ExpireRunning(ctx, "carol", cutoffs, "interrupted")
	got := map[string]bool{}
	for _, j := range expired {
		got[j.ID] = true
	}
	if err != nil || len(expired) != 3 || !got["low-stale"] || !got["high-dead"] || !got["high-exhausted"] {
		t.Fatalf("ExpireRunning with a resumable cutoff: %v %v", got, err)
	}
	if err := jobs.Delete(ctx, "carol", "high-stale"); err != nil {
		t.Fatal(err)
	}

	// ClaimInterrupted takes over each stale running job at the intelligence that may still be resumed, once.
	for _, j := range []*Job{
		job("resume-me", "dave", 2, 5*time.Minute, 0),
		job("resume-again", "erin", 2, 5*time.Minute, 1),
		job("resumed-enough", "dave", 2, 5*time.Minute, 2),
		job("fresh", "dave", 2, 0, 0),
		job("low", "dave", 1, 5*time.Minute, 0),
	} {
		if err := jobs.Create(ctx, j); err != nil {
			t.Fatal(err)
		}
	}
	done := job("done", "dave", 2, 5*time.Minute, 0)
	if err := jobs.Create(ctx, done); err != nil {
		t.Fatal(err)
	}
	_ = jobs.Complete(ctx, "dave", "done", JobResult{CSV: "a,b", Usage: &JobUsage{}})

	claimed := map[string]Job{}
	for range 5 {
		j, err := jobs.ClaimInterrupted(ctx, 2, base.Add(-90*time.Second), 2)
		if err != nil {
			t.Fatal(err)
		}
		if j == nil {
			break
		}
		claimed[j.ID] = *j
	}
	if len(claimed) != 2 {
		t.Fatalf("claimed %v", claimed)
	}
	for id, resumes := range map[string]int{"resume-me": 1, "resume-again": 2} {
		j, ok := claimed[id]
		if !ok || j.Resumes != resumes || j.ProgressRows != 0 || j.HeartbeatAt == nil || j.HeartbeatAt.Before(base.Add(-time.Second)) {
			t.Fatalf("claimed %s: %+v", id, j)
		}
	}
	// Claimed, it shows a fresh heartbeat, so nobody takes it for abandoned.
	if expired, _ := jobs.ExpireRunning(ctx, "dave", ExpiryCutoffs{Before: base.Add(-time.Minute)}, "interrupted"); len(expired) != 2 {
		t.Fatalf("expired after the claims: %+v", expired)
	}
}
