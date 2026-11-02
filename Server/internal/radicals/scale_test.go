package radicals

import (
	"encoding/json"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
)

// poolLessons makes lessons of the given sizes from the curated word list, with MMAH's first reading as the
// syllables, so that tests have realistic words without pinyin of their own.
func poolLessons(t testing.TB, sizes ...int) []Lesson {
	t.Helper()
	data, err := loadData()
	if err != nil {
		t.Fatal(err)
	}
	var words []string
	for w := range data.poolWords {
		if IsHanzi(w) {
			words = append(words, w)
		}
	}
	slices.Sort(words)
	var lessons []Lesson
	next := 0
	for i, size := range sizes {
		lesson := Lesson{Number: i + 1, TitleZh: "课"}
		for ; len(lesson.Words) < size && next < len(words); next++ {
			word := Word{Hanzi: words[next]}
			for _, r := range word.Hanzi {
				syllable := "a"
				if e := data.entries[string(r)]; e != nil && len(e.Pinyin) > 0 {
					syllable = e.Pinyin[0]
				}
				word.Syllables = append(word.Syllables, syllable)
				word.Pinyin += syllable
			}
			lesson.Words = append(lesson.Words, word)
		}
		lessons = append(lessons, lesson)
	}
	return lessons
}

func TestFiveLessonsOfFortyWords(t *testing.T) {
	if _, err := loadData(); err != nil {
		t.Fatal(err)
	}
	lessons := poolLessons(t, 40, 40, 40, 40, 40)
	start := time.Now()
	d := mustPlan(t, lessons, Options{})
	planned := time.Since(start)
	info, _ := complete(t, d, Info{})
	start = time.Now()
	ex, err := d.Build(info)
	if err != nil {
		t.Fatal(err)
	}
	built := time.Since(start)
	start = time.Now()
	if _, err := RenderHTML(ex); err != nil {
		t.Fatal(err)
	}
	t.Logf("plan %v, build %v, render %v; %d lessons played, %d skipped", planned, built, time.Since(start), len(d.groups), len(d.skipped))
	if planned+built > 5*time.Second {
		t.Errorf("plan and build took %v", planned+built)
	}
	if len(d.groups) < 4 {
		t.Errorf("only %d of 5 lessons were grouped", len(d.groups))
	}
}

func TestDraftIsSafeForConcurrentUse(t *testing.T) {
	d, info := planExample(t)
	full, _ := complete(t, d, info)
	var wg sync.WaitGroup
	results := make([]string, 6)
	for i := range results {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if i%2 == 0 {
				d.Needs()
				return
			}
			ex, err := d.Build(full)
			if err != nil {
				results[i] = err.Error()
				return
			}
			results[i] = string(ex.Lessons)
		}()
	}
	wg.Wait()
	for _, i := range []int{1, 3, 5} {
		if results[i] == "" || strings.Contains(results[i], "failed") || results[i] != results[1] {
			t.Errorf("result %d differs: %.80s", i, results[i])
		}
	}
}

func TestTransformPath(t *testing.T) {
	got := transformPath("M 0 900 L 1024 0 Q 512 450 100 100 Z")
	want := "M 0 0 L 1000 878.9 Q 500 439.5 97.7 781.2 Z"
	if got != want {
		t.Errorf("transformPath = %q, want %q", got, want)
	}
}

// TestGlyphsDrawEveryStroke draws every splittable GB2312 level 1 character as the exercise would and checks that
// no stroke is lost or drawn twice, including the strokes no component owns.
func TestGlyphsDrawEveryStroke(t *testing.T) {
	d, _ := planExample(t)
	b := &builder{d: d, data: d.data, a: d.analysis}
	glyphs := map[string][]string{}
	withRest := 0
	for c := range d.data.gb2312Level1 {
		dec := d.analysis.dec(c)
		if dec == nil {
			continue
		}
		spec := glyphSpec{names: dec.distinctNames(), split: true, rest: b.hasRest(c, dec)}
		if spec.rest {
			withRest++
		}
		glyphs[c] = spec.listed()
	}
	raw, err := renderGlyphs(d.data, glyphs)
	if err != nil {
		t.Fatal(err)
	}
	var drawn map[string]map[string]string
	if err := json.Unmarshal(raw, &drawn); err != nil {
		t.Fatal(err)
	}
	if len(drawn) != len(glyphs) || withRest == 0 {
		t.Fatalf("%d characters drawn of %d; %d with strokes of no component", len(drawn), len(glyphs), withRest)
	}
	for c, paths := range drawn {
		moves := 0
		for _, p := range paths {
			moves += strings.Count(p, "M")
		}
		if want := len(d.data.entries[c].Matches); moves != want {
			t.Errorf("%s: %d strokes drawn, want %d", c, moves, want)
		}
	}
	t.Logf("%d characters, %d with strokes no component owns", len(drawn), withRest)
}
