package api

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"time"

	"quiz-csv-import-tool/server/internal/csvgen"
	"quiz-csv-import-tool/server/internal/imagestore"
	"quiz-csv-import-tool/server/internal/store"
)

// ImageStore keeps the images of jobs; implemented by *imagestore.Cloudinary.
type ImageStore interface {
	Store(ctx context.Context, images []csvgen.Image) ([]store.JobImage, error)
	// SignUploads lets the browser upload images itself, and Refs takes back the public IDs it signed, failing
	// with imagestore.ErrUnknownImage for any other.
	SignUploads(count int, now time.Time) imagestore.UploadGrant
	Refs(publicIDs []string) ([]store.JobImage, error)
	// Fetch fails with imagestore.ErrGone when an image is no longer kept.
	Fetch(ctx context.Context, refs []store.JobImage) ([]csvgen.Image, error)
	DeleteStoredBefore(ctx context.Context, cutoff time.Time) (int, error)
}

// maxSignedUploads bounds the uploads signed at once.
const maxSignedUploads = 50

const (
	// imagesKeptFor is how long after they were stored a job's images can be sent again, and so how long a failed
	// job can be retried. They are deleted a day later (imagesDeletedAfter), once a day at most (imageCleanupEvery),
	// so a retry just before the end still finds them.
	imagesKeptFor      = 30 * 24 * time.Hour
	imagesDeletedAfter = imagesKeptFor + 24*time.Hour
	imageCleanupEvery  = 24 * time.Hour
	// imageStoreTimeout bounds storing a job's images, and imageCleanupTimeout deleting the old ones.
	imageStoreTimeout   = 2 * time.Minute
	imageCleanupTimeout = 5 * time.Minute
)

// storeJobImages starts storing a job's images, unless it has none, they are stored already (a retried or a
// resumed job takes over its predecessor's) or there is no image store, and returns what waits until that is
// done. A failure only costs the job being sent again, so it is logged. Storing images is also what deletes the
// ones kept too long, since only new images make old ones worth deleting.
func (s *Server) storeJobImages(ctx context.Context, job *store.Job, images []csvgen.Image) (wait func()) {
	if s.ImageStore == nil || len(images) == 0 || len(job.Images) > 0 {
		return func() {}
	}
	username, id := job.Username, job.ID
	done := make(chan struct{})
	go func() {
		defer close(done)
		ctx, cancel := context.WithTimeout(ctx, imageStoreTimeout)
		defer cancel()
		refs, err := s.ImageStore.Store(ctx, images)
		if err == nil {
			err = s.Jobs.SetImages(ctx, username, id, refs, s.now())
		}
		if err != nil {
			s.Logger.Warn("keeping the job's images failed; it cannot be sent again", "user", username, "job", id, "error", err)
		}
	}()
	s.deleteOldImagesWhenDue(ctx)
	return func() { <-done }
}

func (s *Server) deleteOldImagesWhenDue(ctx context.Context) {
	if s.due(&s.imageCleanupAt, imageCleanupEvery) {
		go s.deleteOldImages(ctx)
	}
}

func (s *Server) deleteOldImages(ctx context.Context) {
	ctx, cancel := context.WithTimeout(ctx, imageCleanupTimeout)
	defer cancel()
	deleted, err := s.ImageStore.DeleteStoredBefore(ctx, s.now().Add(-imagesDeletedAfter))
	if err != nil {
		s.Logger.Warn("deleting the images kept too long failed", "deleted", deleted, "error", err)
		return
	}
	if deleted > 0 {
		s.Logger.Info("deleted the images kept too long", "deleted", deleted)
	}
}

// imagesKeptUntil says until when a job's images can be sent again, and whether they still can: all of them
// stored, and not for longer than imagesKeptFor.
func (s *Server) imagesKeptUntil(job *store.Job) (time.Time, bool) {
	if s.ImageStore == nil || job.ImageCount == 0 || len(job.Images) != job.ImageCount || job.ImagesStoredAt == nil {
		return time.Time{}, false
	}
	until := job.ImagesStoredAt.Add(imagesKeptFor).UTC()
	return until, s.now().Before(until)
}

// signUploads handles POST /api/csv/uploads?count=N: signatures for the browser to upload N images straight to
// the image store, whose public IDs it then sends to createJob instead of the images. 404 without an image store:
// the browser then sends the images themselves.
func (s *Server) signUploads(w http.ResponseWriter, r *http.Request) {
	if s.ImageStore == nil {
		writeText(w, http.StatusNotFound, "Image uploads are not configured.")
		return
	}
	count, err := strconv.Atoi(r.URL.Query().Get("count"))
	if err != nil || count < 1 || count > maxSignedUploads {
		writeText(w, http.StatusBadRequest, "count must be between 1 and "+strconv.Itoa(maxSignedUploads)+".")
		return
	}
	noStore(w)
	writeJSON(w, http.StatusOK, s.ImageStore.SignUploads(count, s.now()))
}

// uploadedImages reads the images the browser uploaded under these public IDs, and where they are kept, their
// content type sniffed like readImages does; it answers why it cannot and returns false.
func (s *Server) uploadedImages(w http.ResponseWriter, r *http.Request, publicIDs []string) ([]csvgen.Image, []store.JobImage, bool) {
	if s.ImageStore == nil {
		writeText(w, http.StatusBadRequest, "Image uploads are not configured.")
		return nil, nil, false
	}
	refs, err := s.ImageStore.Refs(publicIDs)
	if err != nil {
		writeText(w, http.StatusBadRequest, "Unknown image.")
		return nil, nil, false
	}
	images, err := s.ImageStore.Fetch(r.Context(), refs)
	if errors.Is(err, imagestore.ErrGone) {
		writeText(w, http.StatusBadRequest, "Image not uploaded.")
		return nil, nil, false
	}
	if err != nil {
		s.internalError(w, r, "fetching the uploaded images failed", err)
		return nil, nil, false
	}
	for i := range images {
		imageType, ok := detectImageType(images[i].Data)
		if !ok {
			writeText(w, http.StatusBadRequest, "Unsupported image type.")
			return nil, nil, false
		}
		images[i].ContentType, refs[i].ContentType = imageType, imageType
	}
	return images, refs, true
}
