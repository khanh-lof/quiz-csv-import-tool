// Package imagestore keeps the images of AI jobs in Cloudinary, so a failed or interrupted job can be sent to the
// model again without the user uploading them again, from any server and any instance of it.
package imagestore

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"net/url"
	"strings"
	"sync"
	"time"

	"quiz-csv-import-tool/server/internal/csvgen"
	"quiz-csv-import-tool/server/internal/store"
)

// prefix starts the public ID of every image this package stores, which is how the cleanup finds them.
const prefix = "quiztool-jobs/"

// maxImageBytes bounds an image read back: the client sends at most 4 MB in all, the server takes 50 MB.
const maxImageBytes = 50 << 20

// ErrGone means an image is no longer kept, deleted by the cleanup or by hand.
var ErrGone = errors.New("image is no longer kept")

// Cloudinary stores images in one Cloudinary account, authenticating every call with the API key and secret
// (HTTP Basic auth, which the Upload and Admin APIs both take). Images are public "upload" assets under
// random public IDs: their URLs are only ever in the job store.
type Cloudinary struct {
	key, secret string
	// apiBase is https://api.cloudinary.com/v1_1/<cloud name>; tests point it at a fake.
	apiBase string
	http    *http.Client
}

// NewCloudinary reads a CLOUDINARY_URL, cloudinary://<api key>:<api secret>@<cloud name>, as the account's
// dashboard shows it.
func NewCloudinary(raw string) (*Cloudinary, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Scheme != "cloudinary" || u.Host == "" || u.User == nil {
		return nil, errors.New("CLOUDINARY_URL must look like cloudinary://<api key>:<api secret>@<cloud name>")
	}
	secret, ok := u.User.Password()
	if u.User.Username() == "" || !ok || secret == "" {
		return nil, errors.New("CLOUDINARY_URL must look like cloudinary://<api key>:<api secret>@<cloud name>")
	}
	return &Cloudinary{
		key:     u.User.Username(),
		secret:  secret,
		apiBase: "https://api.cloudinary.com/v1_1/" + url.PathEscape(u.Host),
		http:    &http.Client{Timeout: 2 * time.Minute},
	}, nil
}

// Store uploads the images, all at once, and returns where each is kept, in order. On an error nothing is
// returned, though some images may have been stored: the cleanup deletes them with the rest.
func (c *Cloudinary) Store(ctx context.Context, images []csvgen.Image) ([]store.JobImage, error) {
	refs := make([]store.JobImage, len(images))
	errs := make([]error, len(images))
	var wg sync.WaitGroup
	for i, image := range images {
		wg.Go(func() {
			refs[i], errs[i] = c.upload(ctx, image)
		})
	}
	wg.Wait()
	if err := errors.Join(errs...); err != nil {
		return nil, err
	}
	return refs, nil
}

func (c *Cloudinary) upload(ctx context.Context, image csvgen.Image) (store.JobImage, error) {
	id := make([]byte, 16)
	_, _ = rand.Read(id)
	publicID := prefix + hex.EncodeToString(id)

	var body bytes.Buffer
	form := multipart.NewWriter(&body)
	_ = form.WriteField("public_id", publicID)
	header := textproto.MIMEHeader{}
	header.Set("Content-Disposition", `form-data; name="file"; filename="image"`)
	header.Set("Content-Type", image.ContentType)
	part, _ := form.CreatePart(header)
	_, _ = part.Write(image.Data)
	_ = form.Close()

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.apiBase+"/image/upload", &body)
	if err != nil {
		return store.JobImage{}, err
	}
	req.Header.Set("Content-Type", form.FormDataContentType())
	var uploaded struct {
		PublicID  string `json:"public_id"`
		SecureURL string `json:"secure_url"`
	}
	if err := c.call(req, &uploaded); err != nil {
		return store.JobImage{}, fmt.Errorf("uploading an image: %w", err)
	}
	if uploaded.PublicID == "" || uploaded.SecureURL == "" {
		return store.JobImage{}, errors.New("uploading an image: the answer names no public ID or URL")
	}
	return store.JobImage{URL: uploaded.SecureURL, PublicID: uploaded.PublicID, ContentType: image.ContentType}, nil
}

