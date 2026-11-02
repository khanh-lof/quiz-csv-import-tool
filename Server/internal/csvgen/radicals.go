package csvgen

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"slices"
	"strings"
	"unicode/utf8"

	"quiz-csv-import-tool/server/internal/radicals"
)

var (
	//go:embed prompts/radicals_vocabulary.txt
	radicalsVocabularyPrompt string
	//go:embed prompts/radicals_details.txt
	radicalsDetailsPrompt string
)

// wordSource is where the words of a lesson of a Radicals exercise come from.
type wordSource int

const (
	// wordsGiven: the teacher typed them; the model only fills in what neither the teacher nor the textbook has.
	wordsGiven wordSource = iota
	// wordsFromBook: the lesson document of an embedded textbook has all of them.
	wordsFromBook
	// wordsFromModel: the model lists them, from the photos or from its knowledge of the lesson.
	wordsFromModel
)

// radicalsLesson is a lesson of the exercise while its words are gathered.
type radicalsLesson struct {
	radicals.Lesson
	source wordSource
}

// hasReading says whether the pinyin of a word is known, cut into one syllable per character. A word without a
// meaning can still be planned: the second request asks for it with the characters.
func hasReading(word radicals.Word) bool {
	return word.Pinyin != "" && len(word.Syllables) == utf8.RuneCountInString(word.Hanzi)
}

// withSyllables fills in the syllables of a word whose pinyin cuts into one per character in a single way, the
// characters' readings deciding between the ways the letters allow.
func withSyllables(word radicals.Word) radicals.Word {
	if len(word.Syllables) == 0 && word.Pinyin != "" {
		word.Syllables = radicals.SplitPinyinFor(word.Hanzi, word.Pinyin)
	}
	return word
}

// generateRadicals builds a "Ghép bộ thủ" exercise and returns it as JSON (radicals.Exercise), which is what a
// Radicals job stores in place of a CSV. It asks the model at most twice: once for the words that neither the
// teacher nor the textbook gave in full, once for the meanings of characters and the names of components that
// the curated pools lack. The rest is package radicals' work.
func (c *Client) generateRadicals(ctx context.Context, images []Image, opts Options) (string, error) {
	model := c.modelFor(opts)
	lessons := gatherRadicalsLessons(opts)
	var review aiReview
	if slices.ContainsFunc(lessons, needsModel) {
		text, err := c.respond(ctx, buildRadicalsVocabularyRequest(model, images, opts, lessons))
		if err != nil {
			return "", err
		}
		var answer vocabularyAnswer
		if err := decodeJSONAnswer(text, &answer); err != nil {
			return "", err
		}
		lessons, review = mergeVocabulary(lessons, answer)
	}

	// A lesson left without any word (the model listed none, or none had a reading) has nothing to group.
	lessons = slices.DeleteFunc(lessons, func(l radicalsLesson) bool { return len(l.Words) == 0 })
	if len(lessons) == 0 {
		return "", radicals.ErrNothingToPlay
	}
	draft, err := radicals.Plan(plainLessons(lessons), radicals.Options{
		ReviewPrevious: opts.ReviewPrevious,
		Preset:         opts.ColorPreset,
		Level:          radicalsLevel(opts),
		CourseName:     radicalsCourseName(opts),
	})
	if err != nil {
		return "", err
	}
	info := radicals.Info{}
	if needs := draft.Needs(); len(needs.Words)+len(needs.Chars)+len(needs.Components) > 0 {
		text, err := c.respond(ctx, buildRadicalsDetailsRequest(model, needs))
		if err != nil {
			return "", err
		}
		var answer detailsAnswer
		if err := decodeJSONAnswer(text, &answer); err != nil {
			return "", err
		}
		info = radicals.Info{WordMeanings: answer.Words, CharMeanings: answer.Chars, Components: answer.Components}
		review.chars, review.components = sortedKeys(answer.Chars), sortedKeys(answer.Components)
		for _, hanzi := range sortedKeys(answer.Words) {
			review.words = appendNew(review.words, hanzi)
		}
	}
	exercise, err := draft.Build(info)
	if err != nil {
		return "", err
	}
	// The dictionary misses readings of many polyphonic characters, so its warnings are kept for the pinyin the
	// model wrote: the textbook's is curated, and the teacher typed none.
	exercise.Review.PinyinWarnings = slices.DeleteFunc(exercise.Review.PinyinWarnings, func(w radicals.PinyinWarning) bool {
		return !slices.Contains(review.words, w.Word)
	})
	exercise.Review.AIWords = review.words
	exercise.Review.UncertainWords = review.uncertain
	exercise.Review.DroppedWords = review.dropped
	exercise.Review.AIChars = review.chars
	exercise.Review.AIComponents = review.components
	out, err := json.Marshal(exercise)
	if err != nil {
		return "", err
	}
	return string(out), nil
}

