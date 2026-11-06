package api

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"sync"
	"testing"
	"time"

	"quiz-csv-import-tool/server/internal/csvgen"
	"quiz-csv-import-tool/server/internal/imagestore"
	"quiz-csv-import-tool/server/internal/store"
)

// fakeImageStore keeps images in memory the way the Cloudinary store keeps them remotely.
type fakeImageStore struct {
	mu      sync.Mutex
	images  map[string]csvgen.Image
	next    int
	err     error // Store fails with it when set
	cutoffs []time.Time
}

func (f *fakeImageStore) Store(_ context.Context, images []csvgen.Image) ([]store.JobImage, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.err != nil {
		return nil, f.err
	}
	if f.images == nil {
		f.images = map[string]csvgen.Image{}
	}
	refs := make([]store.JobImage, len(images))
	for i, image := range images {
		f.next++
		id := fmt.Sprintf("quiztool-jobs/%d", f.next)
		f.images[id] = image
		refs[i] = store.JobImage{URL: "https://images.test/" + id, PublicID: id, ContentType: image.ContentType}
	}
	return refs, nil
}

func (f *fakeImageStore) Fetch(_ context.Context, refs []store.JobImage) ([]csvgen.Image, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	images := make([]csvgen.Image, len(refs))
	for i, ref := range refs {
		image, ok := f.images[ref.PublicID]
		if !ok {
			return nil, fmt.Errorf("%s: %w", ref.PublicID, imagestore.ErrGone)
		}
		images[i] = image
	}
	return images, nil
}

func (f *fakeImageStore) DeleteStoredBefore(_ context.Context, cutoff time.Time) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.cutoffs = append(f.cutoffs, cutoff)
	return 0, nil
}

func (f *fakeImageStore) stored() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.images)
}

func (f *fakeImageStore) forget(id string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.images, id)
}

func (f *fakeImageStore) cleanups() []time.Time {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]time.Time(nil), f.cutoffs...)
}

func TestJobImagesAreStoredAndOldOnesDeletedOnceADay(t *testing.T) {
	env := newEnv(t)
	token, _ := env.login(t, "alice", "pw")
	env.srv.AICallsPerRound = 10

	if rec := env.upload(t, upload{token: token, files: 2}); rec.Code != http.StatusAccepted {
		t.Fatalf("got %d %q", rec.Code, rec.Body)
	}
	job := env.onlyJob(t, "alice")
	if job.Status != store.JobDone || len(job.Images) != 2 || job.Images[0].ContentType == "" || env.images.stored() != 2 {
		t.Fatalf("job %+v, %d images stored", job, env.images.stored())
	}
	for deadline := time.Now().Add(5 * time.Second); len(env.images.cleanups()) == 0; time.Sleep(time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatal("storing images did not delete the old ones")
		}
	}
	if cutoffs := env.images.cleanups(); !cutoffs[0].Equal(testClockStart.Add(-imagesDeletedAfter)) {
		t.Fatalf("deleted the images stored before %v", cutoffs[0])
	}

	// Nothing to store without images, and the old ones are deleted once a day at most.
	env.upload(t, upload{token: token, query: "?isCreative=true&exportType=0&courseType=1&level=6&lessonNumbers=1"})
	env.upload(t, upload{token: token, files: 1})
	time.Sleep(20 * time.Millisecond)
	if env.images.stored() != 3 || len(env.images.cleanups()) != 1 {
		t.Fatalf("%d images stored, %d cleanups", env.images.stored(), len(env.images.cleanups()))
	}
}

func TestStoringImagesFailingOnlyCostsTheRetry(t *testing.T) {
	env := newEnv(t)
	token, _ := env.login(t, "alice", "pw")
	env.images.err = errors.New("store down")
	env.gen.err = errors.New("boom")
	if rec := env.upload(t, upload{token: token, files: 1}); rec.Code != http.StatusAccepted {
		t.Fatalf("got %d %q", rec.Code, rec.Body)
	}
	if job := env.onlyJob(t, "alice"); job.Status != store.JobFailed || job.Images != nil {
		t.Fatalf("job %+v", job)
	}
	if view := env.listJobs(t, token)[0]; view["retryable"] != false {
		t.Fatalf("view %v", view)
	}
}

func TestWithoutAnImageStoreOnlyJobsWithoutImagesCanBeRetried(t *testing.T) {
	env := newEnv(t)
	token, _ := env.login(t, "alice", "pw")
	env.srv.ImageStore = nil
	env.gen.err = errors.New("boom")
	env.upload(t, upload{token: token, files: 1, query: "?title=with"})
	env.upload(t, upload{token: token, query: "?title=without&isCreative=true&exportType=0&courseType=1&level=6&lessonNumbers=1"})
	for _, view := range env.listJobs(t, token) {
		if want := view["title"] == "without"; view["retryable"] != want {
			t.Fatalf("%v", view)
		}
	}
}