// Fetch downloads the images, in order; ErrGone when one is no longer kept.
func (c *Cloudinary) Fetch(ctx context.Context, refs []store.JobImage) ([]csvgen.Image, error) {
	images := make([]csvgen.Image, len(refs))
	errs := make([]error, len(refs))
	var wg sync.WaitGroup
	for i, ref := range refs {
		wg.Go(func() {
			images[i], errs[i] = c.fetch(ctx, ref)
		})
	}
	wg.Wait()
	if err := errors.Join(errs...); err != nil {
		return nil, err
	}
	return images, nil
}

func (c *Cloudinary) fetch(ctx context.Context, ref store.JobImage) (csvgen.Image, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, ref.URL, nil)
	if err != nil {
		return csvgen.Image{}, err
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return csvgen.Image{}, fmt.Errorf("downloading %s: %w", ref.PublicID, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return csvgen.Image{}, fmt.Errorf("downloading %s: %w", ref.PublicID, ErrGone)
	}
	if resp.StatusCode != http.StatusOK {
		return csvgen.Image{}, fmt.Errorf("downloading %s: status %d", ref.PublicID, resp.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxImageBytes+1))
	if err != nil {
		return csvgen.Image{}, fmt.Errorf("downloading %s: %w", ref.PublicID, err)
	}
	if len(data) > maxImageBytes {
		return csvgen.Image{}, fmt.Errorf("downloading %s: larger than %d bytes", ref.PublicID, maxImageBytes)
	}
	return csvgen.Image{ContentType: ref.ContentType, Data: data}, nil
}

// DeleteStoredBefore deletes every image this package stored before cutoff and returns how many it deleted.
// Cloudinary has no expiry of its own, so this is how images stop being kept.
func (c *Cloudinary) DeleteStoredBefore(ctx context.Context, cutoff time.Time) (int, error) {
	var old []string
	query := url.Values{"prefix": {prefix}, "max_results": {"500"}}
	for {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.apiBase+"/resources/image/upload?"+query.Encode(), nil)
		if err != nil {
			return 0, err
		}
		var page struct {
			Resources []struct {
				PublicID  string    `json:"public_id"`
				CreatedAt time.Time `json:"created_at"`
			} `json:"resources"`
			NextCursor string `json:"next_cursor"`
		}
		if err := c.call(req, &page); err != nil {
			return 0, fmt.Errorf("listing the stored images: %w", err)
		}
		for _, resource := range page.Resources {
			if resource.CreatedAt.Before(cutoff) {
				old = append(old, resource.PublicID)
			}
		}
		if page.NextCursor == "" {
			break
		}
		query.Set("next_cursor", page.NextCursor)
	}

	deleted := 0
	// The Admin API deletes at most 100 public IDs per call.
	for start := 0; start < len(old); start += 100 {
		batch := old[start:min(start+100, len(old))]
		query := url.Values{"public_ids[]": batch}
		req, err := http.NewRequestWithContext(ctx, http.MethodDelete, c.apiBase+"/resources/image/upload?"+query.Encode(), nil)
		if err != nil {
			return deleted, err
		}
		if err := c.call(req, nil); err != nil {
			return deleted, fmt.Errorf("deleting old images: %w", err)
		}
		deleted += len(batch)
	}
	return deleted, nil
}

// call sends an authenticated API request and decodes a successful answer into out, when given.
func (c *Cloudinary) call(req *http.Request, out any) error {
	req.SetBasicAuth(c.key, c.secret)
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return err
	}
	if resp.StatusCode != http.StatusOK {
		var failure struct {
			Error struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		_ = json.Unmarshal(body, &failure)
		return fmt.Errorf("status %d: %s", resp.StatusCode, failure.Error.Message)
	}
	if out == nil {
		return nil
	}
	return json.Unmarshal(body, out)
}
