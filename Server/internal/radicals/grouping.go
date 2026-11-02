package radicals

import (
	"cmp"
	"math/rand/v2"
	"slices"
	"unicode/utf8"
)

const (
	groupSize     = 6 // 1 example + 5 questions, one per component of the tray
	maxGroupCount = 8 // groups of a lesson are tried up to this count (exclusive)
	maxDFSNodes   = 4000
)

// lessonWord is a word of a lesson as the grouping sees it.
type lessonWord struct {
	hanzi  string
	star   bool
	proper bool
}

// option is one way to ask about a word: hide component hide of the character at rune index ci. The rest is what the
// search looks up most, worked out once.
type option struct {
	word string
	ci   int
	char string
	hide string

	id      int32   // unique among the options of a grouper
	wordID  int32   // the same for every option of a word
	hideID  int32   // the same for every option hiding that component
	similar uint32  // bits of the look-alike pairs the hidden component belongs to
	cost    float64 // opt_cost
}

// question is one row of a group, as the page reads it.
type question struct {
	Word string `json:"word"`
	Ci   int    `json:"ci"`
	Miss string `json:"miss"`
}

// group is an example and its five questions.
type group struct {
	Example question
	Items   []question
}

type fillEntry struct {
	tier int
	word string
}

type solution struct {
	score  float64
	groups [][]option
	fills  []fillEntry
	soft   int
}

// grouper splits each lesson into groups (grouping.py).
type grouper struct {
	a       *analysis
	lessons map[int][]lessonWord
	review  bool
	tries   int
	seed    uint64
	skipped map[int]bool // lessons that could not be grouped: their words are not offered for review

	options   map[string][]option
	conflicts map[uint64]int8
	readings  map[string]map[string]bool
	wordIDs   map[string]int32
	hideIDs   map[string]int32
	optionIDs int32
}

func newGrouper(a *analysis, lessons map[int][]lessonWord, review bool, tries int, seed uint64) *grouper {
	return &grouper{
		a: a, lessons: lessons, review: review, tries: tries, seed: seed, skipped: map[int]bool{},
		options:   map[string][]option{},
		conflicts: map[uint64]int8{},
		readings:  map[string]map[string]bool{},
		wordIDs:   map[string]int32{},
		hideIDs:   map[string]int32{},
	}
}

// optionsFor lists every way to ask about a word.
func (g *grouper) optionsFor(word string) []option {
	if opts, ok := g.options[word]; ok {
		return opts
	}
	wordID, ok := g.wordIDs[word]
	if !ok {
		wordID = int32(len(g.wordIDs))
		g.wordIDs[word] = wordID
	}
	var opts []option
	for i, c := range []rune(word) {
		for _, h := range g.a.candidates(string(c)) {
			hideID, ok := g.hideIDs[h]
			if !ok {
				hideID = int32(len(g.hideIDs))
				g.hideIDs[h] = hideID
			}
			o := option{word: word, ci: i, char: string(c), hide: h, id: g.optionIDs, wordID: wordID, hideID: hideID, similar: similarBits(h)}
			g.optionIDs++
			o.cost = g.computeCost(o)
			opts = append(opts, o)
		}
	}
	g.options[word] = opts
	return opts
}

func (g *grouper) pinyinOf(ch string) map[string]bool {
	if set, ok := g.readings[ch]; ok {
		return set
	}
	set := map[string]bool{}
	if e := g.a.data.entries[ch]; e != nil {
		for _, p := range e.Pinyin {
			set[toneless(p)] = true
		}
	}
	g.readings[ch] = set
	return set
}

// conflictKind is 0 for no conflict between two options, 1 when swapping the hidden components would give another
// valid character read differently, 2 when it would give one with the same toneless reading.
func (g *grouper) conflictKind(a, b option) int {
	key := uint64(a.id)<<32 | uint64(b.id)
	if k, ok := g.conflicts[key]; ok {
		return int(k)
	}
	kind := 0
	for _, pair := range [2][2]option{{a, b}, {b, a}} {
		x, y := pair[0], pair[1]
		for _, alt := range g.a.alternativesFor(x.char, x.hide, y.hide) {
			shared := false
			own := g.pinyinOf(x.char)
			for reading := range g.pinyinOf(alt) {
				if own[reading] {
					shared = true
					break
				}
			}
			if shared {
				kind = max(kind, 2)
			} else {
				kind = max(kind, 1)
			}
		}
	}
	g.conflicts[key] = int8(kind)
	return kind
}

func (g *grouper) cost(o option) float64 { return o.cost }

