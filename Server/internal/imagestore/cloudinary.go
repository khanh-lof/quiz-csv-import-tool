// Package imagestore keeps the images of AI jobs in Cloudinary, so a failed or interrupted job can be sent to the
// model again without the user uploading them again, from any server and any instance of it. The browser uploads
// them itself, with signatures from SignUploads; Store is for a server given the images.
package imagestore

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"net/url"
	"regexp"
	"slices"
	"strconv"
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

// allowedFormats are the formats a browser may upload, the ones the model reads.
const allowedFormats = "gif,jpg,png,webp"

// ErrGone means an image is no longer kept, deleted by the cleanup or by hand.
var ErrGone = errors.New("image is no longer kept")

// ErrUnknownImage means a public ID is not one SignUploads hands out.
var ErrUnknownImage = errors.New("not an image of a job")

var publicIDPattern = regexp.MustCompile(`^` + regexp.QuoteMeta(prefix) + `[0-9a-f]{32}$`)

// Cloudinary stores images in one Cloudinary account, authenticating every call with the API key and secret
// (HTTP Basic auth, which the Upload and Admin APIs both take). Images are public "upload" assets under
// random public IDs: their URLs are only ever in the job store.
type Cloudinary struct {
	key, secret string
	// apiBase is https://api.cloudinary.com/v1_1/<cloud name> and deliveryBase
	// https://res.cloudinary.com/<cloud name>/image/upload/; tests point them at a fake.
	apiBase      string
	deliveryBase string
	http         *http.Client
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
	cloud := url.PathEscape(u.Host)
	return &Cloudinary{
		key:          u.User.Username(),
		secret:       secret,
		apiBase:      "https://api.cloudinary.com/v1_1/" + cloud,
		deliveryBase: "https://res.cloudinary.com/" + cloud + "/image/upload/",
		http:         &http.Client{Timeout: 2 * time.Minute},
	}, nil
}

// UploadGrant lets a browser upload images straight to Cloudinary: each of Uploads is posted to URL as a
// multipart form of its Fields and the image as "file".
type UploadGrant struct {
	URL     string         `json:"url"`
	Uploads []SignedUpload `json:"uploads"`
}

// SignedUpload is one image's form fields, signed, under a fresh public ID that Refs takes back.
type SignedUpload struct {
	PublicID string            `json:"publicId"`
	Fields   map[string]string `json:"fields"`
}

// SignUploads signs count uploads at now. Cloudinary takes a signature for an hour after its timestamp.
func (c *Cloudinary) SignUploads(count int, now time.Time) UploadGrant {
	grant := UploadGrant{URL: c.apiBase + "/image/upload", Uploads: make([]SignedUpload, count)}
	timestamp := strconv.FormatInt(now.Unix(), 10)
	for i := range grant.Uploads {
		publicID := newPublicID()
		signed := map[string]string{"allowed_formats": allowedFormats, "public_id": publicID, "timestamp": timestamp}
		fields := map[string]string{"api_key": c.key, "signature": c.sign(signed)}
		for name, value := range signed {
			fields[name] = value
		}
		grant.Uploads[i] = SignedUpload{PublicID: publicID, Fields: fields}
	}
	return grant
}

// sign is Cloudinary's upload signature: the parameters sorted by name as name=value joined by "&", the API
// secret appended, hashed with SHA-1 (the account's default signature algorithm).
func (c *Cloudinary) sign(params map[string]string) string {
	pairs := make([]string, 0, len(params))
	for name, value := range params {
		pairs = append(pairs, name+"="+value)
	}
	slices.Sort(pairs)
	sum := sha1.Sum([]byte(strings.Join(pairs, "&") + c.secret))
	return hex.EncodeToString(sum[:])
}

// Refs says where the images a browser uploaded under these public IDs are kept, in order, their content type
// left for the caller to fill in once it has read them; ErrUnknownImage for an ID SignUploads would not hand out.
func (c *Cloudinary) Refs(publicIDs []string) ([]store.JobImage, error) {
	refs := make([]store.JobImage, len(publicIDs))
	for i, publicID := range publicIDs {
		if !publicIDPattern.MatchString(publicID) {
			return nil, fmt.Errorf("%q: %w", publicID, ErrUnknownImage)
		}
		refs[i] = store.JobImage{URL: c.deliveryBase + publicID, PublicID: publicID}
	}
	return refs, nil
}

func newPublicID() string {
	id := make([]byte, 16)
	_, _ = rand.Read(id)
	return prefix + hex.EncodeToString(id)
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
	publicID := newPublicID()

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
