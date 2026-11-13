package bank

import (
	"fmt"
	"slices"
	"testing"

	"quiz-csv-import-tool/server/internal/csvgen"
	"quiz-csv-import-tool/server/internal/store"
)

func TestQuizSizeAndLevels(t *testing.T) {
	for words, want := range map[int]int{1: 10, 8: 10, 20: 25, 32: 40, 35: 40, 60: 60} {
		if got := QuizSize(words); got != want {
			t.Errorf("QuizSize(%d) = %d, want %d", words, got, want)
		}
	}
	for n, want := range map[int][3]int{10: {4, 4, 2}, 25: {10, 10, 5}, 3: {1, 1, 1}, 4: {2, 1, 1}} {
		if got := levelQuotas(n); got != want {
			t.Errorf("levelQuotas(%d) = %v, want %v", n, got, want)
		}
	}
}

// fullPool has an easy, a medium and a hard question on every word of v.
func fullPool(v csvgen.Vocabulary) []store.Question {
	var pool []store.Question
	for i := range v.Words {
		pool = append(pool,
			mc(fmt.Sprintf("e%d", i), v, i, Easy, SkillMeaning),
			mc(fmt.Sprintf("m%d", i), v, i, Medium, SkillFillBlank),
			mc(fmt.Sprintf("h%d", i), v, i, Hard, SkillDialogue))
	}
	return pool
}

func levels(picks []Pick) [3]int {
	var n [3]int
	for _, p := range picks {
		n[p.Question.Difficulty-1]++
	}
	return n
}

func covered(picks []Pick) map[string]bool {
	words := map[string]bool{}
	for _, p := range picks {
		for _, t := range p.Question.Targets {
			words[t] = true
		}
	}
	return words
}

func TestPlanFromAFullBank(t *testing.T) {
	v := testVocabulary(8, 2)
	for seed := range uint64(5) {
		plan := PlanQuiz(request(csvgen.GimKit, v), fullPool(v), seed)
		if !plan.Complete() || len(plan.Picks) != 10 || plan.Size != 10 || len(plan.Uncovered) != 0 {
			t.Fatalf("seed %d: %d picks, %d gaps, uncovered %v", seed, len(plan.Picks), len(plan.Gaps), plan.Uncovered)
		}
		if got := levels(plan.Picks); got != [3]int{4, 4, 2} {
			t.Errorf("seed %d: levels %v, want 4/4/2", seed, got)
		}
		if words := covered(plan.Picks); len(words) != 8 {
			t.Errorf("seed %d: %d words covered, want 8", seed, len(words))
		}
		if ids := plan.IDs(); len(slices.Compact(slices.Sorted(slices.Values(ids)))) != 10 {
			t.Errorf("seed %d: a question picked twice: %v", seed, ids)
		}
	}
}

func TestPlanCoversEveryWordBeyondTheLevelQuotas(t *testing.T) {
	// Only easy questions, but on every word: covering comes first, so the easy part grows past its 4 places, and
	// the other levels give the places back, down to one each, so the quiz keeps its size.
	v := testVocabulary(8, 1)
	var pool []store.Question
	for i := range v.Words {
		pool = append(pool, mc(fmt.Sprintf("e%d", i), v, i, Easy, SkillMeaning))
	}
	plan := PlanQuiz(request(csvgen.Blooket, v), pool, 1)
	if len(covered(plan.Picks)) != 8 || len(plan.Uncovered) != 0 {
		t.Fatalf("covered %d words, uncovered %v", len(covered(plan.Picks)), plan.Uncovered)
	}
	// The medium and hard places left have nothing to take them: they are gaps at their level.
	var gapLevels [3]int
	for _, g := range plan.Gaps {
		gapLevels[g.Difficulty-1]++
		if g.Word == "" || g.Format == FormatTrueFalse {
			t.Errorf("gap %+v", g)
		}
	}
	if gapLevels != [3]int{0, 1, 1} || plan.Size != 10 {
		t.Errorf("gap levels %v, size %d", gapLevels, plan.Size)
	}
}

