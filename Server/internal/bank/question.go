// Package bank builds quizzes from the question bank: questions the AI wrote once for a lesson of an embedded
// textbook, stored (store.QuestionBank) and picked again for every teacher who asks for that lesson. A quiz is
// planned from the stored questions alone (Plan) so that it tests every word of the lessons asked for, mixes
// difficulty levels and fits the platform; the model is asked only for what the bank lacks (Service.Fill), in
// JSON, and its questions are stored for the next quiz. The quiz is then written in the platform's CSV columns
// (Render), so everything downstream reads it like a quiz the model wrote.
package bank

import (
	"crypto/sha256"
	"encoding/hex"
	"slices"
	"strings"
	"unicode"
	"unicode/utf8"

	"golang.org/x/text/unicode/norm"

	"quiz-csv-import-tool/server/internal/csvgen"
	"quiz-csv-import-tool/server/internal/gesturequiz"
	"quiz-csv-import-tool/server/internal/store"
)

// The formats of a question: what its parts are, and so which platforms can show it (see accepts).
const (
	// FormatMC is a multiple-choice question: a stem, the answer and 1 to 4 wrong answers.
	FormatMC = "mc"
	// FormatTrueFalse is a statement whose answer is Đúng or Sai.
	FormatTrueFalse = "true_false"
	// FormatWordOrder is a sentence to put in order: its chunks in the right order, and wrong orderings of the
	// whole sentence as the wrong answers, for the platforms that show it as a multiple-choice question.
	FormatWordOrder = "word_order"
	// FormatTyped is a question whose answer the learner types, Wayground's Fill-in-the-Blank.
	FormatTyped = "typed"
)

// Formats are every format, in the order the prompt lists them.
var Formats = []string{FormatMC, FormatTrueFalse, FormatWordOrder, FormatTyped}

// The skills a question practises, which keep a quiz varied and decide which Game stage it fits.
const (
	SkillMeaning        = "meaning"
	SkillForm           = "form"
	SkillFillBlank      = "fill_blank"
	SkillCollocation    = "collocation"
	SkillDialogue       = "dialogue"
	SkillSituation      = "situation"
	SkillDiscrimination = "discrimination"
	SkillGrammar        = "grammar"
	SkillTranslation    = "translation"
	// SkillVisual is a question answered by looking at its image; only Wayground shows images.
	SkillVisual = "visual"
)

// Skills are every skill, in the order the prompt lists them.
var Skills = []string{SkillMeaning, SkillForm, SkillFillBlank, SkillCollocation, SkillDialogue, SkillSituation,
	SkillDiscrimination, SkillGrammar, SkillTranslation, SkillVisual}

// The difficulty levels, as the creative prompt defines them.
const (
	Easy   = 1
	Medium = 2
	Hard   = 3
)

// Platforms are the export types the bank builds quizzes for. Radicals builds its exercise from pools of its own.
var Platforms = []csvgen.ExportType{csvgen.GimKit, csvgen.Blooket, csvgen.Wayground, csvgen.GestureQuiz}

// stageSpec is what a Game stage takes, from gesture_quiz_stages.txt: the format, the options the player picks
// from (0 for the stages without), the difficulty levels and the skills (any when empty).
type stageSpec struct {
	format       string
	options      int
	difficulties []int
	skills       []string
}

var stageSpecs = [gesturequiz.LastStage]stageSpec{
	{format: FormatTrueFalse, difficulties: []int{Easy, Medium, Hard}},
	{format: FormatMC, options: 2, difficulties: []int{Easy}, skills: []string{SkillMeaning, SkillForm}},
	{format: FormatMC, options: 3, difficulties: []int{Easy, Medium}, skills: []string{SkillMeaning, SkillForm, SkillDiscrimination}},
	{format: FormatMC, options: 3, difficulties: []int{Medium}, skills: []string{SkillFillBlank, SkillCollocation}},
	{format: FormatMC, options: 4, difficulties: []int{Medium, Hard},
		skills: []string{SkillDialogue, SkillSituation, SkillDiscrimination, SkillGrammar, SkillTranslation}},
	{format: FormatWordOrder, difficulties: []int{Easy, Medium, Hard}},
}

