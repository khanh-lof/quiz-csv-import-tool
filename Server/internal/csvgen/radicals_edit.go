package csvgen

import (
	"errors"
	"slices"
	"strings"
	"unicode/utf8"

	"golang.org/x/text/unicode/norm"

	"quiz-csv-import-tool/server/internal/radicals"
)

// RadicalsEdit is the table of what the teacher may correct in a Radicals exercise: the words whose pinyin or
// meaning the model wrote, the teacher changed, or that were left out for want of a reading, and the notes of every
// character and component the curated pools lack. It is what GET csv/jobs/{id}/radicals answers, and what PUT sends
// back with the values changed (the other fields are ignored there).
type RadicalsEdit struct {
	Words      []EditWord      `json:"words"`
	Chars      []EditChar      `json:"chars"`
	Components []EditComponent `json:"components"`
}

// EditWord is a word of the table, once however many lessons have it; a correction changes it in all of them.
type EditWord struct {
	Hanzi   string `json:"hanzi"`
	Lessons []int  `json:"lessons"`
	Pinyin  string `json:"pinyin"`
	// Meaning is the word's own, or the pool's when it has none.
	Meaning   string `json:"meaning"`
	AI        bool   `json:"ai"` // the model wrote its pinyin or its meaning
	Uncertain bool   `json:"uncertain"`
	// Dropped words are not in the exercise: their pinyin does not cut into one syllable per character.
	Dropped bool   `json:"dropped"`
	Problem string `json:"problem,omitempty"`
}

// EditChar is a character whose meaning is not in the pool.
type EditChar struct {
	Char    string   `json:"char"`
	Meaning string   `json:"meaning"`
	InWords []string `json:"inWords"`
	AI      bool     `json:"ai"`
	Problem string   `json:"problem,omitempty"`
}

// EditComponent is a component whose description is not in the pool.
type EditComponent struct {
	Component string   `json:"component"`
	Name      string   `json:"name"`
	Pinyin    string   `json:"pinyin"`
	Meaning   string   `json:"meaning"`
	InChars   []string `json:"inChars"`
	AI        bool     `json:"ai"`
	Problem   string   `json:"problem,omitempty"`
}

// The problems ReviseRadicals flags on a row of the table.
const (
	// ProblemPinyin: the pinyin typed does not cut into one syllable per character; the row shows it as typed.
	ProblemPinyin = "pinyin"
	// ProblemMissing: the exercise needs this meaning (for a component, at least its meaning) and has none.
	ProblemMissing = "missing"
)

var (
	// ErrInvalidCorrections is ReviseRadicals' error for a row that names no word of the exercise, a character
	// that is not one Chinese character, or a value too long.
	ErrInvalidCorrections = errors.New("Invalid corrections.")
	// ErrIncomplete is ReviseRadicals' error when the table it returns has rows with a problem.
	ErrIncomplete = errors.New("Corrections are incomplete.")
)

const (
	maxEditPinyinRunes    = 100
	maxEditNoteRunes      = 200
	maxEditComponentRunes = 16
)

// RadicalsEditOf is the table of what the teacher may correct in the exercise built from source.
func RadicalsEditOf(source string) (*RadicalsEdit, error) {
	src, err := readRadicalsSource(source)
	if err != nil {
		return nil, err
	}
	draft, err := src.plan()
	if err != nil {
		return nil, err
	}
	return src.edit(draft.Needs(), nil), nil
}