func TestPlanListsTheGaps(t *testing.T) {
	v := testVocabulary(8, 2)
	// Questions on the first five words only.
	pool := fullPool(v)[:15]
	plan := PlanQuiz(request(csvgen.GimKit, v), pool, 3)
	want := []string{v.Words[5].Key(), v.Words[6].Key(), v.Words[7].Key()}
	if !slices.Equal(plan.Uncovered, want) {
		t.Fatalf("uncovered %v, want %v", plan.Uncovered, want)
	}
	for _, word := range want {
		if !slices.ContainsFunc(plan.Gaps, func(g csvgen.QuestionSpec) bool { return g.Word == word }) {
			t.Errorf("no gap for %s: %+v", word, plan.Gaps)
		}
	}
	if plan.Complete() || plan.Size != 10 || len(plan.Picks)+len(plan.Gaps) != 10 {
		t.Errorf("%d picks, %d gaps, size %d", len(plan.Picks), len(plan.Gaps), plan.Size)
	}
	if !plan.Playable() {
		t.Error("seven of ten questions is not playable")
	}
}

func TestPlanLeavesOutQuestionsItMayNotUse(t *testing.T) {
	v := testVocabulary(4, 1)
	var pool []store.Question
	add := func(change func(*store.Question)) {
		q := mc(fmt.Sprintf("q%d", len(pool)), v, len(pool)%4, Easy, SkillMeaning)
		change(&q)
		pool = append(pool, q)
	}
	add(func(q *store.Question) { q.MaxLesson = 2 })  // written for a later lesson
	add(func(q *store.Question) { q.Book = "other" }) // another book
	add(func(q *store.Question) { q.Language = 1 })   // another language
	add(func(q *store.Question) { q.Status = store.QuestionRetired })
	add(func(q *store.Question) { q.Targets = []string{"其他|qítā|pron."} }) // no word of the lessons
	add(func(q *store.Question) { q.Skill = SkillVisual })                 // an image GimKit cannot show
	add(func(*store.Question) {})                                          // fine
	if plan := PlanQuiz(request(csvgen.GimKit, v), pool, 1); !slices.Equal(plan.IDs(), []string{"q6"}) {
		t.Errorf("picked %v, want only q6", plan.IDs())
	}
}

func TestPlanGame(t *testing.T) {
	v := testVocabulary(6, 1)
	var pool []store.Question
	for i := range v.Words {
		pool = append(pool,
			trueFalse(fmt.Sprintf("tf%d", i), v, i),
			mc(fmt.Sprintf("fb%d", i), v, i, Medium, SkillFillBlank),
			wordOrder(fmt.Sprintf("wo%d", i), v, i))
	}
	req := gameRequest(v, []int{1, 4, 6}, 4)
	plan := PlanQuiz(req, pool, 7)
	if !plan.Complete() || plan.Size != 12 {
		t.Fatalf("%d picks, %d gaps", len(plan.Picks), len(plan.Gaps))
	}
	perStage := map[int]int{}
	for _, p := range plan.Picks {
		perStage[p.Stage]++
		if !fitsStage(&p.Question, p.Stage) {
			t.Errorf("%s does not fit stage %d", p.Question.ID, p.Stage)
		}
	}
	if perStage[1] != 4 || perStage[4] != 4 || perStage[6] != 4 {
		t.Errorf("per stage %v", perStage)
	}
	if len(covered(plan.Picks)) != 6 {
		t.Errorf("covered %d of 6 words", len(covered(plan.Picks)))
	}

	// Without word-order questions stage 6 is all gaps, each a sentence to order, and with no question at all
	// in a stage the plan is not playable.
	plan = PlanQuiz(req, slices.DeleteFunc(slices.Clone(pool), func(q store.Question) bool { return q.Format == FormatWordOrder }), 7)
	for _, g := range plan.Gaps {
		if g.Format != FormatWordOrder || g.Difficulty != Hard {
			t.Errorf("stage 6 gap %+v", g)
		}
	}
	if len(plan.Gaps) != 4 || plan.Playable() {
		t.Errorf("%d gaps, playable %v", len(plan.Gaps), plan.Playable())
	}
}

