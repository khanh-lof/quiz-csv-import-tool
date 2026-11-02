package radicals

import (
	"errors"
	"slices"
	"strings"
)

// idsArity is the number of operands of each Ideographic Description operator MMAH uses.
var idsArity = map[rune]int{'⿰': 2, '⿱': 2, '⿲': 3, '⿳': 3, '⿴': 2, '⿵': 2, '⿶': 2, '⿷': 2, '⿸': 2, '⿹': 2, '⿺': 2, '⿻': 2}

// idsNode is a parsed decomposition: a lone character (leaf) or an operator over operands.
type idsNode struct {
	op   rune
	kids []*idsNode
	leaf string
}

func (n *idsNode) String() string {
	if n.kids == nil {
		return n.leaf
	}
	var b strings.Builder
	b.WriteRune(n.op)
	for _, k := range n.kids {
		b.WriteString(k.String())
	}
	return b.String()
}

var errBadDecomposition = errors.New("bad decomposition")

// parseIDS reads one expression from the start of s, ignoring anything after it, like the KIT's ids.parse.
func parseIDS(s []rune, i int) (*idsNode, int, error) {
	if i >= len(s) {
		return nil, i, errBadDecomposition
	}
	c := s[i]
	n, ok := idsArity[c]
	if !ok {
		return &idsNode{leaf: string(c)}, i + 1, nil
	}
	node := &idsNode{op: c}
	j := i + 1
	for range n {
		kid, next, err := parseIDS(s, j)
		if err != nil {
			return nil, next, err
		}
		node.kids = append(node.kids, kid)
		j = next
	}
	return node, j, nil
}

// component is one part of a character with the strokes (indexes into the character's strokes) that make it up.
type component struct {
	name    string
	strokes []int
}

// decomposition is how a character splits: its operator and parts.
type decomposition struct {
	op    rune
	parts []component
}

func (d *decomposition) names() []string {
	names := make([]string, len(d.parts))
	for i, p := range d.parts {
		names[i] = p.name
	}
	return names
}

// distinctNames lists each component name once, in order.
func (d *decomposition) distinctNames() []string {
	var names []string
	for _, p := range d.parts {
		if !slices.Contains(names, p.name) {
			names = append(names, p.name)
		}
	}
	return names
}

// strokesOf is the union of the strokes of every part called name.
func (d *decomposition) strokesOf(name string) []int {
	var all []int
	for _, p := range d.parts {
		if p.name == name {
			all = append(all, p.strokes...)
		}
	}
	slices.Sort(all)
	return slices.Compact(all)
}

// analysis answers which characters can be split, which components may be an answer, and which characters a
// replaced component would turn one into (analysis.py).
type analysis struct {
	data          *dataset
	known         map[string]bool
	validChars    map[string]bool
	poolChars     map[string]bool
	componentInfo map[string]bool
	excluded      map[string]bool

	decompositions map[string]*decomposition
	index          map[string][]string
	alternatives   map[[3]string][]string
}

func newAnalysis(data *dataset, lessonChars []string, excluded string) *analysis {
	a := &analysis{
		data:           data,
		known:          map[string]bool{},
		validChars:     map[string]bool{},
		poolChars:      map[string]bool{},
		componentInfo:  map[string]bool{},
		excluded:       map[string]bool{},
		decompositions: map[string]*decomposition{},
		alternatives:   map[[3]string][]string{},
	}
	for c := range hardExcluded {
		a.excluded[c] = true
	}
	for c := range setOf(excluded) {
		a.excluded[c] = true
	}
	for c := range data.poolChars {
		a.poolChars[c] = true
		a.known[c] = true
	}
	for _, c := range lessonChars {
		a.known[c] = true
	}
	for c := range familiarChars {
		a.known[c] = true
	}
	for c := range data.commonChars {
		a.known[c] = true
	}
	for c := range data.gb2312Level1 {
		a.validChars[c] = true
	}
	for c := range a.known {
		a.validChars[c] = true
	}
	for c := range data.poolComponents {
		a.componentInfo[c] = true
	}
	return a
}