// ReviseRadicals applies the teacher's corrections to the source an exercise was built from and builds it again,
// without the model. A value equal to the one the table shows changes nothing, so the whole table can be sent
// back; a changed one is the teacher's from then on and leaves the review's lists of what the model wrote. An empty
// pinyin leaves the word out of the exercise. Nothing is built while a pinyin does not cut into one syllable per
// character or a note the exercise needs is empty: the table comes back with those rows flagged, and
// ErrIncomplete. radicals.ErrNothingToPlay when the corrections leave no lesson that can be grouped.
func ReviseRadicals(source string, corrections RadicalsEdit) (Result, *RadicalsEdit, error) {
	src, err := readRadicalsSource(source)
	if err != nil {
		return Result{}, nil, err
	}
	badPinyin, err := src.apply(corrections)
	if err != nil {
		return Result{}, nil, err
	}
	draft, err := src.plan()
	if err != nil {
		return Result{}, nil, err
	}
	if edit := src.edit(draft.Needs(), badPinyin); edit.hasProblems() {
		return Result{}, edit, ErrIncomplete
	}
	result, err := src.build(draft)
	return result, nil, err
}

// apply changes the source as the corrections say and returns the words whose pinyin could not be used, with the
// pinyin as typed; those words keep their reading.
func (s *radicalsSource) apply(corrections RadicalsEdit) (map[string]string, error) {
	badPinyin := map[string]string{}
	for _, row := range corrections.Words {
		hanzi := strings.TrimSpace(row.Hanzi)
		pinyin, meaning := norm.NFC.String(strings.TrimSpace(row.Pinyin)), strings.TrimSpace(row.Meaning)
		shown := s.firstWord(hanzi)
		if shown == nil || utf8.RuneCountInString(pinyin) > maxEditPinyinRunes || utf8.RuneCountInString(meaning) > maxEditNoteRunes {
			return nil, ErrInvalidCorrections
		}
		pinyinChanged := pinyin != norm.NFC.String(shown.Pinyin)
		meaningChanged := meaning != shownMeaning(*shown)
		var syllables []string
		if pinyinChanged && pinyin != "" {
			if syllables = radicals.SplitPinyinFor(hanzi, pinyin); syllables == nil {
				badPinyin[hanzi] = pinyin
				pinyinChanged = false
			}
		}
		if !pinyinChanged && !meaningChanged {
			continue
		}
		s.eachWord(hanzi, func(w *radicalsWord) {
			if pinyinChanged {
				w.Pinyin, w.Syllables, w.AIPinyin = pinyin, syllables, false
			}
			if meaningChanged {
				w.Meaning, w.AIMeaning = meaning, false
			}
			w.Edited, w.Uncertain = true, false
		})
	}
	for _, row := range corrections.Chars {
		char, meaning := strings.TrimSpace(row.Char), strings.TrimSpace(row.Meaning)
		if utf8.RuneCountInString(char) != 1 || !radicals.IsHanzi(char) || utf8.RuneCountInString(meaning) > maxEditNoteRunes {
			return nil, ErrInvalidCorrections
		}
		if meaning == strings.TrimSpace(s.Chars[char]) {
			continue
		}
		if meaning == "" {
			delete(s.Chars, char)
		} else {
			s.Chars[char] = meaning
		}
		s.AIChars = slices.DeleteFunc(s.AIChars, func(c string) bool { return c == char })
	}
	for _, row := range corrections.Components {
		component := strings.TrimSpace(row.Component)
		info := trimmedComponent(radicals.ComponentInfo{Name: row.Name, Pinyin: row.Pinyin, Meaning: row.Meaning})
		if component == "" || utf8.RuneCountInString(component) > maxEditComponentRunes || utf8.RuneCountInString(info.Name) > maxEditNoteRunes ||
			utf8.RuneCountInString(info.Pinyin) > maxEditPinyinRunes || utf8.RuneCountInString(info.Meaning) > maxEditNoteRunes {
			return nil, ErrInvalidCorrections
		}
		if info == trimmedComponent(s.Components[component]) {
			continue
		}
		// One without a meaning is kept only to be shown back: the table flags it, and nothing is built.
		if info == (radicals.ComponentInfo{}) {
			delete(s.Components, component)
		} else {
			s.Components[component] = info
		}
		s.AIComponents = slices.DeleteFunc(s.AIComponents, func(c string) bool { return c == component })
	}
	return badPinyin, nil
}