// aiReview is what the teacher should check because the model wrote it.
type aiReview struct {
	words, uncertain, dropped, chars, components []string
}

// needsModel says whether the first request must cover the lesson: its words are the model's to list, or one
// of them has no reading yet.
func needsModel(lesson radicalsLesson) bool {
	return lesson.source == wordsFromModel || slices.ContainsFunc(lesson.Words, func(w radicals.Word) bool { return !hasReading(w) })
}

// gatherRadicalsLessons sets out the lessons of the request with what is known of their words before asking
// the model: the teacher's words, completed from the textbook where it has them, or the textbook's own list.
func gatherRadicalsLessons(opts Options) []radicalsLesson {
	book := textbookFor(opts)
	lessons := make([]radicalsLesson, 0, len(opts.LessonNumbers))
	for _, number := range opts.LessonNumbers {
		lesson := radicalsLesson{Lesson: radicals.Lesson{Number: number}, source: wordsFromModel}
		var bookWords []radicals.Word
		if book != nil && number <= book.lessons {
			lesson.TitleZh, lesson.TitleVi = lessonTitles(book.docs[number-1])
			bookWords = lessonVocabulary(book.docs[number-1])
			lesson.source = wordsFromBook
			lesson.Words = bookWords
		}
		if typed := opts.Vocabulary[number]; len(typed) > 0 {
			lesson.source = wordsGiven
			lesson.Words = make([]radicals.Word, len(typed))
			for i, hanzi := range typed {
				lesson.Words[i] = radicals.Word{Hanzi: hanzi}
				if j := slices.IndexFunc(bookWords, func(w radicals.Word) bool { return w.Hanzi == hanzi }); j >= 0 {
					lesson.Words[i] = bookWords[j]
				}
			}
		}
		lessons = append(lessons, lesson)
	}
	return lessons
}

var (
	// lessonTitleLine is the first line of a lesson document: "# 《HSK标准教程1》 Lesson 5 — 她女儿今年二十岁".
	lessonTitleLine = regexp.MustCompile(`^# .* Lesson \d+ — (.+)$`)
	// optionalPart is a bracketed part of a textbook word, 南（方）, or of its pinyin, nán (fāng).
	optionalPart = regexp.MustCompile(`\s*[（(]\s*([^）)]*?)\s*[）)]`)
)

// lessonTitles reads the Chinese title from the first line of a lesson document and the Vietnamese one from
// the second ("English: … · Tiếng Việt: …").
func lessonTitles(doc string) (zh, vi string) {
	lines := strings.SplitN(doc, "\n", 3)
	if m := lessonTitleLine.FindStringSubmatch(strings.TrimSpace(lines[0])); m != nil {
		zh = strings.TrimSpace(m[1])
	}
	if len(lines) > 1 {
		if _, after, ok := strings.Cut(lines[1], "Tiếng Việt:"); ok {
			vi = strings.TrimSpace(after)
		}
	}
	return zh, vi
}

