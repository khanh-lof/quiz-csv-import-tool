package bank

import (
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

	specs := TopUpSpecs(v, pool, 10)
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
	if got := len(TopUpSpecs(v, nil, 500)); got != MaxTopUp {
		t.Errorf("%d specs for 500, want %d", got, MaxTopUp)
	}
	if TopUpSpecs(v, nil, 0) != nil {
		t.Error("specs for 0")
	}
}
