package bank

import (
	"slices"

	"quiz-csv-import-tool/server/internal/csvgen"
	"quiz-csv-import-tool/server/internal/store"
)

// MaxTopUp is the most questions TopUpSpecs plans in one go, as many as one model call is asked for.
const MaxTopUp = maxPlanSpecs

// trueFalseEvery makes one easy question in that many a true/false statement, which only the Game's first stage
// plays, so the bank holds some for it.
const trueFalseEvery = 4

// TopUpSpecs plans n questions to add to the bank for the words of a vocabulary outside any quiz (at most
// MaxTopUp): easy, medium and hard in the shares of a quiz, each given to the word the bank, with the questions
// planned so far, holds the fewest questions on at that level, then the fewest in all, the first in the book on a
// tie. They are shaped like a quiz's gaps on the platforms other than the Game, except that one easy question in
// trueFalseEvery is a true/false statement for the Game, whose last stage the hard ones (mc or word_order) serve.
// pool is the bank's questions for the vocabulary's book and language (store.QuestionBank.Pool); the ones testing
// other words do not count.
func TopUpSpecs(vocabulary csvgen.Vocabulary, pool []store.Question, n int) []csvgen.QuestionSpec {
	n = min(n, MaxTopUp)
	if n <= 0 || len(vocabulary.Words) == 0 {
		return nil
	}
	held := Coverage(vocabulary, pool)
	quotas := levelQuotas(n)
	var specs []csvgen.QuestionSpec
	easy := 0
	for level := Easy; level <= Hard; level++ {
		for range quotas[level-1] {
			word := ""
			for _, w := range vocabulary.Words {
				if word == "" || fewer(held[w.Key()], held[word], level) {
					word = w.Key()
				}
			}
			c := held[word]
			c[level-1]++
			held[word] = c

			spec := csvgen.QuestionSpec{Word: word, Format: FormatMC, Skills: skillsFor[level], Difficulty: level, Options: 4}
			switch level {
			case Easy:
				if easy%trueFalseEvery == trueFalseEvery-1 {
					spec = csvgen.QuestionSpec{Word: word, Format: FormatTrueFalse, Difficulty: level}
				}
				easy++
			case Hard:
				// A hard question may also be a sentence to put in order.
				spec.Format = ""
			}
			specs = append(specs, spec)
		}
	}
	return specs
}

// Counts are how many questions test a word at each level, easy first.
type Counts [3]int

// Total is the questions at every level.
func (c Counts) Total() int { return c[0] + c[1] + c[2] }

// Coverage counts, for every word of the vocabulary, the active questions of pool that test it, per level.
func Coverage(vocabulary csvgen.Vocabulary, pool []store.Question) map[string]Counts {
	held := make(map[string]Counts, len(vocabulary.Words))
	for _, w := range vocabulary.Words {
		held[w.Key()] = Counts{}
	}
	for _, q := range pool {
		if q.Status != store.QuestionActive || q.Difficulty < Easy || q.Difficulty > Hard {
			continue
		}
		for _, key := range slices.Compact(slices.Sorted(slices.Values(q.Targets))) {
			if c, ok := held[key]; ok {
				c[q.Difficulty-1]++
				held[key] = c
			}
		}
	}
	return held
}

// fewer says whether a word with counts a should get a question of the level before one with counts b.
func fewer(a, b Counts, level int) bool {
	if a[level-1] != b[level-1] {
		return a[level-1] < b[level-1]
	}
	return a.Total() < b.Total()
}
