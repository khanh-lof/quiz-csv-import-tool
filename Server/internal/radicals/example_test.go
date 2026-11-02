package radicals

import (
	"encoding/json"
	"os"
	"testing"
)

type exampleSpec struct {
	Course struct {
		Name        string `json:"name"`
		Level       string `json:"level"`
		VocabSource string `json:"vocab_source"`
	} `json:"course"`
	Colors  map[string]string `json:"colors"`
	Options struct {
		ReviewPrevious bool   `json:"review_previous"`
		Seed           uint64 `json:"seed"`
		Tries          int    `json:"tries"`
	} `json:"options"`
	Lessons []struct {
		Number  int    `json:"number"`
		TitleVi string `json:"title_vi"`
		TitleZh string `json:"title_zh"`
		Words   []struct {
			H  string `json:"h"`
			P  string `json:"p"`
			Vi string `json:"vi"`
		} `json:"words"`
	} `json:"lessons"`
	CharMeanings map[string]string `json:"char_meanings"`
	Components   map[string]struct {
		Name string `json:"name"`
		Py   string `json:"py"`
		Vi   string `json:"vi"`
	} `json:"components"`
	ExcludedChars []string `json:"excluded_chars"`
}

// loadExample converts the KIT's example spec into the engine's inputs.
func loadExample(t testing.TB) ([]Lesson, Info, Options) {
	t.Helper()
	raw, err := os.ReadFile("testdata/spec_example.json")
	if err != nil {
		t.Fatal(err)
	}
	var spec exampleSpec
	if err := json.Unmarshal(raw, &spec); err != nil {
		t.Fatal(err)
	}
	var lessons []Lesson
	for _, l := range spec.Lessons {
		lesson := Lesson{Number: l.Number, TitleVi: l.TitleVi, TitleZh: l.TitleZh}
		for _, w := range l.Words {
			lesson.Words = append(lesson.Words, Word{Hanzi: w.H, Pinyin: w.P, Meaning: w.Vi})
		}
		lessons = append(lessons, lesson)
	}
	info := Info{CharMeanings: spec.CharMeanings, Components: map[string]ComponentInfo{}}
	for k, c := range spec.Components {
		info.Components[k] = ComponentInfo{Name: c.Name, Pinyin: c.Py, Meaning: c.Vi}
	}
	excluded := ""
	for _, c := range spec.ExcludedChars {
		excluded += c
	}
	opts := Options{Seed: spec.Options.Seed, Tries: spec.Options.Tries, Level: spec.Course.Level, CourseName: spec.Course.Name,
		VocabSource: spec.Course.VocabSource, ReviewPrevious: spec.Options.ReviewPrevious, ExcludedChars: excluded}
	return lessons, info, opts
}
