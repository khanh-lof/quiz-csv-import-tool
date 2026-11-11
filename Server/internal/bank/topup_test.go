package bank

import (
	"fmt"
	"testing"

	"quiz-csv-import-tool/server/internal/store"
)

func TestTopUpSpecsSpreadsOverTheLeastCoveredWords(t *testing.T) {
	v := testVocabulary(4, 1)
	// Word 0 already has an easy and a medium question, word 1 an easy one; a retired one does not count.
	retired := mc("r", v, 2, Easy, SkillMeaning)
	retired.Status = store.QuestionRetired
	pool := []store.Question{mc("a", v, 0, Easy, SkillMeaning), mc("b", v, 0, Medium, SkillFillBlank),
		mc("c", v, 1, Easy, SkillForm), retired}

	specs := TopUpSpecs(v, pool, 10, 0)
	if len(specs) != 10 {
		t.Fatalf("%d specs, want 10", len(specs))
	}
	var levels [3]int
	perWord := map[string]int{}
	for _, s := range specs {
		levels[s.Difficulty-1]++
		perWord[s.Word]++
	}
	if levels != [3]int{4, 4, 2} {
		t.Errorf("levels %v, want [4 4 2]", levels)
	}
	// The easy ones go to words 2 and 3 first, which have none.
	if specs[0].Word != v.Words[2].Key() || specs[1].Word != v.Words[3].Key() {
		t.Errorf("first easy specs on %q and %q", specs[0].Word, specs[1].Word)
	}
	for _, w := range v.Words {
		if perWord[w.Key()] == 0 {
			t.Errorf("no spec on %s", w.Word)
		}
	}
	// The fourth easy one is a true/false statement, the hard ones may be a sentence to order.
	if specs[3].Format != FormatTrueFalse || specs[0].Format != FormatMC || specs[9].Format != "" {
		t.Errorf("formats %q %q %q", specs[0].Format, specs[3].Format, specs[9].Format)
	}

	held := Coverage(v, pool)
	if held[v.Words[0].Key()] != (Counts{1, 1, 0}) || held[v.Words[2].Key()].Total() != 0 {
		t.Errorf("coverage %v", held)
	}
	if got := len(TopUpSpecs(v, nil, 500, 0)); got != MaxTopUp {
		t.Errorf("%d specs for 500, want %d", got, MaxTopUp)
	}
	if TopUpSpecs(v, nil, 0, 0) != nil {
		t.Error("specs for 0")
	}
}

func TestTopUpSpecsVisual(t *testing.T) {
	v := testVocabulary(10, 1)
	// 10 questions: easy 0-3 (3 a true/false statement), medium 4-7, hard 8-9.
	specs := TopUpSpecs(v, nil, 10, 4)
	var visual []int
	for i, s := range specs {
		if s.Visual {
			visual = append(visual, i)
			if s.Format != FormatMC || len(s.Skills) != 1 || s.Skills[0] != SkillVisual || s.Options != 4 {
				t.Errorf("visual spec %d: %+v", i, s)
			}
		}
	}
	if fmt.Sprint(visual) != "[0 1 4 5]" {
		t.Errorf("visual specs %v, want [0 1 4 5]", visual)
	}
	// More than the easy and medium multiple-choice ones: all of those, and nothing else.
	n := 0
	for _, s := range TopUpSpecs(v, nil, 10, 50) {
		if s.Visual {
			n++
		}
	}
	if n != 7 {
		t.Errorf("%d visual specs, want the 7 easy and medium mc ones", n)
	}
}
