package bank

import (
	"math"
	"math/rand/v2"
	"slices"

	"quiz-csv-import-tool/server/internal/csvgen"
	"quiz-csv-import-tool/server/internal/store"
)

// Request is what a quiz is planned for: the platform, the words to test, and for the Game its stages and how many
// questions each gets.
type Request struct {
	Platform   csvgen.ExportType
	Language   csvgen.Language
	Vocabulary csvgen.Vocabulary
	Stages     []int
	PerStage   int
}

// NewRequest is the Request of a creative job's options, false when the bank does not build that quiz: another
// platform, or a course without an embedded textbook.
func NewRequest(opts csvgen.Options) (Request, bool) {
	if !slices.Contains(Platforms, opts.ExportType) {
		return Request{}, false
	}
	vocabulary, ok := csvgen.LessonVocabulary(opts)
	if !ok {
		return Request{}, false
	}
	req := Request{Platform: opts.ExportType, Language: opts.Language, Vocabulary: vocabulary}
	if opts.ExportType == csvgen.GestureQuiz {
		req.Stages, req.PerStage = opts.GestureQuizStages(), opts.GestureQuizQuestions()
	}
	return req, true
}

// The size of a quiz on the platforms other than the Game, whose size the teacher chooses: a quarter more
// questions than words, at least minQuizSize and at most maxQuizSize, unless the lessons have more words than
// that, then one question per word.
const (
	minQuizSize  = 10
	maxQuizSize  = 40
	sizePerWord  = 1.25
	easyShare    = 0.4
	mediumShare  = 0.4
	visualShare  = 0.2
	maxPlanSpecs = 80
)

// QuizSize is how many questions a quiz of that many words has, the Game aside.
func QuizSize(words int) int {
	n := int(math.Ceil(float64(words) * sizePerWord))
	return max(minQuizSize, min(n, max(maxQuizSize, words)))
}

// levelQuotas splits a quiz of n questions into easy, medium and hard ones: 40%, 40% and the rest, with at least
// one of each when there are three questions or more.
func levelQuotas(n int) [3]int {
	easy, medium := int(math.Round(float64(n)*easyShare)), int(math.Round(float64(n)*mediumShare))
	hard := n - easy - medium
	if n >= 3 && hard < 1 {
		hard = 1
		if medium >= easy {
			medium--
		} else {
			easy--
		}
	}
	return [3]int{easy, medium, hard}
}

// gapDifficulty is the level a gap of each Game stage is written at.
var gapDifficulty = [...]int{Easy, Easy, Medium, Medium, Hard, Hard}

// skillsFor are the skills asked for a gap of a level on the platforms other than the Game.
var skillsFor = [...][]string{
	Easy:   {SkillMeaning, SkillForm},
	Medium: {SkillFillBlank, SkillCollocation, SkillDiscrimination, SkillGrammar},
	Hard:   {SkillDialogue, SkillSituation, SkillTranslation, SkillDiscrimination},
}

// Pick is a question chosen for a quiz, with the Game stage it is played in (zero on the other platforms).
type Pick struct {
	Question store.Question
	Stage    int
}

// Plan is a quiz as far as the bank can build it: the questions it picked, the questions still to write (each
// testing one word, at a level and in a shape that fits where it goes), and the words no picked question tests.
type Plan struct {
	Picks     []Pick
	Gaps      []csvgen.QuestionSpec
	Uncovered []string
	// Size is the number of questions the quiz is meant to have: the picks and the gaps.
	Size int
	// stages are the Game stages asked for.
	stages []int
}

// Complete says whether the bank holds the whole quiz.
func (p Plan) Complete() bool { return len(p.Gaps) == 0 }

// Playable says whether the picks make a quiz worth giving although gaps are left: every Game stage has a question,
// and on the other platforms at least half the questions are there.
func (p Plan) Playable() bool {
	if len(p.stages) > 0 {
		for _, stage := range p.stages {
			if !slices.ContainsFunc(p.Picks, func(pick Pick) bool { return pick.Stage == stage }) {
				return false
			}
		}
		return true
	}
	return len(p.Picks) > 0 && 2*len(p.Picks) >= p.Size
}

// IDs are the ids of the picked questions.
func (p Plan) IDs() []string {
	ids := make([]string, len(p.Picks))
	for i, pick := range p.Picks {
		ids[i] = pick.Question.ID
	}
	return ids
}