// lessonVocabulary returns the words of a lesson document's New words and Proper nouns tables, as the exercise
// takes them: a bracketed optional part is written in full (南（方） → 南方) unless it is 儿, a pattern such as
// 一……就…… becomes its words, the first of two readings is kept (shéi/shuí), and a word repeated is kept once.
func lessonVocabulary(doc string) []radicals.Word {
	var words []radicals.Word
	add := func(word radicals.Word) {
		if !radicals.IsHanzi(word.Hanzi) || slices.ContainsFunc(words, func(w radicals.Word) bool { return w.Hanzi == word.Hanzi }) {
			return
		}
		words = append(words, withSyllables(word))
	}
	section := ""
	for _, line := range strings.Split(doc, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "## ") {
			section = line
			continue
		}
		if (section != "## New words" && section != "## Proper nouns") || !strings.HasPrefix(line, "|") ||
			strings.HasPrefix(line, "|---") || strings.HasPrefix(line, "| Word ") {
			continue
		}
		cells := splitTableRow(line)
		proper := section == "## Proper nouns"
		if (!proper && len(cells) != newWordsColumns) || (proper && len(cells) != 4) {
			continue
		}
		hanzi, pinyin := expandOptional(cells[0]), expandOptional(cells[1])
		meaning, star := cells[4-boolInt(proper)], !proper && strings.Contains(cells[5], "★")
		if alternatives := strings.Split(pinyin, "/"); len(alternatives) > 1 {
			pinyin = alternatives[0]
		}
		pinyin = strings.ReplaceAll(pinyin, "-", "")
		hanziParts, pinyinParts := splitPattern(hanzi), splitPattern(pinyin)
		if len(hanziParts) != len(pinyinParts) {
			continue
		}
		for i := range hanziParts {
			// A pattern's parts share the pattern's meaning, which says nothing about each part alone.
			partMeaning := meaning
			if len(hanziParts) > 1 {
				partMeaning = ""
			}
			add(radicals.Word{Hanzi: hanziParts[i], Pinyin: pinyinParts[i], Meaning: partMeaning, Star: star, ProperNoun: proper})
		}
	}
	return words
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

// expandOptional writes a bracketed optional part in full, or drops it when it is the r-ending (儿, r).
func expandOptional(cell string) string {
	return optionalPart.ReplaceAllStringFunc(cell, func(match string) string {
		inner := optionalPart.FindStringSubmatch(match)[1]
		if inner == "儿" || inner == "r" {
			return ""
		}
		return inner
	})
}

// splitPattern cuts a pattern such as 一……就…… (or its pinyin yī… jiù…) into its parts.
func splitPattern(cell string) []string {
	var parts []string
	for _, part := range strings.FieldsFunc(cell, func(r rune) bool { return r == '…' }) {
		if part = strings.TrimSpace(part); part != "" {
			parts = append(parts, part)
		}
	}
	return parts
}

func plainLessons(lessons []radicalsLesson) []radicals.Lesson {
	out := make([]radicals.Lesson, len(lessons))
	for i, lesson := range lessons {
		out[i] = lesson.Lesson
	}
	return out
}

// radicalsLevel is the level as the page names it in its ★ note, e.g. "HSK 2".
func radicalsLevel(opts Options) string {
	if opts.Level == nil {
		return ""
	}
	switch opts.CourseType {
	case Hsk:
		if opts.HskStandard == Hsk3 {
			return fmt.Sprintf("HSK 3.0 cấp %d", *opts.Level)
		}
		return fmt.Sprintf("HSK %d", *opts.Level)
	case Yct:
		return fmt.Sprintf("YCT %d", *opts.Level)
	}
	return fmt.Sprintf("cấp %d", *opts.Level)
}

// radicalsCourseName is the course as the page's footer names it.
func radicalsCourseName(opts Options) string {
	if book := textbookFor(opts); book != nil {
		return book.title
	}
	if opts.CourseType == Other {
		return opts.CourseName
	}
	return ""
}

// vocabularyAnswer is the model's answer to the vocabulary request (prompts/radicals_vocabulary.txt).
type vocabularyAnswer struct {
	Lessons []vocabularyLesson `json:"lessons"`
}

type vocabularyLesson struct {
	Number  int              `json:"number"`
	TitleZh string           `json:"titleZh"`
	TitleVi string           `json:"titleVi"`
	Words   []vocabularyWord `json:"words"`
}

type vocabularyWord struct {
	Hanzi      string   `json:"hanzi"`
	Pinyin     string   `json:"pinyin"`
	Syllables  []string `json:"syllables"`
	Meaning    string   `json:"meaning"`
	ProperNoun bool     `json:"properNoun"`
	Uncertain  bool     `json:"uncertain"`
}

func (w vocabularyWord) word() radicals.Word {
	return radicals.Word{
		Hanzi: strings.TrimSpace(w.Hanzi), Pinyin: strings.TrimSpace(w.Pinyin), Syllables: trimAll(w.Syllables),
		Meaning: strings.TrimSpace(w.Meaning), ProperNoun: w.ProperNoun,
	}
}

