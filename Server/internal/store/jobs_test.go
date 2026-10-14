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
func TestMemoryJobs(t *testing.T) { testJobs(t, NewMemoryJobs()) }

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
	jobs := NewMongoJobs(db.Collection("Jobs"))
	if err := jobs.EnsureIndexes(context.Background()); err != nil {
		t.Fatal(err)
	}
	testJobs(t, jobs)
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
	if err := jobs.Complete(ctx, "bob", "new", "stolen"); err != nil {
		t.Fatal(err)
	}
	if err := jobs.Complete(ctx, "alice", "new", "a,b"); err != nil {
		t.Fatal(err)
	}
	if err := jobs.Fail(ctx, "alice", "new", 502, "late failure"); err != nil { // already done: ignored
		t.Fatal(err)
	}
	if err := jobs.Fail(ctx, "alice", "mid", 504, "timed out"); err != nil {
		t.Fatal(err)
	}
	byID := map[string]Job{}
	list, _ = jobs.List(ctx, "alice", 10)
	for _, j := range list {
		byID[j.ID] = j
	}
	if j := byID["new"]; j.Status != JobDone || j.CSV != "a,b" || j.ErrorStatus != 0 || j.FinishedAt == nil {
		t.Fatalf("completed job: %+v", j)
	}
	if j := byID["mid"]; j.Status != JobFailed || j.ErrorStatus != 504 || j.ErrorMessage != "timed out" || j.FinishedAt == nil {
		t.Fatalf("failed job: %+v", j)
	}

	// Get returns one job of the owner, as it is now, and nobody else's.
	if j, err := jobs.Get(ctx, "alice", "new"); err != nil || j.ID != "new" || j.Username != "alice" || j.Title != "new" ||
		j.Status != JobDone || j.CSV != "a,b" || j.FinishedAt == nil {
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

	// ExpireRunning fails only running jobs older than the cutoff.
	expired, err := jobs.ExpireRunning(ctx, "alice", base.Add(-30*time.Second), "interrupted")
	if err != nil || len(expired) != 1 || expired[0].ID != "old" || expired[0].Status != JobFailed {
		t.Fatalf("ExpireRunning: %+v %v", expired, err)
	}
	if expired, _ = jobs.ExpireRunning(ctx, "alice", base.Add(-30*time.Second), "interrupted"); len(expired) != 0 {
		t.Fatalf("second ExpireRunning: %+v", expired)
	}
	// A late answer does not revive an expired job.
	if err := jobs.Complete(ctx, "alice", "old", "late"); err != nil {
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