// bucket is a part of the quiz to fill: a Game stage, or on the other platforms a difficulty level (on
// Wayground, its visual or its text questions). capacity is how many questions it takes; an elastic bucket takes
// more when that is what covers a word.
type bucket struct {
	stage      int
	difficulty int
	visual     bool
	capacity   int
	elastic    bool
	picked     []int
	gaps       int
	// candidates is how many questions of the pool it could take: the fewer, the sooner it is filled.
	candidates int
}

func (b *bucket) room() int { return b.capacity - len(b.picked) - b.gaps }

type planner struct {
	req     Request
	pool    []store.Question
	buckets []*bucket
	rng     *rand.Rand

	inV        map[string]bool
	covered    map[string]int
	planned    map[string]int
	used       map[int]bool
	skillCount map[string]int
	lastSkill  string
	picks      int
	candidates []int
	// sources is how many candidates test each word: a word few questions test is covered first, while they
	// still have a place.
	sources map[string]int
}

// PlanQuiz picks the questions of a quiz from the pool, the bank's questions for the book (see store.QuestionBank's
// Pool), and lists what is left to write. It first picks, while it can, the question that tests the most words no
// pick tests yet; then it fills what is left of each part of the quiz, preferring the words tested the least; then
// every word still untested, and every place still empty, becomes a gap. Among equals it prefers a skill the quiz
// has less of and a question picked by fewer quizzes before, with a little randomness from seed, so that the same
// request does not always get the same quiz.
func PlanQuiz(req Request, pool []store.Question, seed uint64) Plan {
	p := &planner{
		req: req, pool: pool, rng: rand.New(rand.NewPCG(seed, seed^0x9e3779b97f4a7c15)),
		inV: map[string]bool{}, covered: map[string]int{}, planned: map[string]int{}, used: map[int]bool{},
		skillCount: map[string]int{}, sources: map[string]int{},
	}
	for _, w := range req.Vocabulary.Words {
		p.inV[w.Key()] = true
	}
	p.buckets = layout(req)
	for i := range pool {
		q := &pool[i]
		// The store's Pool already keeps to the book, the language and the lessons; the plan does not rely on it.
		if q.Book != req.Vocabulary.Book || q.Language != int(req.Language) || q.MaxLesson > req.Vocabulary.MaxLesson() ||
			q.Status != store.QuestionActive || !accepts(req.Platform, q) ||
			!slices.ContainsFunc(q.Targets, func(t string) bool { return p.inV[t] }) {
			continue
		}
		placeable := false
		for _, b := range p.buckets {
			if p.takes(b, q) {
				b.candidates++
				placeable = true
			}
		}
		if !placeable {
			continue
		}
		p.candidates = append(p.candidates, i)
		for _, t := range q.Targets {
			p.sources[t]++
		}
	}
	// Equal scores then come out in a different order for each seed.
	p.rng.Shuffle(len(p.candidates), func(i, j int) { p.candidates[i], p.candidates[j] = p.candidates[j], p.candidates[i] })

	p.rebalance(p.cover())
	// Every word should be tested; a Game, as long as the teacher chose, can only test as many as it has places.
	target, coveredWords := len(req.Vocabulary.Words), 0
	if capacity, elastic := p.capacity(); !elastic {
		target = min(target, capacity)
	}
	var uncovered []string
	for _, w := range req.Vocabulary.Words {
		if p.covered[w.Key()] == 0 {
			uncovered = append(uncovered, w.Key())
		} else {
			coveredWords++
		}
	}
	var gaps []csvgen.QuestionSpec
	for _, key := range uncovered {
		if coveredWords+len(gaps) >= target {
			break
		}
		if b := p.roomFor(true); b != nil {
			gaps = append(gaps, p.reserve(b, key))
		}
	}
	gaps = append(gaps, p.fill()...)

	plan := Plan{Gaps: gaps, Uncovered: uncovered, stages: req.Stages}
	for _, b := range p.buckets {
		for _, i := range b.picked {
			plan.Picks = append(plan.Picks, Pick{Question: pool[i], Stage: b.stage})
		}
	}
	plan.Size = len(plan.Picks) + len(plan.Gaps)
	return plan
}

