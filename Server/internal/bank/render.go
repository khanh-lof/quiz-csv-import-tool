package bank

import (
	"fmt"
	"math/rand/v2"
	"slices"
	"strconv"
	"strings"

	"quiz-csv-import-tool/server/internal/csvgen"
	"quiz-csv-import-tool/server/internal/gesturequiz"
	"quiz-csv-import-tool/server/internal/store"
)

// blooketSeconds is Blooket's time per question, the client's own builder's.
const blooketSeconds = 20

// trueFalsePrefix tells the learner of a platform without a true/false game what to answer.
const trueFalsePrefix = "Đúng hay sai: "

// Render writes the picks in the platform's CSV columns, rows only and every cell quoted, as the model's CSV is
// stored (csvgen.CheckRows): the Game grouped by stage, ascending, the other platforms in an order where the same
// skill does not come twice in a row when that can be helped. seed shuffles the order and the options.
func Render(req Request, picks []Pick, seed uint64) (string, error) {
	rng := rand.New(rand.NewPCG(seed, seed^0x2545f4914f6cdd1d))
	picks = slices.Clone(picks)
	rng.Shuffle(len(picks), func(i, j int) { picks[i], picks[j] = picks[j], picks[i] })
	if req.Platform == csvgen.GestureQuiz {
		slices.SortStableFunc(picks, func(a, b Pick) int { return a.Stage - b.Stage })
	} else {
		spreadSkills(picks)
	}

	var out strings.Builder
	for i, pick := range picks {
		var row []string
		q := &pick.Question
		switch req.Platform {
		case csvgen.GimKit:
			correct, wrong := choices(q)
			row = append([]string{stem(q, rng), correct}, padded(wrong, 3)...)
		case csvgen.Blooket:
			options, answer := shuffled(q, 4, rng)
			row = append([]string{strconv.Itoa(i + 1), stem(q, rng)}, options...)
			row = append(row, strconv.Itoa(blooketSeconds), strconv.Itoa(answer))
		case csvgen.Wayground:
			row = waygroundRow(q, rng)
		case csvgen.GestureQuiz:
			row = gameRow(q, pick.Stage)
		default:
			return "", fmt.Errorf("bank: no rows for export type %d", req.Platform)
		}
		if out.Len() > 0 {
			out.WriteByte('\n')
		}
		writeRow(&out, row)
	}
	return csvgen.CheckRows(out.String(), req.Platform)
}

// stem is the question as a platform with options shows it: a true/false statement says what to answer, and a
// sentence to order shows its chunks mixed up.
func stem(q *store.Question, rng *rand.Rand) string {
	switch q.Format {
	case FormatTrueFalse:
		return trueFalsePrefix + q.Stem.Text
	case FormatWordOrder:
		chunks := make([]string, len(q.Chunks))
		for i, c := range q.Chunks {
			chunks[i] = c.Text
		}
		return q.Stem.Text + " — " + strings.Join(mixed(chunks, rng), " / ")
	}
	return q.Stem.Text
}

// choices are the right answer and the wrong ones of a question shown with options.
func choices(q *store.Question) (string, []string) {
	if q.Format == FormatTrueFalse {
		if q.Answer.Text == gesturequiz.TrueAnswer {
			return gesturequiz.TrueAnswer, []string{gesturequiz.FalseAnswer}
		}
		return gesturequiz.FalseAnswer, []string{gesturequiz.TrueAnswer}
	}
	wrong := make([]string, len(q.Distractors))
	for i, d := range q.Distractors {
		wrong[i] = d.Text
	}
	return q.Answer.Text, wrong
}

// shuffled are the options of a question in random order, n cells with the empty ones last, and the place of the
// right one, from 1. A true/false question keeps Đúng before Sai.
func shuffled(q *store.Question, n int, rng *rand.Rand) ([]string, int) {
	correct, wrong := choices(q)
	options := append([]string{correct}, wrong[:min(len(wrong), n-1)]...)
	if q.Format == FormatTrueFalse {
		options = []string{gesturequiz.TrueAnswer, gesturequiz.FalseAnswer}
	} else {
		rng.Shuffle(len(options), func(i, j int) { options[i], options[j] = options[j], options[i] })
	}
	return padded(options, n), slices.Index(options, correct) + 1
}

func waygroundRow(q *store.Question, rng *rand.Rand) []string {
	if q.Format == FormatTyped {
		// Option 1 is the answer to type; there is no correct option to name.
		return append(append([]string{q.Stem.Text, "Fill-in-the-Blank", q.Answer.Text}, padded(nil, 4)...),
			"", "", q.ImageURL, q.Explanation)
	}
	options, answer := shuffled(q, 5, rng)
	row := append([]string{stem(q, rng), "Multiple Choice"}, options...)
	return append(row, strconv.Itoa(answer), "", q.ImageURL, q.Explanation)
}

// gameRow is a row of the Game's 12 columns for the stage: Stage, the question and its pinyin, the answer and its
// pinyin, three wrong answers with their pinyin, and the explanation.
func gameRow(q *store.Question, stage int) []string {
	row := []string{strconv.Itoa(stage), q.Stem.Text, q.Stem.Pinyin}
	switch q.Format {
	case FormatTrueFalse:
		row = append(row, q.Answer.Text, "")
		row = append(row, padded(nil, 6)...)
	case FormatWordOrder:
		texts, pinyin := make([]string, len(q.Chunks)), make([]string, len(q.Chunks))
		for i, c := range q.Chunks {
			texts[i], pinyin[i] = c.Text, c.Pinyin
		}
		joinedPinyin := strings.Join(pinyin, " / ")
		if slices.Contains(pinyin, "") {
			joinedPinyin = ""
		}
		row = append(row, strings.Join(texts, " / "), joinedPinyin)
		row = append(row, padded(nil, 6)...)
	default:
		row = append(row, q.Answer.Text, q.Answer.Pinyin)
		wrong := stageSpecOf(stage).options - 1
		for i := range 3 {
			if i < wrong && i < len(q.Distractors) {
				row = append(row, q.Distractors[i].Text, q.Distractors[i].Pinyin)
			} else {
				row = append(row, "", "")
			}
		}
	}
	return append(row, q.Explanation)
}

// spreadSkills moves picks so that two of the same skill are not next to each other, where a later pick of
// another skill can take the place.
func spreadSkills(picks []Pick) {
	for i := 1; i < len(picks); i++ {
		if picks[i].Question.Skill != picks[i-1].Question.Skill {
			continue
		}
		for j := i + 1; j < len(picks); j++ {
			if picks[j].Question.Skill != picks[i-1].Question.Skill {
				picks[i], picks[j] = picks[j], picks[i]
				break
			}
		}
	}
}

// mixed is the chunks in an order that is not the right one, as the Game's own shuffle does.
func mixed(chunks []string, rng *rand.Rand) []string {
	out := slices.Clone(chunks)
	rng.Shuffle(len(out), func(i, j int) { out[i], out[j] = out[j], out[i] })
	if slices.Equal(out, chunks) && len(out) > 1 {
		out = append(out[1:], out[0])
	}
	return out
}

func padded(cells []string, n int) []string {
	out := slices.Clone(cells)
	for len(out) < n {
		out = append(out, "")
	}
	return out[:n]
}

func writeRow(out *strings.Builder, cells []string) {
	for i, cell := range cells {
		if i > 0 {
			out.WriteByte(',')
		}
		out.WriteByte('"')
		out.WriteString(strings.ReplaceAll(cell, `"`, `""`))
		out.WriteByte('"')
	}
}
