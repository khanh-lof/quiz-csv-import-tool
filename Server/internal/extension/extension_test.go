package extension

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

func TestPackHoldsTheExtension(t *testing.T) {
	data, err := Pack("../../../Extension")
	if err != nil {
		t.Fatalf("pack Extension/: %v", err)
	}
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatalf("read zip: %v", err)
	}
	names := map[string]bool{}
	for _, f := range zr.File {
		names[f.Name] = true
	}
	if !names["QuizTool-Extension/manifest.json"] {
		t.Errorf("zip has no QuizTool-Extension/manifest.json: %v", names)
	}
	if names["QuizTool-Extension/AGENTS.md"] {
		t.Error("zip includes AGENTS.md")
	}
}

func TestPackIsReproducible(t *testing.T) {
	first, err := Pack("../../../Extension")
	if err != nil {
		t.Fatal(err)
	}
	second, _ := Pack("../../../Extension")
	if !bytes.Equal(first, second) {
		t.Error("two packs of the same folder differ")
	}
}

// manifestIn reads manifest.json back out of a packed zip.
func manifestIn(t *testing.T, data []byte) map[string]any {
	t.Helper()
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatal(err)
	}
	f, err := zr.Open("QuizTool-Extension/manifest.json")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	var manifest map[string]any
	if err := json.NewDecoder(f).Decode(&manifest); err != nil {
		t.Fatal(err)
	}
	return manifest
}

func bridgeMatches(manifest map[string]any) []any {
	scripts, _ := manifest["content_scripts"].([]any)
	bridge, _ := scripts[0].(map[string]any)
	matches, _ := bridge["matches"].([]any)
	return matches
}

// The production URL is not in the source: packing adds APP_ORIGIN to the origins the bridge runs on.
func TestPackAddsTheAppOrigin(t *testing.T) {
	t.Setenv(AppOriginEnv, "")
	data, err := Pack("../../../Extension")
	if err != nil {
		t.Fatal(err)
	}
	if got := fmt.Sprint(bridgeMatches(manifestIn(t, data))); got != "[http://localhost:4200/*]" {
		t.Errorf("matches without APP_ORIGIN: %s", got)
	}

	t.Setenv(AppOriginEnv, " https://quiztool.example.com/ ")
	data, err = Pack("../../../Extension")
	if err != nil {
		t.Fatal(err)
	}
	manifest := manifestIn(t, data)
	if got := fmt.Sprint(bridgeMatches(manifest)); got != "[https://quiztool.example.com/* http://localhost:4200/*]" {
		t.Errorf("matches with APP_ORIGIN: %s", got)
	}
	if manifest["name"] != "QuizTool → Wayground" || manifest["manifest_version"] != float64(3) {
		t.Errorf("the rest of the manifest changed: %v", manifest)
	}
}

func TestPackRefusesAnAppOriginThatIsNotAnOrigin(t *testing.T) {
	for _, origin := range []string{"quiztool.example.com", "ftp://quiztool.example.com", "https://quiztool.example.com/app",
		"https://quiztool.example.com?x=1", "https://"} {
		t.Setenv(AppOriginEnv, origin)
		if _, err := Pack("../../../Extension"); err == nil || !strings.Contains(err.Error(), AppOriginEnv) {
			t.Errorf("%q: %v", origin, err)
		}
	}
}