// layout is the parts of the quiz the request asks for.
func layout(req Request) []*bucket {
	if req.Platform == csvgen.GestureQuiz {
		buckets := make([]*bucket, len(req.Stages))
		for i, stage := range req.Stages {
			buckets[i] = &bucket{stage: stage, difficulty: gapDifficulty[stage-1], capacity: req.PerStage}
		}
		return buckets
	}
	quotas := levelQuotas(QuizSize(len(req.Vocabulary.Words)))
	var buckets []*bucket
	for level := Easy; level <= Hard; level++ {
		quota := quotas[level-1]
		if req.Platform == csvgen.Wayground {
			visual := int(math.Ceil(float64(quota) * visualShare))
			buckets = append(buckets, &bucket{difficulty: level, visual: true, capacity: visual})
			quota -= visual
		}
		buckets = append(buckets, &bucket{difficulty: level, capacity: quota, elastic: true})
	}
	return buckets
}

// capacity is how many questions the parts hold together, and whether any can grow.
func (p *planner) capacity() (int, bool) {
	total, elastic := 0, false
	for _, b := range p.buckets {
		total += b.capacity
		elastic = elastic || b.elastic
	}
	return total, elastic
}

// takes says whether the part of the quiz can hold q.
func (p *planner) takes(b *bucket, q *store.Question) bool {
	if b.stage > 0 {
		return fitsStage(q, b.stage)
	}
	if q.Difficulty != b.difficulty {
		return false
	}
	return !b.visual || q.Skill == SkillVisual
}

// cover picks, one at a time, the question that tests the most still untested words, into the part of the quiz
// that suits it best, until none tests a new word or none has a place. Only when no such question has a free place
// does an elastic part grow to take one: covering every word matters more than the size of the quiz.
// It returns how many places it added.
func (p *planner) cover() (grown int) {
	for {
		best, place := p.bestCover(false)
		if best < 0 {
			if best, place = p.bestCover(true); best < 0 {
				return grown
			}
		}
		if place.room() <= 0 {
			place.capacity++
			grown++
		}
		p.pick(best, place)
	}
}

// rebalance takes back the places cover added from the elastic parts with the most room left, keeping a place in
// each, so that the quiz keeps its size and only its mix of levels gives way.
func (p *planner) rebalance(grown int) {
	for range grown {
		var most *bucket
		for _, b := range p.buckets {
			if b.elastic && b.room() > 0 && b.capacity > 1 && (most == nil || b.room() > most.room()) {
				most = b
			}
		}
		if most == nil {
			return
		}
		most.capacity--
	}
}

// bestCover is the best question testing a new word and its place, overflow allowed or not; -1 when none.
func (p *planner) bestCover(overflow bool) (int, *bucket) {
	best, bestScore, place := -1, math.Inf(-1), (*bucket)(nil)
	for _, i := range p.candidates {
		if p.used[i] || p.newWords(&p.pool[i]) == 0 {
			continue
		}
		b := p.placeFor(&p.pool[i], overflow)
		if b == nil {
			continue
		}
		if s := p.score(i, false); s > bestScore {
			best, bestScore, place = i, s, b
		}
	}
	return best, place
}

// fill fills what is left of each part, the parts with the fewest candidates first, and returns a gap for every
// place no question fits, each testing the word the quiz tests the least.
func (p *planner) fill() []csvgen.QuestionSpec {
	order := slices.Clone(p.buckets)
	slices.SortStableFunc(order, func(a, b *bucket) int { return a.candidates - b.candidates })
	var gaps []csvgen.QuestionSpec
	for _, b := range order {
		for b.room() > 0 {
			best, bestScore := -1, math.Inf(-1)
			for _, i := range p.candidates {
				if p.used[i] || !p.takes(b, &p.pool[i]) {
					continue
				}
				if s := p.score(i, true); s > bestScore {
					best, bestScore = i, s
				}
			}
			if best < 0 {
				break
			}
			p.pick(best, b)
		}
		for b.room() > 0 && len(p.req.Vocabulary.Words) > 0 {
			gaps = append(gaps, p.reserve(b, p.leastPlanned()))
		}
	}
	return gaps
}