func (g *grouper) computeCost(o option) float64 {
	var c float64
	switch {
	case standardRadicals[o.hide]:
	case g.a.poolChars[o.hide]:
		c = 0.5
	default:
		c = 1.0
	}
	total, hidden := g.a.hiddenStrokes(o.char, o.hide)
	if total-hidden <= 1 {
		c += 0.9
	}
	for _, p := range g.a.dec(o.char).parts {
		if !g.a.componentInfo[p.name] {
			c += 0.35
		}
	}
	return c
}

func (g *grouper) fits(members []option, o option) bool {
	for _, x := range members {
		if x.hideID == o.hideID || x.wordID == o.wordID || x.similar&o.similar != 0 {
			return false
		}
		if g.conflictKind(x, o) == 2 {
			return false
		}
	}
	return true
}

// solveLesson finds the best groups for a lesson, or nil when it has too few usable words.
func (g *grouper) solveLesson(l int) *solution {
	rnd := rand.New(rand.NewPCG(g.seed, uint64(l)))
	var real, proper []lessonWord
	for _, w := range g.lessons[l] {
		if len(g.optionsFor(w.hanzi)) == 0 {
			continue
		}
		if w.proper {
			proper = append(proper, w)
		} else {
			real = append(real, w)
		}
	}
	first := max(1, (len(real)+groupSize-1)/groupSize)
	last := maxGroupCount - 1
	if first > last {
		last = first + 1 // the KIT gave up on lessons of more than 42 usable words; these get two tries
	}
	for n := first; n <= last; n++ {
		if best := g.solveN(l, n, real, proper, rnd); best != nil {
			return best
		}
	}
	return nil
}

func (g *grouper) solveN(l, n int, real, proper []lessonWord, rnd *rand.Rand) *solution {
	var best *solution
	var previous []lessonRef
	if g.review {
		for ll := l - 1; ll > 0; ll-- {
			if g.skipped[ll] {
				continue
			}
			for _, w := range g.lessons[ll] {
				if !w.proper && len(g.optionsFor(w.hanzi)) > 0 && !slices.ContainsFunc(real, func(r lessonWord) bool { return r.hanzi == w.hanzi }) {
					previous = append(previous, lessonRef{w.hanzi, ll})
				}
			}
		}
	}
	ownRefs := func(words []lessonWord) []lessonRef {
		refs := make([]lessonRef, len(words))
		for i, w := range words {
			refs[i] = lessonRef{w.hanzi, l}
		}
		return refs
	}
	tiers := [3][]lessonRef{ownRefs(proper), ownRefs(real), previous}
	capacity := 1
	if len(real) > 0 {
		capacity = (len(real) + n - 1) / n
	}

	for range g.tries {
		words := slices.Clone(real)
		rnd.Shuffle(len(words), func(i, j int) { words[i], words[j] = words[j], words[i] })
		slices.SortStableFunc(words, func(x, y lessonWord) int {
			return cmp.Compare(len(g.optionsFor(x.hanzi)), len(g.optionsFor(y.hanzi)))
		})
		groups := make([][]option, n)

		nodes := 0
		var dfs func(i int) bool
		dfs = func(i int) bool {
			nodes++
			if nodes > maxDFSNodes {
				return false
			}
			if i == len(words) {
				return true
			}
			opts := slices.Clone(g.optionsFor(words[i].hanzi))
			rnd.Shuffle(len(opts), func(a, b int) { opts[a], opts[b] = opts[b], opts[a] })
			keys := make([]float64, len(opts))
			for k, o := range opts {
				keys[k] = g.cost(o) + rnd.Float64()*0.6
			}
			sortByKeys(opts, keys)
			order := rnd.Perm(n)
			for _, o := range opts {
				for _, gi := range order {
					if len(groups[gi]) < capacity && g.fits(groups[gi], o) {
						groups[gi] = append(groups[gi], o)
						if dfs(i + 1) {
							return true
						}
						groups[gi] = groups[gi][:len(groups[gi])-1]
					}
				}
			}
			return false
		}
		if !dfs(0) {
			continue
		}

		appear := map[string]int{}
		placed := map[int32]bool{}
		for _, grp := range groups {
			for _, o := range grp {
				appear[o.word]++
				placed[o.id] = true
			}
		}
		var fills []fillEntry
		filled := true
	fill:
		for gi := range groups {
			for len(groups[gi]) < groupSize {
				type candidate struct {
					tier int
					cost float64
					o    option
				}
				var cands []candidate
				for tier, refs := range tiers {
					for _, ref := range refs {
						for _, o := range g.optionsFor(ref.word) {
							limit := 1
							if tier == 1 {
								limit = 2
							}
							if appear[ref.word] >= limit {
								continue
							}
							if g.fits(groups[gi], o) && !placed[o.id] {
								cands = append(cands, candidate{tier, g.cost(o) + 0.3*float64(l-ref.lesson) + rnd.Float64()*0.5, o})
							}
						}
					}
					if len(cands) > 0 {
						break
					}
				}
				if len(cands) == 0 {
					filled = false
					break fill
				}
				slices.SortStableFunc(cands, func(x, y candidate) int {
					return cmp.Or(cmp.Compare(x.tier, y.tier), cmp.Compare(x.cost, y.cost))
				})
				o := cands[0].o
				groups[gi] = append(groups[gi], o)
				placed[o.id] = true
				appear[o.word]++
				fills = append(fills, fillEntry{cands[0].tier, o.word})
			}
		}
		if !filled {
			continue
		}

		score, soft := g.score(groups, fills)
		if best == nil || score < best.score {
			copied := make([][]option, len(groups))
			for i, grp := range groups {
				copied[i] = slices.Clone(grp)
			}
			best = &solution{score, copied, fills, soft}
		}
	}
	return best
}

