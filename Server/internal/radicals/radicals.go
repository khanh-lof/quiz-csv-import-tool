// Package radicals makes the "Ghép bộ thủ thành chữ Hán" exercise: for each lesson's words it picks, in groups of one
// example and five questions, the component of a character that is missing, and renders the exercise as one page.
// It is a port of a Python kit and a pure, deterministic library: no HTTP, no model, no database. Characters are
// split into components with the strokes of Make Me a Hanzi (data/mmah.jsonl.gz, see data/MMAH-LICENSE.md).
//
// The use is Plan (choose the questions), Draft.Needs (what language data the pools lack), Draft.Build (assemble the
// exercise with the answers to those needs) and RenderHTML.
package radicals

import (
	"cmp"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"sync"
	"unicode/utf8"

	"golang.org/x/text/unicode/norm"
)

// Word is one vocabulary item of a lesson, in the lesson's order.
type Word struct {
	Hanzi      string   `json:"hanzi"`                // CJK ideographs only
	Pinyin     string   `json:"pinyin"`               // as written, e.g. "túshūguǎn" or "nǚ'ér"
	Syllables  []string `json:"syllables"`            // one per rune of Hanzi; nil: Pinyin must split in exactly one way
	Meaning    string   `json:"meaning"`              // Vietnamese; "": from the pool, else reported missing
	Star       bool     `json:"star,omitempty"`       // ★ 超纲
	ProperNoun bool     `json:"properNoun,omitempty"` // a name: never asked about
}

// Lesson is a lesson and its words.
type Lesson struct {
	Number  int    `json:"number"` // positive and unique; lessons may come in any order
	TitleVi string `json:"titleVi"`
	TitleZh string `json:"titleZh"`
	Words   []Word `json:"words"`
}

// Options are the settings of an exercise.
type Options struct {
	ReviewPrevious bool   // allow words of earlier lessons to fill a group
	Seed           uint64 // 0: 1
	Tries          int    // random attempts per lesson and group count; 0: 400
	Preset         string // colour preset, see Presets; "": DefaultPreset
	Level          string // level label shown in the star note ("HSK 2"); may be empty
	CourseName     string // names the textbook in the footer ("Từ vựng theo giáo trình …"); may be empty
	VocabSource    string // overrides the footer's source of the vocabulary
	PageTitle      string // default "Ghép bộ thủ thành chữ Hán", plus " – <Level>" when Level is set
	ExcludedChars  string // characters never asked about, on top of the built-in list
}

// IsHanzi reports whether s is not empty and only CJK ideographs (extension A, the unified block, extension B).
func IsHanzi(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if !(r >= 0x3400 && r <= 0x4DBF || r >= 0x4E00 && r <= 0x9FFF || r >= 0x20000 && r <= 0x2A6DF) {
			return false
		}
	}
	return true
}

// PoolWordMeaning is the curated Vietnamese meaning of a word, which Build uses for a word without a Meaning of its
// own; "" when the pool has none.
func PoolWordMeaning(hanzi string) string {
	data, err := loadData()
	if err != nil {
		return ""
	}
	return data.poolWords[hanzi]
}

// ErrNothingToPlay is Build's error when no lesson has enough words for a group.
var ErrNothingToPlay = errors.New("No lesson has enough words for a group.")

const defaultTitle = "Ghép bộ thủ thành chữ Hán"

// Draft is a planned exercise: the questions are chosen, the language data is not complete. Its methods may be
// called from several goroutines.
type Draft struct {
	data     *dataset
	opts     Options
	lessons  []Lesson // sorted, trimmed, every word with its syllables
	groups   map[int][]group
	skipped  []SkippedLesson
	unusable map[int][]string

	mu       sync.Mutex // guards the caches of analysis
	analysis *analysis
}

