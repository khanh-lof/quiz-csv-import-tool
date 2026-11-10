package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
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

func (f *fakeImageStore) SignUploads(count int, now time.Time) imagestore.UploadGrant {
	f.mu.Lock()
	defer f.mu.Unlock()
	grant := imagestore.UploadGrant{URL: "https://upload.test", Uploads: make([]imagestore.SignedUpload, count)}
	for i := range grant.Uploads {
		f.next++
		id := fmt.Sprintf("quiztool-jobs/%d", f.next)
		grant.Uploads[i] = imagestore.SignedUpload{PublicID: id, Fields: map[string]string{"timestamp": fmt.Sprint(now.Unix())}}
	}
	return grant
}

func (f *fakeImageStore) Refs(publicIDs []string) ([]store.JobImage, error) {
	refs := make([]store.JobImage, len(publicIDs))
	for i, id := range publicIDs {
		if !strings.HasPrefix(id, "quiztool-jobs/") {
			return nil, imagestore.ErrUnknownImage
		}
		refs[i] = store.JobImage{URL: "https://images.test/" + id, PublicID: id}
	}
	return refs, nil
}

// put is the browser uploading an image under a public ID it was signed.
func (f *fakeImageStore) put(id string, data string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.images == nil {
		f.images = map[string]csvgen.Image{}
	}
	f.images[id] = csvgen.Image{Data: []byte(data)}
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

func (e *testEnv) signUploads(t *testing.T, token, count string) (*httptest.ResponseRecorder, imagestore.UploadGrant) {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/csv/uploads?count="+count, nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := e.do(req)
	var grant imagestore.UploadGrant
	if rec.Code == http.StatusOK {
		if err := json.Unmarshal(rec.Body.Bytes(), &grant); err != nil {
			t.Fatal(err)
		}
	}
	return rec, grant
}

// submitUploaded sends a job naming uploaded images by their public IDs.
func (e *testEnv) submitUploaded(t *testing.T, token string, publicIDs ...string) *httptest.ResponseRecorder {
	t.Helper()
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	for _, id := range publicIDs {
		_ = mw.WriteField(uploadedImageField, id)
	}
	_ = mw.Close()
	req := httptest.NewRequest(http.MethodPost, "/api/csv/jobs", &body)
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	return e.do(req)
}

func TestImagesUploadedByTheBrowserAreReadFromTheStoreAndKept(t *testing.T) {
	env := newEnv(t)
	token, _ := env.login(t, "alice", "pw")

	rec, grant := env.signUploads(t, token, "2")
	if rec.Code != http.StatusOK || len(grant.Uploads) != 2 || grant.Uploads[0].PublicID == grant.Uploads[1].PublicID {
		t.Fatalf("got %d %q", rec.Code, rec.Body)
	}
	ids := []string{grant.Uploads[0].PublicID, grant.Uploads[1].PublicID}
	for _, id := range ids {
		env.images.put(id, testPNG)
	}

	if rec := env.submitUploaded(t, token, ids...); rec.Code != http.StatusAccepted {
		t.Fatalf("got %d %q", rec.Code, rec.Body)
	}
	job := env.onlyJob(t, "alice")
	if job.Status != store.JobDone || job.ImageCount != 2 || len(job.Images) != 2 || job.ImagesStoredAt == nil {
		t.Fatalf("job %+v", job)
	}
	if job.Images[0].PublicID != ids[0] || job.Images[1].ContentType != "image/png" {
		t.Fatalf("images %+v", job.Images)
	}
	if got := env.gen.images; len(got) != 2 || got[0].ContentType != "image/png" || string(got[0].Data) != testPNG {
		t.Fatalf("the model was sent %+v", got)
	}
	// Nothing is stored again: the browser stored them.
	if env.images.stored() != 2 {
		t.Fatalf("%d images stored", env.images.stored())
	}
	for deadline := time.Now().Add(5 * time.Second); len(env.images.cleanups()) == 0; time.Sleep(time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatal("uploaded images did not delete the old ones")
		}
	}
}

func TestUploadedImagesAreRefusedWhenUnknownMissingOrNotImages(t *testing.T) {
	env := newEnv(t)
	token, _ := env.login(t, "alice", "pw")
	env.images.put("quiztool-jobs/text", "plain text")

	for name, ids := range map[string][]string{
		"not signed":   {"elsewhere/1"},
		"not uploaded": {"quiztool-jobs/missing"},
		"not an image": {"quiztool-jobs/text"},
	} {
		if rec := env.submitUploaded(t, token, ids...); rec.Code != http.StatusBadRequest {
			t.Errorf("%s: got %d %q", name, rec.Code, rec.Body)
		}
	}
	if jobs := env.listJobs(t, token); len(jobs) != 0 {
		t.Fatalf("jobs %v", jobs)
	}
}

func TestSigningUploadsNeedsAnImageStoreAndABoundedCount(t *testing.T) {
	env := newEnv(t)
	token, _ := env.login(t, "alice", "pw")
	for _, count := range []string{"", "0", "51", "x"} {
		if rec, _ := env.signUploads(t, token, count); rec.Code != http.StatusBadRequest {
			t.Errorf("count %q: got %d", count, rec.Code)
		}
	}
	env.srv.ImageStore = nil
	if rec, _ := env.signUploads(t, token, "1"); rec.Code != http.StatusNotFound {
		t.Fatalf("got %d", rec.Code)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/csv/uploads?count=1", nil)
	if rec := env.do(req); rec.Code != http.StatusUnauthorized {
		t.Fatalf("without a token: got %d", rec.Code)
	}
}
