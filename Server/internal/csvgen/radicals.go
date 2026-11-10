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
	// wordsFromBook: the lesson document of an embedded textbook has all of them; the model only fills in a
	// reading the document lacks.
	wordsFromBook wordSource = iota
	// wordsFromModel: the model lists them, from the photos or from its knowledge of the lesson.
	wordsFromModel
)

// radicalsLesson is a lesson of the exercise and its words, in the lesson's order.
type radicalsLesson struct {
	Number  int            `json:"number"`
	TitleZh string         `json:"titleZh"`
	TitleVi string         `json:"titleVi"`
	Words   []radicalsWord `json:"words"`
	// source is where the words come from, which decides what the vocabulary request asks for.
	source wordSource
}

// radicalsWord is a word of the exercise with where its notes come from, which is what the review lists and what
// the teacher may correct. A word without a reading is kept, but left out of the exercise.
type radicalsWord struct {
	radicals.Word
	AIPinyin  bool `json:"aiPinyin,omitempty"`  // the model wrote the pinyin
	AIMeaning bool `json:"aiMeaning,omitempty"` // the model wrote the meaning
	Uncertain bool `json:"uncertain,omitempty"` // the model was not sure of it
	Edited    bool `json:"edited,omitempty"`    // the teacher changed the pinyin or the meaning
}

func (w radicalsWord) fromModel() bool { return w.AIPinyin || w.AIMeaning }

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
// Radicals job stores in place of a CSV, with the source it was built from (radicalsSource), from which
// ReviseRadicals builds it again with the teacher's corrections. It asks the model at most twice: once for the
// words that the textbook does not give in full, once for the meanings of characters and the names of components
// that the curated pools lack. The rest is package radicals' work.
func (c *Client) generateRadicals(ctx context.Context, images []Image, opts Options, usage *Usage) (Result, error) {
	model := usage.Model
	lessons := gatherRadicalsLessons(opts)
	if slices.ContainsFunc(lessons, needsModel) {
		text, err := c.respond(ctx, buildRadicalsVocabularyRequest(model, images, opts, lessons), usage)
		if err != nil {
			return Result{}, err
		}
		var answer vocabularyAnswer
		if err := decodeJSONAnswer(text, &answer); err != nil {
			return Result{}, err
		}
		lessons = mergeVocabulary(lessons, answer)
	}

	src := &radicalsSource{
		Version: radicalsSourceVersion, Lessons: lessons,
		Chars: map[string]string{}, Components: map[string]radicals.ComponentInfo{}, AIChars: []string{}, AIComponents: []string{},
		Level: radicalsLevel(opts), CourseName: radicalsCourseName(opts),
	}
	draft, err := src.plan()
	if err != nil {
		return Result{}, err
	}
	if needs := draft.Needs(); needCount(needs) > 0 {
		// Notes written for an earlier exercise are the model's too: addDetails marks them so, and the review
		// shows them to the teacher like the ones written now.
		stored, left := c.cachedDetails(ctx, needs)
		src.addDetails(stored, needs)
		if needCount(left) > 0 {
			text, err := c.respond(ctx, buildRadicalsDetailsRequest(model, left), usage)
			if err != nil {
				return Result{}, err
			}
			var answer detailsAnswer
			if err := decodeJSONAnswer(text, &answer); err != nil {
				return Result{}, err
			}
			src.addDetails(answer, left)
			c.saveDetails(ctx, answer, left, model)
		}
	}
	return src.build(draft)
}

// needsModel says whether the first request must cover the lesson: its words are the model's to list, or one
// of them has no reading yet.
func needsModel(lesson radicalsLesson) bool {
	return lesson.source == wordsFromModel || slices.ContainsFunc(lesson.Words, func(w radicalsWord) bool { return !hasReading(w.Word) })
}

// gatherRadicalsLessons sets out the lessons of the request with what is known of their words before asking
// the model: the textbook's own list when the course is one of the embedded books.
func gatherRadicalsLessons(opts Options) []radicalsLesson {
	book := textbookFor(opts)
	lessons := make([]radicalsLesson, 0, len(opts.LessonNumbers))
	for _, number := range opts.LessonNumbers {
		lesson := radicalsLesson{Number: number, source: wordsFromModel}
		if book != nil && number <= book.lessons {
			lesson.TitleZh, lesson.TitleVi = lessonTitles(book.docs[number-1])
			lesson.source = wordsFromBook
			for _, word := range lessonVocabulary(book.docs[number-1]) {
				lesson.Words = append(lesson.Words, radicalsWord{Word: word})
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
		if (section != newWordsHeading && section != properNounsHeading) || !strings.HasPrefix(line, "|") ||
			strings.HasPrefix(line, "|---") || strings.HasPrefix(line, "| Word ") {
			continue
		}
		cells := splitTableRow(line)
		proper := section == properNounsHeading
		if (!proper && len(cells) != newWordsColumns) || (proper && len(cells) != properNounsColumns) {
			continue
		}
		hanzi, pinyin := expandOptional(cells[0]), expandOptional(cells[1])
		// The Vietnamese meaning is the last column but one of New words and the last of Proper nouns.
		meaning, star := cells[4-boolInt(proper)], !proper && strings.Contains(cells[newWordsNoteColumn], "★")
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
	Words      map[string]string                 `json:"words"`
	Chars      map[string]string                 `json:"chars"`
	Components map[string]radicals.ComponentInfo `json:"components"`
}

// mergeVocabulary completes the lessons with the model's answer. What the textbook gave is kept,
// and a lesson whose words are the model's takes them as they come, minus anything that is not a word. A word
// still without a reading, one pinyin syllable per character, stays in its lesson, to be left out of the exercise
// and named for the teacher.
func mergeVocabulary(lessons []radicalsLesson, answer vocabularyAnswer) []radicalsLesson {
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
		var candidates []radicalsWord
		if lesson.source == wordsFromModel {
			for _, w := range answered.Words {
				word := w.word()
				if radicals.IsHanzi(word.Hanzi) {
					candidates = append(candidates, radicalsWord{Word: word, AIPinyin: true, AIMeaning: word.Meaning != "", Uncertain: w.Uncertain})
				}
			}
		} else {
			for _, known := range lesson.Words {
				filled := known
				if !hasReading(known.Word) || known.Meaning == "" {
					if m := slices.IndexFunc(answered.Words, func(w vocabularyWord) bool { return strings.TrimSpace(w.Hanzi) == known.Hanzi }); m >= 0 {
						filled.Word = fillWord(known.Word, answered.Words[m].word())
						filled.AIPinyin, filled.AIMeaning = filled.Pinyin != known.Pinyin, filled.Meaning != known.Meaning
						filled.Uncertain = filled.fromModel() && answered.Words[m].Uncertain
					}
				}
				candidates = append(candidates, filled)
			}
		}
		var kept []radicalsWord
		for _, word := range candidates {
			word.Word = usableSyllables(word.Word)
			if !slices.ContainsFunc(kept, func(w radicalsWord) bool { return w.Hanzi == word.Hanzi }) {
				kept = append(kept, word)
			}
		}
		lesson.Words = kept
	}
	return lessons
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

// buildRadicalsVocabularyRequest asks the model for the words of the lessons that need it: the textbook's
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
				if hasReading(word.Word) && word.Meaning != "" {
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
	content := inputParts(texts, images)
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
		return &badOutputError{errors.Join(errors.New("the model's answer is not the JSON asked for"), err)}
	}
	return nil
}