type lessonRef struct {
	word   string
	lesson int
}

// sortByKeys sorts opts by keys (stable), the way Python's sort(key=...) does.
func sortByKeys(opts []option, keys []float64) {
	idx := make([]int, len(opts))
	for i := range idx {
		idx[i] = i
	}
	slices.SortStableFunc(idx, func(a, b int) int { return cmp.Compare(keys[a], keys[b]) })
	sorted := make([]option, len(opts))
	for i, k := range idx {
		sorted[i] = opts[k]
	}
	copy(opts, sorted)
}

func (g *grouper) score(groups [][]option, fills []fillEntry) (float64, int) {
	var score float64
	var all []string
	pairs := map[[2]string]bool{}
	pairCount := 0
	soft, sameChar := 0, 0
	for _, grp := range groups {
		for i, o := range grp {
			score += g.cost(o)
			all = append(all, o.hide)
			pairs[[2]string{o.char, o.hide}] = true
			pairCount++
			for _, p := range grp[i+1:] {
				if g.conflictKind(o, p) == 1 {
					soft++
				}
				if o.char == p.char {
					sameChar++
				}
			}
		}
	}
	distinct := map[string]bool{}
	for _, h := range all {
		distinct[h] = true
	}
	score += 0.7 * float64(len(all)-len(distinct))
	for _, f := range fills {
		switch f.tier {
		case 2:
			score += 3.0
		case 1:
			score += 0.5
		default:
			score += 0.1
		}
	}
	score += 0.4 * float64(soft)
	score += 2.5 * float64(sameChar)
	score += 1.2 * float64(pairCount-len(pairs))
	return score, soft
}

// finalize picks each group's example and orders questions and groups by the words' order in the lesson.
func (g *grouper) finalize(l int, groups [][]option) []group {
	order := map[string]int{}
	for i, w := range g.lessons[l] {
		order[w.hanzi] = i
	}
	rank := func(word string) int {
		if i, ok := order[word]; ok {
			return i
		}
		return 999
	}
	appearances := map[string]int{}
	for _, grp := range groups {
		for _, o := range grp {
			appearances[o.word]++
		}
	}
	exampleCost := func(o option) float64 {
		c := g.cost(o)
		if o.hide == "学字头" {
			c += 1.0
		}
		if appearances[o.word] > 1 {
			c += 0.8
		}
		if utf8.RuneCountInString(o.word) == 1 {
			c += 0.3
		}
		if _, ok := order[o.word]; !ok {
			c += 1
		}
		return c
	}
	type finished struct {
		example option
		rest    []option
	}
	var done []finished
	for _, grp := range groups {
		example := grp[0]
		for _, o := range grp[1:] {
			if exampleCost(o) < exampleCost(example) {
				example = o
			}
		}
		var rest []option
		for _, o := range grp {
			if o.id != example.id {
				rest = append(rest, o)
			}
		}
		slices.SortStableFunc(rest, func(x, y option) int {
			return cmp.Or(cmp.Compare(rank(x.word), rank(y.word)), cmp.Compare(x.ci, y.ci))
		})
		done = append(done, finished{example, rest})
	}
	first := func(f finished) int {
		m := rank(f.example.word)
		for _, o := range f.rest {
			m = min(m, rank(o.word))
		}
		return m
	}
	slices.SortStableFunc(done, func(x, y finished) int { return cmp.Compare(first(x), first(y)) })
	out := make([]group, len(done))
	for i, f := range done {
		out[i].Example = question{f.example.word, f.example.ci, f.example.hide}
		for _, o := range f.rest {
			out[i].Items = append(out[i].Items, question{o.word, o.ci, o.hide})
		}
	}
	return out
}
