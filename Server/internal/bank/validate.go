package bank

import (
	"errors"
	"fmt"
	"net/url"
	"slices"
	"strings"
	"time"

	"quiz-csv-import-tool/server/internal/csvgen"
	"quiz-csv-import-tool/server/internal/gesturequiz"
	"quiz-csv-import-tool/server/internal/store"
)

// Origin is where the drafts of one model answer come from: the request's vocabulary and language, the model that
// wrote them, and the job they were written for.
type Origin struct {
	Vocabulary csvgen.Vocabulary
	Language   csvgen.Language
	Model      string
	JobID      string
	Now        time.Time
}

// The most a question keeps: wrong answers, and characters in its typed answer.
const (
	maxDistractors = 4
	maxTypedAnswer = 40
)

// Validate turns a draft into a question for the bank, or says why it cannot be one. It trims every text and
// drops what a format does not use, so a stored question is always one the renderer can write.
func Validate(d csvgen.QuestionDraft, origin Origin, id string) (store.Question, error) {
	words := map[string]csvgen.LessonWord{}
	for _, w := range origin.Vocabulary.Words {
		words[w.Key()] = w
	}
	q := store.Question{
		ID: id, Language: int(origin.Language), Book: origin.Vocabulary.Book, MaxLesson: origin.Vocabulary.MaxLesson(),
		Format: strings.TrimSpace(d.Format), Skill: strings.TrimSpace(d.Skill), Difficulty: d.Difficulty,
		Stem:        store.Text{Text: clean(d.Stem), Pinyin: clean(d.StemPinyin)},
		Answer:      store.Text{Text: clean(d.Answer), Pinyin: clean(d.AnswerPinyin)},
		Explanation: clean(d.Explanation), ImageURL: strings.TrimSpace(d.ImageURL),
		Model: origin.Model, JobID: origin.JobID, Status: store.QuestionActive, CreatedAt: origin.Now,
	}
	if !slices.Contains(Formats, q.Format) {
		return store.Question{}, fmt.Errorf("unknown format %q", d.Format)
	}
	if !slices.Contains(Skills, q.Skill) {
		return store.Question{}, fmt.Errorf("unknown skill %q", d.Skill)
	}
	if q.Difficulty < Easy || q.Difficulty > Hard {
		return store.Question{}, fmt.Errorf("difficulty %d is not 1 to 3", d.Difficulty)
	}
	for _, key := range d.Targets {
		w, ok := words[key]
		if !ok {
			return store.Question{}, fmt.Errorf("target %q is not a word of the lessons", key)
		}
		if !slices.Contains(q.Targets, key) {
			q.Targets = append(q.Targets, key)
		}
		if !slices.Contains(q.Lessons, w.Lesson) {
			q.Lessons = append(q.Lessons, w.Lesson)
		}
	}
	slices.Sort(q.Lessons)
	if len(q.Targets) == 0 {
		return store.Question{}, errors.New("no target word")
	}
	if q.Stem.Text == "" || q.Answer.Text == "" || q.Explanation == "" {
		return store.Question{}, errors.New("an empty stem, answer or explanation")
	}

	for _, t := range d.Distractors {
		text := store.Text{Text: clean(t.Text), Pinyin: clean(t.Pinyin)}
		if text.Text == "" || sameText(text.Text, q.Answer.Text) ||
			slices.ContainsFunc(q.Distractors, func(o store.Text) bool { return sameText(o.Text, text.Text) }) {
			continue
		}
		q.Distractors = append(q.Distractors, text)
	}
	switch q.Format {
	case FormatMC:
		if len(q.Distractors) == 0 {
			return store.Question{}, errors.New("a multiple-choice question without wrong answers")
		}
		q.Distractors = q.Distractors[:min(len(q.Distractors), maxDistractors)]
	case FormatTrueFalse:
		switch fold(strings.TrimRight(q.Answer.Text, ".!。！ ")) {
		case "đúng", "dung", "true":
			q.Answer = store.Text{Text: gesturequiz.TrueAnswer}
		case "sai", "false":
			q.Answer = store.Text{Text: gesturequiz.FalseAnswer}
		default:
			return store.Question{}, fmt.Errorf("a true/false answer %q that is neither Đúng nor Sai", q.Answer.Text)
		}
		q.Distractors = nil
	case FormatWordOrder:
		for _, c := range d.Chunks {
			if text := clean(c.Text); text != "" {
				q.Chunks = append(q.Chunks, store.Text{Text: text, Pinyin: clean(c.Pinyin)})
			}
		}
		if len(q.Chunks) < 2 || len(q.Chunks) > 8 {
			return store.Question{}, fmt.Errorf("a sentence of %d chunks, want 2 to 8", len(q.Chunks))
		}
		joined := ""
		for _, c := range q.Chunks {
			joined += c.Text
		}
		if squeeze(joined) != squeeze(q.Answer.Text) {
			return store.Question{}, fmt.Errorf("chunks %q do not make the answer %q", joined, q.Answer.Text)
		}
		q.Distractors = slices.DeleteFunc(q.Distractors, func(t store.Text) bool { return squeeze(t.Text) == squeeze(q.Answer.Text) })
		q.Distractors = q.Distractors[:min(len(q.Distractors), maxDistractors)]
	case FormatTyped:
		if runeCount(q.Answer.Text) > maxTypedAnswer {
			return store.Question{}, errors.New("a typed answer too long to type")
		}
		q.Distractors = nil
	}

	if q.Skill == SkillVisual {
		if !usableImage(q.ImageURL) {
			return store.Question{}, fmt.Errorf("a visual question without a usable image link (%q)", q.ImageURL)
		}
	} else {
		q.ImageURL = ""
	}

	if origin.Language == csvgen.Chinese {
		// A question about the pinyin itself has none beside its texts, which would give it away.
		if q.Skill != SkillForm {
			if err := needPinyin(q); err != nil {
				return store.Question{}, err
			}
		}
	} else {
		dropPinyin(&q)
	}
	q.Fingerprint = Fingerprint(q.Format, q.Stem.Text, q.Answer.Text)
	return q, nil
}

