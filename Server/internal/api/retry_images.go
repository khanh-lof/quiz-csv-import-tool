package api

import (
	"sync"
	"time"

	"quiz-csv-import-tool/server/internal/csvgen"
)

// retryImagesTTL is how long a failed job's images are kept for "Tạo lại", from the moment it failed. A
// failure is worth retrying soon (the model was overloaded or slow); after that the user uploads again.
const retryImagesTTL = time.Hour

// retryImages holds the images of failed AI jobs, so retryJob can send them again without an upload. They
// are kept in this process's memory only: after a restart, or on another instance of the server, a job's
// images are gone and it can no longer be retried. The zero value is ready to use.
type retryImages struct {
	mu      sync.Mutex
	entries map[string]retryImagesEntry
}

type retryImagesEntry struct {
	username  string
	images    []csvgen.Image
	expiresAt time.Time
}

// keep stores a job's images until the given time, replacing any it had, and drops what has expired.
func (k *retryImages) keep(id, username string, images []csvgen.Image, now, until time.Time) {
	k.mu.Lock()
	defer k.mu.Unlock()
	for entryID, entry := range k.entries {
		if !now.Before(entry.expiresAt) {
			delete(k.entries, entryID)
		}
	}
	if k.entries == nil {
		k.entries = map[string]retryImagesEntry{}
	}
	k.entries[id] = retryImagesEntry{username: username, images: images, expiresAt: until}
}

// get returns a job's images and how long they are kept; false when they are gone or another user's.
func (k *retryImages) get(id, username string, now time.Time) ([]csvgen.Image, time.Time, bool) {
	k.mu.Lock()
	defer k.mu.Unlock()
	entry, ok := k.entries[id]
	if !ok || entry.username != username || !now.Before(entry.expiresAt) {
		return nil, time.Time{}, false
	}
	return entry.images, entry.expiresAt, true
}

func (k *retryImages) drop(id string) {
	k.mu.Lock()
	defer k.mu.Unlock()
	delete(k.entries, id)
}