// detailsAnswer is the model's answer to the details request (prompts/radicals_details.txt).
type detailsAnswer struct {
	Words      map[string]string                  `json:"words"`
	Chars      map[string]string                  `json:"chars"`
	Components map[string]radicals.ComponentInfo `json:"components"`
}

// mergeVocabulary completes the lessons with the model's answer. What the teacher or the textbook gave is kept,
// and a lesson whose words are the model's takes them as they come, minus anything that is not a word. A word
// still without a reading, one pinyin syllable per character, is dropped and named for the teacher.
func mergeVocabulary(lessons []radicalsLesson, answer vocabularyAnswer) ([]radicalsLesson, aiReview) {
	var review aiReview
	for i := range lessons {
		lesson := &lessons[i]
		if !needsModel(*lesson) {
			continue
		}
		var answered vocabularyLesson
		if k := slices.IndexFunc(answer.Lessons, func(l vocabularyLesson) bool { return l.Number == lesson.Number }); k >= 0 {
			answered = answer.Lessons[k]
		}
		if lesson.TitleZh == "" {
			lesson.TitleZh = strings.TrimSpace(answered.TitleZh)
		}
		if lesson.TitleVi == "" {
			lesson.TitleVi = strings.TrimSpace(answered.TitleVi)
		}
		uncertain := map[string]bool{}
		var candidates []radicals.Word
		var fromModel []bool
		if lesson.source == wordsFromModel {
			for _, w := range answered.Words {
				word := w.word()
				if radicals.IsHanzi(word.Hanzi) {
					candidates, fromModel = append(candidates, word), append(fromModel, true)
					uncertain[word.Hanzi] = uncertain[word.Hanzi] || w.Uncertain
				}
			}
		} else {
			for _, known := range lesson.Words {
				filled := known
				if !hasReading(known) || known.Meaning == "" {
					if m := slices.IndexFunc(answered.Words, func(w vocabularyWord) bool { return strings.TrimSpace(w.Hanzi) == known.Hanzi }); m >= 0 {
						filled = fillWord(known, answered.Words[m].word())
						uncertain[known.Hanzi] = answered.Words[m].Uncertain
					}
				}
				candidates, fromModel = append(candidates, filled), append(fromModel, filled.Pinyin != known.Pinyin || filled.Meaning != known.Meaning)
			}
		}
		var kept []radicals.Word
		for j, word := range candidates {
			word = usableSyllables(word)
			if slices.ContainsFunc(kept, func(w radicals.Word) bool { return w.Hanzi == word.Hanzi }) {
				continue
			}
			if !hasReading(word) {
				review.dropped = appendNew(review.dropped, word.Hanzi)
				continue
			}
			if fromModel[j] {
				review.words = appendNew(review.words, word.Hanzi)
				if uncertain[word.Hanzi] {
					review.uncertain = appendNew(review.uncertain, word.Hanzi)
				}
			}
			kept = append(kept, word)
		}
		lesson.Words = kept
	}
	return lessons, review
}

// fillWord completes what is known of a word with the model's answer, keeping the known parts. The model's
// syllables are only taken with its own pinyin.
func fillWord(known, model radicals.Word) radicals.Word {
	if known.Pinyin == "" {
		known.Pinyin, known.Syllables = model.Pinyin, model.Syllables
	} else if len(known.Syllables) == 0 && normalizedPinyin(strings.Join(model.Syllables, "")) == normalizedPinyin(known.Pinyin) {
		known.Syllables = model.Syllables
	}
	if known.Meaning == "" {
		known.Meaning = model.Meaning
	}
	known.ProperNoun = known.ProperNoun || model.ProperNoun
	return known
}

// usableSyllables keeps the syllables of a word only when there is one per character and together they spell
// its pinyin, and otherwise cuts the pinyin itself when it cuts in exactly one way.
func usableSyllables(word radicals.Word) radicals.Word {
	n := utf8.RuneCountInString(word.Hanzi)
	if len(word.Syllables) != n || normalizedPinyin(strings.Join(word.Syllables, "")) != normalizedPinyin(word.Pinyin) {
		word.Syllables = nil
	}
	return withSyllables(word)
}

