package gesturequiz

import (
	"math/rand/v2"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"unicode"

	"golang.org/x/text/unicode/norm"
)

// The two answers of the true/false stage, whatever the AI wrote.
const (
	TrueAnswer  = "Đúng"
	FalseAnswer = "Sai"
)

const (
	minChunks = 2
	maxChunks = 8
)

// Question is one playable question, already checked against its stage's rules. For stage 1 Correct is
// exactly TrueAnswer or FalseAnswer and Wrong is empty. For stage 6 Chunks are the sentence's pieces in
// the right order, Correct is the same pieces joined by " / " and Wrong is empty.
type Question struct {
	Stage       int
	Question    string
	Correct     string
	Wrong       []string
	Chunks      []string
	Explanation string
}

// Quiz holds the stages that have questions, each list in CSV order. Skipped counts the rows that broke a
// rule and were left out, which is how a drifting prompt shows up: as missing questions, not as an error.
type Quiz struct {
	Stages  map[int][]Question
	Skipped int
}

// Count is how many questions the stage has.
func (q *Quiz) Count(stage int) int { return len(q.Stages[stage]) }

// Total is how many questions the quiz has in all.
func (q *Quiz) Total() int {
	total := 0
	for _, questions := range q.Stages {
		total += len(questions)
	}
	return total
}

// StageCounts is the number of questions of each stage that has any, keyed by the stage number as a
// string ("1" to "6"), the shape an assignment stores them in.
func (q *Quiz) StageCounts() map[string]int {
	counts := make(map[string]int, len(q.Stages))
	for stage, questions := range q.Stages {
		if len(questions) > 0 {
			counts[strconv.Itoa(stage)] = len(questions)
		}
	}
	return counts
}

// Parse reads the text the AI wrote (or the file downloaded from it) the way the client's player does:
// it extracts the CSV from a fence or from leading prose, splits it into rows and builds the quiz.
func Parse(raw string) *Quiz {
	return FromRows(SplitRows(ExtractCSV(raw)))
}

// stageDigits is how a stage is read from the first cell: its first run of digits, so "Stage 2" and " 4 "
// both work.
var stageDigits = regexp.MustCompile(`[0-9]+`)

// FromRows is the client's parseGestureQuiz: blank rows and a header row (first cell "stage" in any case)
// are ignored, a row that breaks its stage's rules is dropped and counted in Skipped, and the questions of
// a stage keep their CSV order.
func FromRows(rows [][]string) *Quiz {
	quiz := &Quiz{Stages: map[int][]Question{}}
	for _, row := range rows {
		if slices.IndexFunc(row, func(cell string) bool { return jsTrim(cell) != "" }) < 0 {
			continue
		}
		if len(row) > 0 && strings.ToLower(jsTrim(row[0])) == "stage" {
			continue
		}
		question, ok := parseRow(row)
		if !ok {
			quiz.Skipped++
			continue
		}
		quiz.Stages[question.Stage] = append(quiz.Stages[question.Stage], question)
	}
	return quiz
}

// parseRow turns one row into a question, or reports false when it breaks its stage's rules.
func parseRow(row []string) (Question, bool) {
	cell := func(index int) string {
		if index >= len(row) {
			return ""
		}
		return jsTrim(row[index])
	}

	digits := stageDigits.FindString(cell(0))
	if digits == "" {
		return Question{}, false
	}
	// Digits too many to fit an int are not a stage either.
	stage, err := strconv.Atoi(digits)
	if err != nil {
		return Question{}, false
	}
	def, ok := StageByNumber(stage)
	if !ok {
		return Question{}, false
	}

	question, correct, explanation := cell(1), cell(2), cell(6)
	if question == "" || correct == "" {
		return Question{}, false
	}

	if stage == TrueFalseStage {
		folded := foldAnswer(correct)
		switch {
		case trueWords[folded]:
			return Question{Stage: stage, Question: question, Correct: TrueAnswer, Explanation: explanation}, true
		case falseWords[folded]:
			return Question{Stage: stage, Question: question, Correct: FalseAnswer, Explanation: explanation}, true
		}
		return Question{}, false
	}

	if stage == WordOrderStage {
		var chunks []string
		for _, piece := range strings.Split(correct, "/") {
			if chunk := jsTrim(piece); chunk != "" {
				chunks = append(chunks, chunk)
			}
		}
		if len(chunks) < minChunks || len(chunks) > maxChunks {
			return Question{}, false
		}
		return Question{
			Stage: stage, Question: question, Correct: strings.Join(chunks, " / "), Chunks: chunks, Explanation: explanation,
		}, true
	}

	wrongNeeded := def.OptionCount - 1
	var wrong []string
	for index := 3; index <= 5; index++ {
		if answer := cell(index); answer != "" && answer != correct && !slices.Contains(wrong, answer) {
			wrong = append(wrong, answer)
		}
	}
	if len(wrong) < wrongNeeded {
		return Question{}, false
	}
	return Question{
		Stage: stage, Question: question, Correct: correct, Wrong: wrong[:wrongNeeded], Explanation: explanation,
	}, true
}

// What a true/false answer may be written as, after foldAnswer: the AI does not always keep to
// "Đúng"/"Sai", so the English and Chinese words (and the first letters) are taken too.
var (
	trueWords  = wordSet("dung", "d", "true", "t", "yes", "dui", "对", "對", "正确", "正確", "✓", "✔")
	falseWords = wordSet("sai", "s", "false", "f", "no", "cuo", "错", "錯", "错误", "錯誤", "✗", "✘")
)

func wordSet(words ...string) map[string]bool {
	set := make(map[string]bool, len(words))
	for _, word := range words {
		set[word] = true
	}
	return set
}

// foldAnswer is lower case with accents dropped and trailing punctuation cut, so "Đúng.", "DUNG" and
// "đúng" all match: NFKD, then every combining mark removed, đ read as d, lower case, and trailing white
// space and . ! 。 ！ cut. It is the client's foldAnswer.
func foldAnswer(text string) string {
	var folded strings.Builder
	for _, r := range norm.NFKD.String(text) {
		switch {
		case unicode.Is(unicode.M, r):
		case r == 'đ' || r == 'Đ':
			folded.WriteByte('d')
		default:
			folded.WriteRune(r)
		}
	}
	lower := strings.ToLower(folded.String())
	lower = strings.TrimRightFunc(lower, func(r rune) bool {
		return isJSSpace(r) || r == '.' || r == '!' || r == '。' || r == '！'
	})
	return jsTrim(lower)
}

// ShuffleChunks mixes the pieces of a sentence to an order that is not the answer, as the client's
// shuffleChunks does: when the shuffle comes out equal to the answer, and the pieces are not all the same
// (then every order is the answer), it moves every piece one place along, which always differs. It does not
// change the slice it is given.
func ShuffleChunks(chunks []string) []string {
	mixed := slices.Clone(chunks)
	rand.Shuffle(len(mixed), func(i, j int) { mixed[i], mixed[j] = mixed[j], mixed[i] })
	sameAsAnswer := slices.Equal(mixed, chunks)
	allSame := true
	for _, chunk := range chunks {
		if chunk != chunks[0] {
			allSame = false
			break
		}
	}
	if sameAsAnswer && !allSame && len(mixed) > 1 {
		return append(mixed[1:], mixed[0])
	}
	return mixed
}
