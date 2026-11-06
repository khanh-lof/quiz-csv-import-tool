// Package extension serves the Wayground browser extension (the repo's Extension/ folder) as the zip that
// logged-in users download. The server's build cannot reach outside Server/, so the deployment packs the
// zip into packed/ first (`go generate ./internal/extension`, the API service's buildCommand in
// render.yaml) and it is embedded from there; it is never committed. A build without it (`go run` from
// Server/, the Docker image) packs ExtensionDir from disk on first use instead, if it is there.
package extension

import (
	"archive/zip"
	"bytes"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

//go:generate go run ../../cmd/pack-extension ../../../Extension packed/quiztool-wayground-extension.zip

// FileName is the name the download is saved under.
const FileName = "quiztool-wayground-extension.zip"

// ExtensionDir is where a build without the packed zip looks for the extension: Extension/ next to
// Server/, the working directory of `go run ./cmd/server`. Tests elsewhere point it at the repo's folder.
var ExtensionDir = "../Extension"

// ErrUnavailable means the build has no packed zip and ExtensionDir is not there either.
var ErrUnavailable = errors.New("extension not available")

//go:embed all:packed
var packed embed.FS

// folderInZip is the folder the zip extracts to, which the user picks in "Load unpacked".
const folderInZip = "QuizTool-Extension"

// excludedFiles are in Extension/ for developers, not for the browser.
var excludedFiles = map[string]bool{"AGENTS.md": true}

// fixedModTime keeps the zip byte-for-byte reproducible.
var fixedModTime = time.Date(2020, 1, 1, 0, 0, 0, 0, time.UTC)

var loadZip = sync.OnceValues(func() ([]byte, error) {
	if data, err := packed.ReadFile("packed/" + FileName); err == nil {
		return data, nil
	}
	if _, err := os.Stat(filepath.Join(ExtensionDir, "manifest.json")); err != nil {
		return nil, ErrUnavailable
	}
	return Pack(ExtensionDir)
})

// Zip returns the extension's zip, or ErrUnavailable.
func Zip() ([]byte, error) {
	return loadZip()
}

// AppOriginEnv names the env var holding QuizTool's public URL (e.g. https://quiztool.example.com).
// Pack adds it to the origins the extension's bridge script runs on, so the URL is not in the source.
const AppOriginEnv = "APP_ORIGIN"

// withAppOrigin adds origin to the bridge content script's matches in manifest.json. Anything but an http(s)
// origin is an error rather than a match pattern Chrome would refuse, which would stop the extension loading.
func withAppOrigin(manifest []byte, origin string) ([]byte, error) {
	origin = strings.TrimRight(strings.TrimSpace(origin), "/")
	if origin == "" {
		return manifest, nil
	}
	u, err := url.Parse(origin)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.Path != "" ||
		u.RawQuery != "" || u.Fragment != "" || u.User != nil {
		return nil, fmt.Errorf("%s must be an origin such as https://quiztool.example.com, got %q", AppOriginEnv, origin)
	}

	var parsed map[string]any
	if err := json.Unmarshal(manifest, &parsed); err != nil {
		return nil, err
	}
	scripts, _ := parsed["content_scripts"].([]any)
	var bridge map[string]any
	if len(scripts) > 0 {
		bridge, _ = scripts[0].(map[string]any)
	}
	if bridge == nil {
		return nil, errors.New("manifest.json has no content script to add the app origin to")
	}
	matches, _ := bridge["matches"].([]any)
	bridge["matches"] = append([]any{u.Scheme + "://" + u.Host + "/*"}, matches...)
	return json.MarshalIndent(parsed, "", "  ")
}

// Pack zips the extension folder dir.
func Pack(dir string) ([]byte, error) {
	var names []string
	err := filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || excludedFiles[d.Name()] {
			return err
		}
		rel, err := filepath.Rel(dir, p)
		if err != nil {
			return err
		}
		names = append(names, filepath.ToSlash(rel))
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.Strings(names)

	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for _, name := range names {
		data, err := os.ReadFile(filepath.Join(dir, filepath.FromSlash(name)))
		if err != nil {
			return nil, err
		}
		w, err := zw.CreateHeader(&zip.FileHeader{
			Name:     path.Join(folderInZip, name),
			Method:   zip.Deflate,
			Modified: fixedModTime,
		})
		if err != nil {
			return nil, err
		}
		// Every file is text; git's autocrlf would otherwise make a Windows checkout pack different bytes.
		data = bytes.ReplaceAll(data, []byte("\r\n"), []byte("\n"))
		if name == "manifest.json" {
			if data, err = withAppOrigin(data, os.Getenv(AppOriginEnv)); err != nil {
				return nil, err
			}
		}
		if _, err := w.Write(data); err != nil {
			return nil, err
		}
	}
	if err := zw.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}