// normalizedPinyin is pinyin without the separators a writer may put between syllables, lower case.
func normalizedPinyin(pinyin string) string {
	return strings.ToLower(strings.NewReplacer(" ", "", "'", "", "’", "", "-", "").Replace(pinyin))
}

func trimAll(values []string) []string {
	out := make([]string, 0, len(values))
	for _, v := range values {
		out = append(out, strings.TrimSpace(v))
	}
	return out
}

func appendNew(list []string, item string) []string {
	if slices.Contains(list, item) {
		return list
	}
	return append(list, item)
}

func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	slices.Sort(keys)
	return keys
}

// buildRadicalsVocabularyRequest asks the model for the words of the lessons that need it: the teacher's
// incomplete words to fill in, or a whole list from the photos or the lesson as the model knows it.
func buildRadicalsVocabularyRequest(model string, images []Image, opts Options, lessons []radicalsLesson) responsesRequest {
	texts := append([]string{"Return the vocabulary of the lessons below as the JSON object described in your instructions."}, lessonMessages(opts)...)
	for _, lesson := range lessons {
		if !needsModel(lesson) {
			continue
		}
		var msg strings.Builder
		fmt.Fprintf(&msg, "LESSON %d — ", lesson.Number)
		switch {
		case lesson.source != wordsFromModel:
			msg.WriteString("WORDS GIVEN (one per line; fill in what is missing):")
			for _, word := range lesson.Words {
				if hasReading(word) && word.Meaning != "" {
					continue
				}
				msg.WriteString("\n- " + word.Hanzi)
				if word.Pinyin != "" {
					msg.WriteString(" | pinyin: " + word.Pinyin)
				}
				if word.Meaning != "" {
					msg.WriteString(" | meaning: " + word.Meaning)
				}
			}
		case len(images) > 0:
			msg.WriteString("WORDS FROM THE PHOTOS (if the photos do not show this lesson's word list, follow WORDS FROM THE LESSON instead).")
		default:
			msg.WriteString("WORDS FROM THE LESSON (no photo is provided).")
		}
		texts = append(texts, msg.String())
	}
	content := make([]inputPart, 0, len(texts)+len(images))
	for _, text := range texts {
		content = append(content, inputPart{Type: "input_text", Text: text})
	}
	for _, img := range images {
		content = append(content, inputPart{Type: "input_image", ImageURL: dataURL(img)})
	}
	return responsesRequest{
		Model:           model,
		Instructions:    normalizePrompt(radicalsVocabularyPrompt),
		Input:           []responsesInput{{Role: "user", Content: content}},
		MaxOutputTokens: maxOutputTokens,
	}
}

// buildRadicalsDetailsRequest asks the model for what the exercise still lacks once its groups are known.
func buildRadicalsDetailsRequest(model string, needs radicals.Needs) responsesRequest {
	payload, _ := json.Marshal(needs)
	text := "Write the Vietnamese notes for these characters and components, as the JSON object described in your instructions:\n" + string(payload)
	if len(needs.Words) > 0 {
		text += "\nAlso give a short Vietnamese meaning for each of the words under \"words\", in an object \"words\" keyed by the word."
	}
	return responsesRequest{
		Model:           model,
		Instructions:    normalizePrompt(radicalsDetailsPrompt),
		Input:           []responsesInput{{Role: "user", Content: []inputPart{{Type: "input_text", Text: text}}}},
		MaxOutputTokens: maxOutputTokens,
	}
}

var fencedJSON = regexp.MustCompile("(?i)```(?:json)?\\s*([\\s\\S]*?)```")

// decodeJSONAnswer reads the JSON object a model answered with, past a markdown fence or prose around it.
func decodeJSONAnswer(text string, v any) error {
	text = strings.TrimSpace(text)
	if m := fencedJSON.FindStringSubmatch(text); m != nil {
		text = strings.TrimSpace(m[1])
	}
	if start, end := strings.Index(text, "{"), strings.LastIndex(text, "}"); start >= 0 && end > start {
		text = text[start : end+1]
	}
	if err := json.Unmarshal([]byte(text), v); err != nil {
		return errors.Join(errors.New("the model's answer is not the JSON asked for"), err)
	}
	return nil
}