// split is comp_strokes: the dictionary's decomposition of ch, or the rule that overrides it.
func (d *dataset) split(ch string) (*decomposition, error) {
	e, ok := d.entries[ch]
	if !ok {
		return nil, errBadDecomposition
	}
	t, _, err := parseIDS([]rune(e.Decomposed), 0)
	if err != nil || t.kids == nil {
		return nil, errBadDecomposition
	}
	if rules, ok := splitOverrides[ch]; ok {
		split := &decomposition{op: t.op}
		for _, rule := range rules {
			split.parts = append(split.parts, component{name: rule.name, strokes: rule.strokesIn(e.Matches)})
		}
		return split, nil
	}
	split := &decomposition{op: t.op}
	for k, kid := range t.kids {
		var strokes []int
		for i, p := range e.Matches {
			if len(p) > 0 && p[0] == k {
				strokes = append(strokes, i)
			}
		}
		split.parts = append(split.parts, component{name: kid.String(), strokes: strokes})
	}
	return split, nil
}

// dec is dec_raw (and get_dec: with MMAH's exact strokes every splittable character is good): the split of ch,
// or nil when ch is excluded, unknown, has no usable decomposition or a component without strokes.
func (a *analysis) dec(ch string) *decomposition {
	if d, ok := a.decompositions[ch]; ok {
		return d
	}
	d := a.computeDec(ch)
	a.decompositions[ch] = d
	return d
}

func (a *analysis) computeDec(ch string) *decomposition {
	if a.excluded[ch] {
		return nil
	}
	d, err := a.data.split(ch)
	if err != nil {
		return nil
	}
	for _, p := range d.parts {
		if len(p.strokes) == 0 {
			return nil
		}
	}
	return d
}

// answerable is ANS: whether a component may be the missing one.
func (a *analysis) answerable(c string) bool {
	if singleStrokes[c] {
		return false
	}
	if standardRadicals[c] {
		return true
	}
	return a.known[c]
}

// candidates are the components of ch that may be hidden.
func (a *analysis) candidates(ch string) []string {
	d := a.dec(ch)
	if d == nil {
		return nil
	}
	names := d.names()
	var out []string
	for _, n := range names {
		if a.answerable(n) && count(names, n) == 1 && !hiddenNever[charPair{ch, n}] {
			out = append(out, n)
		}
	}
	return out
}

func count(list []string, s string) int {
	n := 0
	for _, x := range list {
		if x == s {
			n++
		}
	}
	return n
}

// similarBits has one bit for each look-alike pair that c belongs to: two components are alike when they share a bit.
func similarBits(c string) uint32 {
	var bits uint32
	for i, p := range similarPairs {
		if c == p[0] || c == p[1] {
			bits |= 1 << i
		}
	}
	return bits
}

func shapeKey(op rune, names []string) string {
	return string(op) + "\x00" + strings.Join(names, "\x00")
}

// alternatives are the other valid characters made by replacing component hide of ch with other.
func (a *analysis) alternativesFor(ch, hide, other string) []string {
	key := [3]string{ch, hide, other}
	if alts, ok := a.alternatives[key]; ok {
		return alts
	}
	if a.index == nil {
		a.buildIndex()
	}
	var alts []string
	if d := a.dec(ch); d != nil {
		names := d.names()
		if k := slices.Index(names, hide); k >= 0 {
			names[k] = other
			for _, c := range a.index[shapeKey(d.op, names)] {
				if c != ch {
					alts = append(alts, c)
				}
			}
		}
	}
	a.alternatives[key] = alts
	return alts
}

// buildIndex maps each (operator, component names) to the valid characters that split that way.
func (a *analysis) buildIndex() {
	a.index = map[string][]string{}
	valid := make([]string, 0, len(a.validChars))
	for c := range a.validChars {
		valid = append(valid, c)
	}
	slices.Sort(valid)
	for _, c := range valid {
		d, err := a.data.split(c)
		if err != nil {
			continue
		}
		key := shapeKey(d.op, d.names())
		a.index[key] = append(a.index[key], c)
	}
}

// hiddenStrokes returns the number of strokes of ch and of its component hide.
func (a *analysis) hiddenStrokes(ch, hide string) (total, hidden int) {
	total = len(a.data.entries[ch].Matches)
	for _, p := range a.dec(ch).parts {
		if p.name == hide {
			return total, len(p.strokes)
		}
	}
	return total, 0
}