// placeFor is the part of the quiz that should take q: of those with room that can hold it, the one with the
// fewest candidates, then the most room; failing that, when overflow is allowed, an elastic one that can hold it.
func (p *planner) placeFor(q *store.Question, overflow bool) *bucket {
	var best *bucket
	for _, b := range p.buckets {
		if b.room() <= 0 || !p.takes(b, q) {
			continue
		}
		if best == nil || b.candidates < best.candidates || (b.candidates == best.candidates && b.room() > best.room()) {
			best = b
		}
	}
	if best != nil || !overflow {
		return best
	}
	for _, b := range p.buckets {
		if b.elastic && p.takes(b, q) {
			return b
		}
	}
	return nil
}

// roomFor is the part with the most room, for a gap; when none has room and overflow is allowed, the elastic one
// that is the least full grows by one place. Nil when there is no place (a Game is as long as the teacher chose).
func (p *planner) roomFor(overflow bool) *bucket {
	var best *bucket
	for _, b := range p.buckets {
		if b.room() > 0 && (best == nil || b.room() > best.room() || (b.room() == best.room() && b.visual && !best.visual)) {
			best = b
		}
	}
	if best != nil || !overflow {
		return best
	}
	for _, b := range p.buckets {
		if b.elastic && (best == nil || fullness(b) < fullness(best)) {
			best = b
		}
	}
	if best != nil {
		best.capacity++
	}
	return best
}

func fullness(b *bucket) float64 {
	return float64(len(b.picked)+b.gaps) / float64(max(b.capacity, 1))
}

// reserve keeps a place of the part for a question to write about word, and says what that question must be.
func (p *planner) reserve(b *bucket, word string) csvgen.QuestionSpec {
	b.gaps++
	p.planned[word]++
	if b.stage > 0 {
		spec := stageSpecOf(b.stage)
		return csvgen.QuestionSpec{Word: word, Format: spec.format, Skills: spec.skills, Difficulty: b.difficulty, Options: spec.options}
	}
	if b.visual {
		return csvgen.QuestionSpec{Word: word, Format: FormatMC, Skills: []string{SkillVisual}, Difficulty: b.difficulty, Options: 4, Visual: true}
	}
	spec := csvgen.QuestionSpec{Word: word, Format: FormatMC, Skills: skillsFor[b.difficulty], Difficulty: b.difficulty, Options: 4}
	if b.difficulty == Hard {
		// A hard question may also be a sentence to put in order.
		spec.Format = ""
	}
	return spec
}

// leastPlanned is the word the quiz tests the least, picked and still to write together, the first in the book.
func (p *planner) leastPlanned() string {
	best, bestCount := "", math.MaxInt
	for _, w := range p.req.Vocabulary.Words {
		if n := p.planned[w.Key()]; n < bestCount {
			best, bestCount = w.Key(), n
		}
	}
	return best
}

func (p *planner) pick(i int, b *bucket) {
	q := &p.pool[i]
	p.used[i] = true
	b.picked = append(b.picked, i)
	for _, t := range q.Targets {
		if p.inV[t] {
			p.covered[t]++
			p.planned[t]++
		}
	}
	p.skillCount[q.Skill]++
	p.lastSkill = q.Skill
	p.picks++
}

// newWords is how many of q's words no pick tests yet.
func (p *planner) newWords(q *store.Question) int {
	n := 0
	for _, t := range q.Targets {
		if p.inV[t] && p.covered[t] == 0 {
			n++
		}
	}
	return n
}

// score ranks a candidate: the new words it tests, the fewer other questions test them the better (while covering),
// or how little its words are tested already (while filling); its words of the lessons, a skill the quiz has less
// of, fewer quizzes before, and some chance.
func (p *planner) score(i int, filling bool) float64 {
	q := &p.pool[i]
	inV, tested := 0, 0
	for _, t := range q.Targets {
		if p.inV[t] {
			inV++
			tested += p.covered[t]
		}
	}
	s := 2 * float64(inV)
	if filling {
		s -= 1.5 * float64(tested)
	} else {
		for _, t := range q.Targets {
			if p.inV[t] && p.covered[t] == 0 {
				s += 10 + 12/float64(p.sources[t])
			}
		}
	}
	if q.Skill == p.lastSkill {
		s -= 3
	}
	s -= 4 * float64(p.skillCount[q.Skill]) / float64(p.picks+1)
	s -= math.Log2(1 + float64(q.ServedCount))
	return s + p.rng.Float64()
}