// needPinyin says which text with Chinese characters has no pinyin, if any.
func needPinyin(q store.Question) error {
	check := func(what string, t store.Text) error {
		if hasHan(t.Text) && t.Pinyin == "" {
			return fmt.Errorf("the %s %q has no pinyin", what, t.Text)
		}
		return nil
	}
	errs := []error{check("stem", q.Stem)}
	if q.Format != FormatTrueFalse {
		errs = append(errs, check("answer", q.Answer))
	}
	for _, d := range q.Distractors {
		if q.Format != FormatWordOrder {
			errs = append(errs, check("wrong answer", d))
		}
	}
	for _, c := range q.Chunks {
		errs = append(errs, check("chunk", c))
	}
	return errors.Join(errs...)
}

func dropPinyin(q *store.Question) {
	q.Stem.Pinyin, q.Answer.Pinyin = "", ""
	for i := range q.Distractors {
		q.Distractors[i].Pinyin = ""
	}
	for i := range q.Chunks {
		q.Chunks[i].Pinyin = ""
	}
}

// usableImage is an image link a quiz platform loads: https, and not Wikimedia's, which they cannot load.
func usableImage(link string) bool {
	u, err := url.Parse(link)
	if err != nil || u.Scheme != "https" || u.Host == "" {
		return false
	}
	host := strings.ToLower(u.Hostname())
	for _, banned := range []string{"wikimedia.org", "wikipedia.org"} {
		if host == banned || strings.HasSuffix(host, "."+banned) {
			return false
		}
	}
	return true
}

// clean is a text on one line: CSV cells hold no line break, so every run of white space becomes one space.
func clean(text string) string {
	return strings.Join(strings.Fields(text), " ")
}

// sameText says whether two options read the same.
func sameText(a, b string) bool { return fold(a) == fold(b) }

// squeeze is a text without its white space, so a sentence and its chunks compare equal however they are spaced.
func squeeze(text string) string {
	return strings.Join(strings.Fields(fold(text)), "")
}
