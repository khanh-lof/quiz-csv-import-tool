// Package extension serves the Wayground browser extension (the repo's Extension/ folder) as the zip that
// logged-in users download. The server's build cannot reach outside Server/, so the deployment packs the
// zip into packed/ first (`go generate ./internal/extension`, the server service's buildCommand in
// vercel.json) and it is embedded from there; it is never committed. A build without it (`go run` from
// Server/, the Docker image) packs ExtensionDir from disk on first use instead, if it is there.
package extension

import (
	"archive/zip"
	"bytes"
	"embed"
	"errors"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"sort"
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
		if _, err := w.Write(data); err != nil {
			return nil, err
		}
	}
	if err := zw.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}