// firstWord is the first occurrence of a word, which the table shows; nil when no lesson has it.
func (s *radicalsSource) firstWord(hanzi string) *radicalsWord {
	for i := range s.Lessons {
		for j := range s.Lessons[i].Words {
			if s.Lessons[i].Words[j].Hanzi == hanzi {
				return &s.Lessons[i].Words[j]
			}
		}
	}
	return nil
}

// shownMeaning is the meaning the exercise gives a word: its own, else the pool's.
func shownMeaning(w radicalsWord) string {
	if w.Meaning != "" {
		return w.Meaning
	}
	return radicals.PoolWordMeaning(w.Hanzi)
}

func trimmedComponent(info radicals.ComponentInfo) radicals.ComponentInfo {
	return radicals.ComponentInfo{Name: strings.TrimSpace(info.Name), Pinyin: strings.TrimSpace(info.Pinyin), Meaning: strings.TrimSpace(info.Meaning)}
}

// edit is the table of the source, given what the draft needs from outside the pools (draft.Needs) and the pinyin
// typed that could not be used.
func (s *radicalsSource) edit(needs radicals.Needs, badPinyin map[string]string) *RadicalsEdit {
	edit := &RadicalsEdit{Words: []EditWord{}, Chars: []EditChar{}, Components: []EditComponent{}}
	missing := map[string]bool{}
	for _, need := range needs.Words {
		missing[need.Hanzi] = true
	}
	var listed []string
	for _, l := range s.Lessons {
		for _, w := range l.Words {
			_, bad := badPinyin[w.Hanzi]
			if w.fromModel() || w.Edited || !hasReading(w.Word) || missing[w.Hanzi] || bad {
				listed = appendNew(listed, w.Hanzi)
			}
		}
	}
	for _, hanzi := range listed {
		// The values are the first occurrence's, as apply compares them; the flags are any occurrence's.
		first := s.firstWord(hanzi)
		row := EditWord{Hanzi: hanzi, Lessons: []int{}, Pinyin: first.Pinyin, Meaning: shownMeaning(*first)}
		for _, l := range s.Lessons {
			for _, w := range l.Words {
				if w.Hanzi == hanzi {
					row.Lessons = append(row.Lessons, l.Number)
					row.AI = row.AI || w.fromModel()
					row.Uncertain = row.Uncertain || w.fromModel() && w.Uncertain
					row.Dropped = row.Dropped || !hasReading(w.Word)
				}
			}
		}
		if typed, bad := badPinyin[hanzi]; bad {
			row.Pinyin, row.Problem = typed, ProblemPinyin
		} else if missing[hanzi] {
			row.Problem = ProblemMissing
		}
		edit.Words = append(edit.Words, row)
	}
	for _, need := range needs.Chars {
		row := EditChar{Char: need.Char, Meaning: strings.TrimSpace(s.Chars[need.Char]), InWords: need.InWords, AI: slices.Contains(s.AIChars, need.Char)}
		if row.Meaning == "" {
			row.Problem = ProblemMissing
		}
		edit.Chars = append(edit.Chars, row)
	}
	for _, need := range needs.Components {
		info := trimmedComponent(s.Components[need.Component])
		row := EditComponent{Component: need.Component, Name: info.Name, Pinyin: info.Pinyin, Meaning: info.Meaning, InChars: need.InChars,
			AI: slices.Contains(s.AIComponents, need.Component)}
		if row.Meaning == "" {
			row.Problem = ProblemMissing
		}
		edit.Components = append(edit.Components, row)
	}
	return edit
}

func (e *RadicalsEdit) hasProblems() bool {
	return slices.ContainsFunc(e.Words, func(r EditWord) bool { return r.Problem != "" }) ||
		slices.ContainsFunc(e.Chars, func(r EditChar) bool { return r.Problem != "" }) ||
		slices.ContainsFunc(e.Components, func(r EditComponent) bool { return r.Problem != "" })
}
