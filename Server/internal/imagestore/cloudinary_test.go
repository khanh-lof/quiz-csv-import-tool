package imagestore

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"quiz-csv-import-tool/server/internal/csvgen"
)

// fakeCloudinary answers the four calls the store makes, the way Cloudinary does, and keeps the images.
type fakeCloudinary struct {
	t       *testing.T
	server  *httptest.Server
	mu      sync.Mutex
	images  map[string]fakeImage
	deletes [][]string
}

type fakeImage struct {
	data      []byte
	createdAt time.Time
}

func newFakeCloudinary(t *testing.T) (*fakeCloudinary, *Cloudinary) {
	f := &fakeCloudinary{t: t, images: map[string]fakeImage{}}
	f.server = httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(f.server.Close)
	c, err := NewCloudinary("cloudinary://key:secret@demo")
	if err != nil {
		t.Fatal(err)
	}
	c.apiBase = f.server.URL + "/v1_1/demo"
	return f, c
}

func (f *fakeCloudinary) serve(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if strings.HasPrefix(r.URL.Path, "/cdn/") {
		image, ok := f.images[strings.TrimPrefix(r.URL.Path, "/cdn/")]
		if !ok {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write(image.data)
		return
	}
	if key, secret, ok := r.BasicAuth(); !ok || key != "key" || secret != "secret" {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"error":{"message":"Invalid credentials"}}`))
		return
	}
	switch {
	case r.Method == http.MethodPost && r.URL.Path == "/v1_1/demo/image/upload":
		file, header, err := r.FormFile("file")
		publicID := r.FormValue("public_id")
		if err != nil || !strings.HasPrefix(publicID, prefix) || header.Header.Get("Content-Type") == "" {
			http.Error(w, `{"error":{"message":"bad upload"}}`, http.StatusBadRequest)
			return
		}
		data, _ := io.ReadAll(file)
		f.images[publicID] = fakeImage{data: data, createdAt: time.Now().UTC()}
		_ = json.NewEncoder(w).Encode(map[string]string{"public_id": publicID, "secure_url": f.server.URL + "/cdn/" + publicID})
	case r.Method == http.MethodGet && r.URL.Path == "/v1_1/demo/resources/image/upload":
		if r.URL.Query().Get("prefix") != prefix {
			http.Error(w, `{"error":{"message":"bad prefix"}}`, http.StatusBadRequest)
			return
		}
		// One image per page, to walk the cursor.
		ids := make([]string, 0, len(f.images))
		for id := range f.images {
			ids = append(ids, id)
		}
		slices.Sort(ids)
		start := 0
		if cursor := r.URL.Query().Get("next_cursor"); cursor != "" {
			start = slices.Index(ids, cursor)
		}
		page := map[string]any{"resources": []map[string]any{}}
		if start < len(ids) {
			page["resources"] = []map[string]any{{"public_id": ids[start], "created_at": f.images[ids[start]].createdAt.Format(time.RFC3339)}}
			if start+1 < len(ids) {
				page["next_cursor"] = ids[start+1]
			}
		}
		_ = json.NewEncoder(w).Encode(page)
	case r.Method == http.MethodDelete && r.URL.Path == "/v1_1/demo/resources/image/upload":
		ids := r.URL.Query()["public_ids[]"]
		f.deletes = append(f.deletes, ids)
		for _, id := range ids {
			delete(f.images, id)
		}
		_, _ = w.Write([]byte(`{"deleted":{}}`))
	default:
		http.NotFound(w, r)
	}
}

func TestNewCloudinaryReadsTheURL(t *testing.T) {
	c, err := NewCloudinary(" cloudinary://123:abc@my-cloud ")
	if err != nil || c.key != "123" || c.secret != "abc" || c.apiBase != "https://api.cloudinary.com/v1_1/my-cloud" {
		t.Fatalf("%+v %v", c, err)
	}
	for _, bad := range []string{"", "https://123:abc@my-cloud", "cloudinary://my-cloud", "cloudinary://123@my-cloud", "cloudinary://123:abc@"} {
		if _, err := NewCloudinary(bad); err == nil {
			t.Errorf("%q was accepted", bad)
		}
	}
}

func TestStoreThenFetch(t *testing.T) {
	_, c := newFakeCloudinary(t)
	images := []csvgen.Image{{ContentType: "image/jpeg", Data: []byte("first")}, {ContentType: "image/png", Data: []byte("second")}}
	refs, err := c.Store(context.Background(), images)
	if err != nil || len(refs) != 2 || refs[0].PublicID == refs[1].PublicID || !strings.HasPrefix(refs[0].PublicID, prefix) ||
		refs[1].ContentType != "image/png" {
		t.Fatalf("stored %+v %v", refs, err)
	}
	fetched, err := c.Fetch(context.Background(), refs)
	if err != nil || len(fetched) != 2 || string(fetched[0].Data) != "first" || fetched[1].ContentType != "image/png" ||
		string(fetched[1].Data) != "second" {
		t.Fatalf("fetched %+v %v", fetched, err)
	}

	refs[1].URL += "-gone"
	if _, err := c.Fetch(context.Background(), refs); !errors.Is(err, ErrGone) {
		t.Fatalf("a deleted image: %v", err)
	}
}

func TestStoreReportsCloudinarysError(t *testing.T) {
	_, c := newFakeCloudinary(t)
	c.secret = "wrong"
	_, err := c.Store(context.Background(), []csvgen.Image{{ContentType: "image/jpeg", Data: []byte("x")}})
	if err == nil || !strings.Contains(err.Error(), "status 401: Invalid credentials") {
		t.Fatalf("got %v", err)
	}
}

func TestDeleteStoredBeforeDeletesOnlyOldImages(t *testing.T) {
	f, c := newFakeCloudinary(t)
	now := time.Now().UTC()
	for i := range 205 {
		f.images[fmt.Sprintf("%sold-%03d", prefix, i)] = fakeImage{createdAt: now.Add(-40 * 24 * time.Hour)}
	}
	f.images[prefix+"new"] = fakeImage{createdAt: now.Add(-time.Hour)}

	deleted, err := c.DeleteStoredBefore(context.Background(), now.Add(-31*24*time.Hour))
	if err != nil || deleted != 205 {
		t.Fatalf("deleted %d, %v", deleted, err)
	}
	if len(f.images) != 1 || f.images[prefix+"new"].createdAt.IsZero() {
		t.Fatalf("left %v", f.images)
	}
	if len(f.deletes) != 3 || len(f.deletes[0]) != 100 || len(f.deletes[2]) != 5 {
		t.Fatalf("delete calls of %d, %d, ... ids", len(f.deletes[0]), len(f.deletes[1]))
	}
}