// stageSpecOf is the spec of a stage, 1 to 6.
func stageSpecOf(stage int) stageSpec { return stageSpecs[stage-1] }

// fitsStage says whether the Game can play q in the stage: its format, options, difficulty and skill, no image,
// short options (the Game shows them in big type on a camera screen), and in the finger stage no option that is a
// bare 1 to 4, since the player picks an option by showing that many fingers.
func fitsStage(q *store.Question, stage int) bool {
	spec := stageSpecOf(stage)
	if q.Format != spec.format || q.Skill == SkillVisual || !slices.Contains(spec.difficulties, q.Difficulty) {
		return false
	}
	if len(spec.skills) > 0 && !slices.Contains(spec.skills, q.Skill) {
		return false
	}
	switch q.Format {
	case FormatTrueFalse:
		return true
	case FormatWordOrder:
		return len(q.Chunks) >= 2 && len(q.Chunks) <= 8
	}
	if len(q.Distractors) < spec.options-1 || !shortOption(q.Answer.Text) {
		return false
	}
	for _, d := range q.Distractors[:spec.options-1] {
		if !shortOption(d.Text) || (spec.options == 4 && isFingerNumber(d.Text)) {
			return false
		}
	}
	return !(spec.options == 4 && isFingerNumber(q.Answer.Text))
}

// shortOption is the Game's option length: at most 8 Chinese characters, and at most 6 other words.
func shortOption(text string) bool {
	han, words := 0, 0
	for _, field := range strings.Fields(text) {
		hasOther := false
		for _, r := range field {
			if unicode.Is(unicode.Han, r) {
				han++
			} else if unicode.IsLetter(r) || unicode.IsDigit(r) {
				hasOther = true
			}
		}
		if hasOther {
			words++
		}
	}
	return han <= 8 && words <= 6
}

func isFingerNumber(text string) bool {
	switch strings.TrimSpace(text) {
	case "1", "2", "3", "4":
		return true
	}
	return false
}

// accepts says whether the platform can show q: GimKit and Blooket take the questions with options and no image,
// Wayground every format and images too. The Game is decided per stage (fitsStage).
func accepts(t csvgen.ExportType, q *store.Question) bool {
	switch t {
	case csvgen.GestureQuiz:
		for stage := gesturequiz.FirstStage; stage <= gesturequiz.LastStage; stage++ {
			if fitsStage(q, stage) {
				return true
			}
		}
		return false
	case csvgen.Wayground:
		return q.Format != FormatWordOrder || len(q.Distractors) > 0
	}
	if q.Skill == SkillVisual || q.Format == FormatTyped {
		return false
	}
	return q.Format != FormatWordOrder || len(q.Distractors) > 0
}

// Fingerprint identifies a question by its content: the format, the stem and the answer, in NFC, with runs of
// white space as one space and English letters in lower case. Two questions with the same fingerprint are the same
// question to the bank.
func Fingerprint(format, stem, answer string) string {
	sum := sha256.Sum256([]byte(format + "\x00" + fold(stem) + "\x00" + fold(answer)))
	return hex.EncodeToString(sum[:16])
}

func fold(text string) string {
	return strings.ToLower(strings.Join(strings.Fields(norm.NFC.String(text)), " "))
}

// hasHan says whether a text has a Chinese character, and so needs its pinyin.
func hasHan(text string) bool {
	for _, r := range text {
		if unicode.Is(unicode.Han, r) {
			return true
		}
	}
	return false
}

// runeCount is the length of a text in characters.
func runeCount(text string) int { return utf8.RuneCountInString(text) }
