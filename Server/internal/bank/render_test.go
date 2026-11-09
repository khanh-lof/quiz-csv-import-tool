package bank

import (
	"encoding/csv"
	"slices"
	"strconv"
	"strings"
	"testing"

	"quiz-csv-import-tool/server/internal/csvgen"
	"quiz-csv-import-tool/server/internal/gesturequiz"
	"quiz-csv-import-tool/server/internal/store"
)

func readRows(t *testing.T, text string) [][]string {
	t.Helper()
	rows, err := csv.NewReader(strings.NewReader(text)).ReadAll()
	if err != nil {
		t.Fatalf("not CSV: %v\n%s", err, text)
	}
	return rows
}

func picksOf(qs ...store.Question) []Pick {
	picks := make([]Pick, len(qs))
	for i, q := range qs {
		picks[i] = Pick{Question: q}
	}
	return picks
}

func TestRenderGimKitAndBlooket(t *testing.T) {
	v := testVocabulary(3, 1)
	quoted := mc("q", v, 0, Easy, SkillMeaning)
	quoted.Stem.Text = `Chọn nghĩa của "词1", đúng nhất`
	picks := picksOf(quoted, trueFalse("tf", v, 1), wordOrder("wo", v, 2))

	text, err := Render(request(csvgen.GimKit, v), picks, 1)
	if err != nil {
		t.Fatal(err)
	}
	byAnswer := map[string][]string{}
	for _, row := range readRows(t, text) {
		if len(row) != 5 {
			t.Fatalf("row of %d cells: %q", len(row), row)
		}
		byAnswer[row[1]] = row
	}
	if row := byAnswer["từ 1"]; row[0] != quoted.Stem.Text || row[2] != "sai 1" {
		t.Errorf("multiple choice row %q", row)
	}
	if row := byAnswer["Sai"]; !strings.HasPrefix(row[0], trueFalsePrefix) || row[2] != "Đúng" || row[3] != "" {
		t.Errorf("true/false row %q", row)
	}
	if row := byAnswer["我喜欢词3。"]; !strings.Contains(row[0], " / ") || strings.Contains(row[0], "我 / 喜欢 / 词3。") || row[2] != "喜欢我词3。" {
		t.Errorf("word order row %q", row)
	}

	text, err = Render(request(csvgen.Blooket, v), picks, 2)
	if err != nil {
		t.Fatal(err)
	}
	for i, row := range readRows(t, text) {
		if len(row) != 8 || row[0] != strconv.Itoa(i+1) || row[6] != "20" {
			t.Fatalf("row %q", row)
		}
		answer, _ := strconv.Atoi(row[7])
		if answer < 1 || answer > 4 {
			t.Fatalf("correct answer %q", row[7])
		}
		if picked := row[1+answer]; picked != "từ 1" && picked != "Sai" && picked != "我喜欢词3。" {
			t.Errorf("row %d: the correct answer points at %q", i, picked)
		}
	}
}

func TestRenderWayground(t *testing.T) {
	v := testVocabulary(3, 1)
	visual := mc("v", v, 0, Easy, SkillVisual)
	visual.ImageURL = "https://images.pexels.com/photos/1/pexels-photo-1.jpeg"
	typed := mc("t", v, 1, Medium, SkillFillBlank)
	typed.Format, typed.Distractors = FormatTyped, nil
	text, err := Render(request(csvgen.Wayground, v), picksOf(visual, typed), 3)
	if err != nil {
		t.Fatal(err)
	}
	rows := readRows(t, text)
	for _, row := range rows {
		if len(row) != 11 {
			t.Fatalf("row of %d cells: %q", len(row), row)
		}
		switch row[1] {
		case "Multiple Choice":
			answer, _ := strconv.Atoi(row[7])
			if row[1+answer] != "từ 1" || row[9] != visual.ImageURL || row[10] != "Giải thích." || row[6] != "" {
				t.Errorf("multiple choice row %q", row)
			}
		case "Fill-in-the-Blank":
			if row[2] != "từ 2" || row[3] != "" || row[7] != "" || row[9] != "" {
				t.Errorf("fill-in-the-blank row %q", row)
			}
		default:
			t.Errorf("question type %q", row[1])
		}
	}
}

func TestRenderGameParses(t *testing.T) {
	v := testVocabulary(3, 1)
	fill := mc("fb", v, 1, Medium, SkillFillBlank)
	fill.Answer.Pinyin = "cí2"
	picks := []Pick{
		{Question: wordOrder("wo", v, 2), Stage: 6},
		{Question: trueFalse("tf", v, 0), Stage: 1},
		{Question: fill, Stage: 4},
		{Question: mc("two", v, 0, Easy, SkillMeaning), Stage: 2},
	}
	text, err := Render(gameRequest(v, []int{1, 2, 4, 6}, 1), picks, 4)
	if err != nil {
		t.Fatal(err)
	}
	rows := readRows(t, text)
	var stages []string
	for _, row := range rows {
		stages = append(stages, row[0])
	}
	if !slices.Equal(stages, []string{"1", "2", "4", "6"}) {
		t.Errorf("stages in order %v", stages)
	}
	quiz := gesturequiz.Parse(text)
	if quiz.Skipped != 0 || quiz.Total() != 4 {
		t.Fatalf("the game read %d questions and skipped %d:\n%s", quiz.Total(), quiz.Skipped, text)
	}
	if q := quiz.Stages[1][0]; q.Correct != gesturequiz.FalseAnswer {
		t.Errorf("stage 1: %+v", q)
	}
	if q := quiz.Stages[2][0]; len(q.Wrong) != 1 || q.Wrong[0] != "sai 1" {
		t.Errorf("stage 2 keeps the most plausible wrong answer: %+v", q)
	}
	if q := quiz.Stages[4][0]; len(q.Wrong) != 2 || q.CorrectPinyin != "cí2" || q.Explanation != "Giải thích." {
		t.Errorf("stage 4: %+v", q)
	}
	if q := quiz.Stages[6][0]; !slices.Equal(q.Chunks, []string{"我", "喜欢", "词3。"}) || q.CorrectPinyin != "wǒ / xǐhuan / cí3." {
		t.Errorf("stage 6: %+v", q)
	}
}

func TestSpreadSkills(t *testing.T) {
	v := testVocabulary(4, 1)
	picks := picksOf(mc("a", v, 0, Easy, SkillMeaning), mc("b", v, 1, Easy, SkillMeaning), mc("c", v, 2, Easy, SkillMeaning),
		mc("d", v, 3, Medium, SkillFillBlank))
	spreadSkills(picks)
	for i := 1; i < 3; i++ {
		if picks[i].Question.Skill == picks[i-1].Question.Skill && picks[i].Question.Skill == picks[i+1].Question.Skill {
			t.Errorf("three of a skill in a row: %v", picks)
		}
	}
	if picks[1].Question.Skill != SkillFillBlank {
		t.Errorf("order %s %s %s %s", picks[0].Question.ID, picks[1].Question.ID, picks[2].Question.ID, picks[3].Question.ID)
	}
}