func TestPlanGameStageFit(t *testing.T) {
	v := testVocabulary(1, 1)
	long := mc("long", v, 0, Easy, SkillMeaning)
	long.Answer.Text = "một câu trả lời rất dài hơn sáu chữ"
	finger := mc("finger", v, 0, Hard, SkillDialogue)
	finger.Distractors[0].Text = "2"
	for _, tt := range []struct {
		q     store.Question
		stage int
		want  bool
	}{
		{mc("ok", v, 0, Easy, SkillMeaning), 2, true},
		{mc("ok", v, 0, Easy, SkillMeaning), 4, false}, // a usage stage
		{mc("ok", v, 0, Medium, SkillFillBlank), 4, true},
		{long, 2, false},
		{finger, 5, false},
		{mc("ok", v, 0, Hard, SkillDialogue), 5, true},
		{trueFalse("tf", v, 0), 1, true},
		{wordOrder("wo", v, 0), 6, true},
		{wordOrder("wo", v, 0), 5, false},
	} {
		if got := fitsStage(&tt.q, tt.stage); got != tt.want {
			t.Errorf("%s in stage %d: %v, want %v", tt.q.ID, tt.stage, got, tt.want)
		}
	}
}

func TestPlanWaygroundWantsAFifthVisual(t *testing.T) {
	v := testVocabulary(8, 1)
	plan := PlanQuiz(request(csvgen.Wayground, v), fullPool(v), 2)
	visual := 0
	for _, g := range plan.Gaps {
		if g.Visual {
			visual++
			if !slices.Equal(g.Skills, []string{SkillVisual}) {
				t.Errorf("visual gap %+v", g)
			}
		}
	}
	// 4/4/2 questions, at least a fifth of each level visual, rounded up: 1+1+1. Covering the eight words takes
	// eight picks, so the quiz is those plus the three visual gaps.
	if visual != 3 || len(plan.Picks) != 8 || plan.Size != 11 {
		t.Fatalf("%d visual gaps, %d picks, size %d", visual, len(plan.Picks), plan.Size)
	}

	// With visual questions in the bank, it is complete.
	pool := fullPool(v)
	for i := range v.Words {
		for level := Easy; level <= Hard; level++ {
			q := mc(fmt.Sprintf("v%d-%d", i, level), v, i, level, SkillVisual)
			q.ImageURL = "https://images.pexels.com/photos/1/pexels-photo-1.jpeg"
			pool = append(pool, q)
		}
	}
	plan = PlanQuiz(request(csvgen.Wayground, v), pool, 2)
	visual = 0
	for _, p := range plan.Picks {
		if p.Question.Skill == SkillVisual {
			visual++
		}
	}
	if !plan.Complete() || visual < 3 {
		t.Errorf("complete %v with %d visual questions", plan.Complete(), visual)
	}
}

func TestPlanPrefersTheLeastServed(t *testing.T) {
	v := testVocabulary(8, 1)
	pool := fullPool(v)
	for i := range v.Words {
		// A second set, picked by many quizzes already.
		for _, q := range []store.Question{mc(fmt.Sprintf("se%d", i), v, i, Easy, SkillMeaning), mc(fmt.Sprintf("sm%d", i), v, i, Medium, SkillFillBlank)} {
			q.ServedCount = 100
			pool = append(pool, q)
		}
	}
	served := 0
	for seed := range uint64(10) {
		for _, p := range PlanQuiz(request(csvgen.GimKit, v), pool, seed).Picks {
			if p.Question.ServedCount > 0 {
				served++
			}
		}
	}
	if served > 5 {
		t.Errorf("%d of 100 picks were questions served 100 times, with fresh ones to spare", served)
	}
}

func TestPlanDependsOnTheSeed(t *testing.T) {
	v := testVocabulary(8, 1)
	pool := append(fullPool(v), fullPool(v)...)
	for i := len(pool) / 2; i < len(pool); i++ {
		pool[i].ID, pool[i].Fingerprint = pool[i].ID+"b", pool[i].ID+"b"
	}
	first := PlanQuiz(request(csvgen.GimKit, v), pool, 1).IDs()
	if again := PlanQuiz(request(csvgen.GimKit, v), pool, 1).IDs(); !slices.Equal(first, again) {
		t.Error("the same seed made another quiz")
	}
	differs := false
	for seed := uint64(2); seed < 6 && !differs; seed++ {
		differs = !slices.Equal(first, PlanQuiz(request(csvgen.GimKit, v), pool, seed).IDs())
	}
	if !differs {
		t.Error("every seed made the same quiz")
	}
}