// Plan checks the lessons, solves the groups of each and works out what language data is still missing. The
// questions do not depend on meanings, nor on the answers to Needs. A lesson that cannot make a group is skipped
// and reported in Review.SkippedLessons.
func Plan(lessons []Lesson, opts Options) (*Draft, error) {
	if _, err := themeCSS(opts.Preset); err != nil {
		return nil, err
	}
	cleaned, err := validate(lessons)
	if err != nil {
		return nil, err
	}
	data, err := loadData()
	if err != nil {
		return nil, err
	}
	seed, tries := opts.Seed, opts.Tries
	if seed == 0 {
		seed = 1
	}
	if tries <= 0 {
		tries = 400
	}

	var chars []string
	seen := map[string]bool{}
	words := map[int][]lessonWord{}
	for _, l := range cleaned {
		for _, w := range l.Words {
			words[l.Number] = append(words[l.Number], lessonWord{hanzi: w.Hanzi, star: w.Star, proper: w.ProperNoun})
			for _, r := range w.Hanzi {
				if !seen[string(r)] {
					seen[string(r)] = true
					chars = append(chars, string(r))
				}
			}
		}
	}
	d := &Draft{data: data, opts: opts, lessons: cleaned, groups: map[int][]group{}, unusable: map[int][]string{}}
	d.analysis = newAnalysis(data, chars, opts.ExcludedChars)
	solver := newGrouper(d.analysis, words, opts.ReviewPrevious, tries, seed)
	for _, l := range cleaned {
		var unusable []string
		usable := 0
		for _, w := range words[l.Number] {
			if w.proper {
				continue
			}
			if len(solver.optionsFor(w.hanzi)) == 0 {
				unusable = append(unusable, w.hanzi)
			} else {
				usable++
			}
		}
		if len(unusable) > 0 {
			d.unusable[l.Number] = unusable
		}
		best := solver.solveLesson(l.Number)
		if best == nil {
			solver.skipped[l.Number] = true
			d.skipped = append(d.skipped, SkippedLesson{Lesson: l.Number, UsableWordCount: usable, UnusableWords: nonNil(unusable)})
			continue
		}
		d.groups[l.Number] = solver.finalize(l.Number, best.groups)
	}
	return d, nil
}

func nonNil[T any](s []T) []T {
	if s == nil {
		return []T{}
	}
	return s
}

// validate copies and trims the lessons, sorted by number, and reports every fault with its lesson and word.
func validate(lessons []Lesson) ([]Lesson, error) {
	if len(lessons) == 0 {
		return nil, errors.New("No lessons were given.")
	}
	var problems []string
	seen := map[int]bool{}
	var out []Lesson
	for _, l := range lessons {
		if l.Number < 1 {
			problems = append(problems, fmt.Sprintf("Lesson number %d must be positive.", l.Number))
			continue
		}
		if seen[l.Number] {
			problems = append(problems, fmt.Sprintf("Lesson %d is declared twice.", l.Number))
			continue
		}
		seen[l.Number] = true
		if len(l.Words) == 0 {
			problems = append(problems, fmt.Sprintf("Lesson %d has no words.", l.Number))
			continue
		}
		clean := Lesson{Number: l.Number, TitleVi: strings.TrimSpace(l.TitleVi), TitleZh: strings.TrimSpace(l.TitleZh)}
		inLesson := map[string]bool{}
		for i, w := range l.Words {
			w.Hanzi, w.Meaning = strings.TrimSpace(w.Hanzi), strings.TrimSpace(w.Meaning)
			w.Pinyin = norm.NFC.String(strings.TrimSpace(w.Pinyin))
			tag := fmt.Sprintf("Lesson %d, word #%d %q", l.Number, i+1, w.Hanzi)
			runes := utf8.RuneCountInString(w.Hanzi)
			switch {
			case !IsHanzi(w.Hanzi):
				problems = append(problems, tag+": only Chinese characters are allowed, no spaces, symbols or pinyin.")
				continue
			case w.Pinyin == "":
				problems = append(problems, tag+": missing pinyin.")
				continue
			case inLesson[w.Hanzi]:
				problems = append(problems, tag+": duplicated within the lesson.")
				continue
			}
			inLesson[w.Hanzi] = true
			if len(w.Syllables) > 0 {
				if len(w.Syllables) != runes {
					problems = append(problems, fmt.Sprintf("%s: syllables must be exactly %d.", tag, runes))
					continue
				}
				syllables := make([]string, runes)
				for i, s := range w.Syllables {
					syllables[i] = norm.NFC.String(strings.TrimSpace(s))
				}
				w.Syllables = syllables
			} else if ways := SplitPinyin(w.Pinyin, runes); len(ways) != 1 {
				problems = append(problems, fmt.Sprintf("%s: pinyin %q does not split into %d syllables in exactly one way (%d ways).", tag, w.Pinyin, runes, len(ways)))
				continue
			} else {
				w.Syllables = ways[0]
			}
			clean.Words = append(clean.Words, w)
		}
		out = append(out, clean)
	}
	if len(problems) > 0 {
		return nil, errors.New(strings.Join(problems, "\n"))
	}
	slices.SortFunc(out, func(a, b Lesson) int { return cmp.Compare(a.Number, b.Number) })
	return out, nil
}

// marshal is json.Marshal for data that goes into a page: HTML characters are escaped.
func marshal(v any) json.RawMessage {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return b
}
