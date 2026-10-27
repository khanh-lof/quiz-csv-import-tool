package extension

import (
	"archive/zip"
	"bytes"
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
