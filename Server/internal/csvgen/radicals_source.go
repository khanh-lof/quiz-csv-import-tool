package csvgen

import (
	"encoding/json"
	"errors"
	"slices"
	"strings"

	"quiz-csv-import-tool/server/internal/radicals"
)

const radicalsSourceVersion = 1

// radicalsSource is what a Radicals exercise is built from, kept on its job as JSON (store.Job.Source) so the
// teacher's corrections can build it again without the model: every word with where its notes came from (those
// left out for want of a reading included), the notes the model wrote for the characters and components the pools
// lack, and the settings. The groups depend only on the words' characters, so a correction of a pinyin or a note
// rebuilds the same questions.
type radicalsSource struct {
	Version int              `json:"version"`
	Lessons []radicalsLesson `json:"lessons"`
	// Chars and Components are the notes that are not in the pools, the model's or the teacher's (radicals.Info).
	Chars      map[string]string                 `json:"chars"`
	Components map[string]radicals.ComponentInfo `json:"components"`
	// AIChars and AIComponents are the keys of Chars and Components whose note the model wrote and the teacher
	// left as it was.
	AIChars        []string `json:"aiChars"`
	AIComponents   []string `json:"aiComponents"`
	ReviewPrevious bool     `json:"reviewPrevious"`
	Preset         string   `json:"preset"`
	Level          string   `json:"level"`
	CourseName     string   `json:"courseName"`
}

func readRadicalsSource(raw string) (*radicalsSource, error) {
	var src radicalsSource
	if err := json.Unmarshal([]byte(raw), &src); err != nil {
		return nil, err
	}
	if src.Version != radicalsSourceVersion {
		return nil, errors.New("unknown radicals source version")
	}
	if src.Chars == nil {
		src.Chars = map[string]string{}
	}
	if src.Components == nil {
		src.Components = map[string]radicals.ComponentInfo{}
	}
	return &src, nil
}

// plan solves the groups of the words that have a reading; a lesson left without any word is left out.
func (s *radicalsSource) plan() (*radicals.Draft, error) {
	var lessons []radicals.Lesson
	for _, l := range s.Lessons {
		lesson := radicals.Lesson{Number: l.Number, TitleZh: l.TitleZh, TitleVi: l.TitleVi}
		for _, w := range l.Words {
			if hasReading(w.Word) {
				lesson.Words = append(lesson.Words, w.Word)
			}
		}
		if len(lesson.Words) > 0 {
			lessons = append(lessons, lesson)
		}
	}
	if len(lessons) == 0 {
		return nil, radicals.ErrNothingToPlay
	}
	return radicals.Plan(lessons, radicals.Options{
		ReviewPrevious: s.ReviewPrevious, Preset: s.Preset, Level: s.Level, CourseName: s.CourseName,
	})
}

// addDetails keeps the model's answer to the details request, as far as it answers what was asked: a word's
// meaning goes on the word, the notes of characters and components into Chars and Components.
func (s *radicalsSource) addDetails(answer detailsAnswer, needs radicals.Needs) {
	for _, need := range needs.Words {
		if meaning := strings.TrimSpace(answer.Words[need.Hanzi]); meaning != "" {
			s.eachWord(need.Hanzi, func(w *radicalsWord) {
				if w.Meaning == "" && hasReading(w.Word) {
					w.Meaning, w.AIMeaning = meaning, true
				}
			})
		}
	}
	for _, need := range needs.Chars {
		if meaning, ok := answer.Chars[need.Char]; ok {
			s.Chars[need.Char] = meaning
			s.AIChars = append(s.AIChars, need.Char)
		}
	}
	for _, need := range needs.Components {
		if info, ok := answer.Components[need.Component]; ok {
			s.Components[need.Component] = info
			s.AIComponents = append(s.AIComponents, need.Component)
		}
	}
	slices.Sort(s.AIChars)
	slices.Sort(s.AIComponents)
}

// eachWord calls change with every occurrence of a word, in every lesson.
func (s *radicalsSource) eachWord(hanzi string, change func(*radicalsWord)) {
	for i := range s.Lessons {
		for j := range s.Lessons[i].Words {
			if s.Lessons[i].Words[j].Hanzi == hanzi {
				change(&s.Lessons[i].Words[j])
			}
		}
	}
}

// build assembles the exercise planned by draft and returns it with the source, both as JSON.
func (s *radicalsSource) build(draft *radicals.Draft) (Result, error) {
	exercise, err := draft.Build(radicals.Info{CharMeanings: s.Chars, Components: s.Components})
	if err != nil {
		return Result{}, err
	}
	s.fillReview(&exercise.Review)
	out, err := json.Marshal(exercise)
	if err != nil {
		return Result{}, err
	}
	source, err := json.Marshal(s)
	if err != nil {
		return Result{}, err
	}
	return Result{CSV: string(out), Source: string(source)}, nil
}

// fillReview fills in the part of the review the engine leaves to its caller: the words, characters and
// components the model wrote, the words it was not sure of, and the words left out. The dictionary misses readings
// of many polyphonic characters, so its pinyin warnings are kept only for the pinyin the model wrote: the
// textbook's is curated, and the teacher's is the teacher's.
func (s *radicalsSource) fillReview(review *radicals.Review) {
	review.AIWords, review.UncertainWords, review.DroppedWords = []string{}, []string{}, []string{}
	aiPinyin := map[string]bool{}
	for _, l := range s.Lessons {
		for _, w := range l.Words {
			switch {
			case !hasReading(w.Word):
				review.DroppedWords = appendNew(review.DroppedWords, w.Hanzi)
			case w.fromModel():
				review.AIWords = appendNew(review.AIWords, w.Hanzi)
				if w.Uncertain {
					review.UncertainWords = appendNew(review.UncertainWords, w.Hanzi)
				}
				aiPinyin[w.Hanzi] = aiPinyin[w.Hanzi] || w.AIPinyin
			}
		}
	}
	review.PinyinWarnings = slices.DeleteFunc(review.PinyinWarnings, func(w radicals.PinyinWarning) bool { return !aiPinyin[w.Word] })
	review.AIChars = append([]string{}, s.AIChars...)
	review.AIComponents = append([]string{}, s.AIComponents...)
}
