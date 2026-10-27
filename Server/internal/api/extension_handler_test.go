package api

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"testing"

	"quiz-csv-import-tool/server/internal/extension"
)

func init() {
	extension.ExtensionDir = "../../../Extension"
}

func TestDownloadExtensionNeedsLogin(t *testing.T) {
	env := newEnv(t)
	rec := env.do(httptest.NewRequest(http.MethodGet, "/api/extension", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status %d, want 401", rec.Code)
	}
}

func TestDownloadExtensionSendsTheZip(t *testing.T) {
	env := newEnv(t)
	token, _ := env.login(t, "alice", "pw")

	req := httptest.NewRequest(http.MethodGet, "/api/extension", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := env.do(req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body)
	}
	if got := rec.Header().Get("Content-Type"); got != "application/zip" {
		t.Errorf("Content-Type %q", got)
	}
	if got := rec.Header().Get("Content-Disposition"); got != `attachment; filename="quiztool-wayground-extension.zip"` {
		t.Errorf("Content-Disposition %q", got)
	}
	want, err := extension.Zip()
	if err != nil {
		t.Fatalf("extension zip: %v", err)
	}
	if !bytes.Equal(rec.Body.Bytes(), want) {
		t.Error("body is not the embedded zip")
	}
}
