package radicals

import (
	"fmt"
	"math/rand/v2"
	"slices"
	"strings"
	"unicode/utf8"

	"golang.org/x/text/unicode/norm"
)

// Build assembles the exercise from the plan and the answers to Needs. Anything still missing is an error, and so is
// a failure of the static checks. It fails with ErrNothingToPlay when no lesson could be grouped.
func (d *Draft) Build(info Info) (*Exercise, error) {
	if len(d.groups) == 0 {
		return nil, ErrNothingToPlay
	}
	built := d.assemble(info)
	if !built.needs.empty() {
		return nil, fmt.Errorf("Language data is still missing: %s.", describeNeeds(built.needs))
	}
	if len(built.problems) > 0 {
		shown := built.problems[:min(len(built.problems), 40)]
		more := ""
		if len(built.problems) > len(shown) {
			more = fmt.Sprintf("\n... and %d more.", len(built.problems)-len(shown))
		}
		return nil, fmt.Errorf("The exercise failed its checks:\n%s%s", strings.Join(shown, "\n"), more)
	}
	return built.exercise, nil
}

// Needs lists what Build still needs: characters of all words with no meaning in the pool, components that will
// appear in the exercise with no description, and words with no meaning.
func (d *Draft) Needs() Needs {
	if len(d.groups) == 0 {
		return Needs{Words: []WordNeed{}, Chars: []CharNeed{}, Components: []ComponentNeed{}}
	}
	return d.assemble(Info{}).needs
}

func describeNeeds(n Needs) string {
	var parts []string
	if len(n.Words) > 0 {
		words := make([]string, len(n.Words))
		for i, w := range n.Words {
			words[i] = w.Hanzi
		}
		parts = append(parts, "meanings of words "+strings.Join(words, " "))
	}
	if len(n.Chars) > 0 {
		chars := make([]string, len(n.Chars))
		for i, c := range n.Chars {
			chars[i] = c.Char
		}
		parts = append(parts, "meanings of characters "+strings.Join(chars, " "))
	}
	if len(n.Components) > 0 {
		comps := make([]string, len(n.Components))
		for i, c := range n.Components {
			comps[i] = c.Component
		}
		parts = append(parts, "descriptions of components "+strings.Join(comps, " "))
	}
	return strings.Join(parts, "; ")
}

// partEntry is a component as the page reads it (PARTS).
type partEntry struct {
	Name    string `json:"name"`
	Zh      string `json:"zh"`
	Py      string `json:"py"`
	Vi      string `json:"vi"`
	St      int    `json:"st,omitempty"`
	Role    string `json:"role"`
	Tip     string `json:"tip,omitempty"`
	NoGlyph bool   `json:"noGlyph,omitempty"`
	From    string `json:"from,omitempty"`
}

// charEntry is a character as the page reads it (CHARS).
type charEntry struct {
	Py     string   `json:"py"`
	Vi     string   `json:"vi"`
	St     int      `json:"st,omitempty"`
	Parts  []string `json:"parts,omitempty"`
	Struct string   `json:"struct,omitempty"`
}

type vocabEntry struct {
	H      string   `json:"h"`
	P      string   `json:"p"`
	Vi     string   `json:"vi"`
	Proper bool     `json:"proper,omitempty"`
	Star   bool     `json:"star,omitempty"`
	Syl    []string `json:"syl,omitempty"`
}

type groupEntry struct {
	Example question   `json:"example"`
	Items   []question `json:"items"`
	Opts    []string   `json:"opts"`
}

type lessonEntry struct {
	Title  string       `json:"title"`
	Vocab  []vocabEntry `json:"vocab"`
	Groups []groupEntry `json:"groups"`
}

// glyphSpec says how a character is drawn: by component (split) or whole, and whether some strokes belong to no
// component and are always shown.
type glyphSpec struct {
	names []string
	split bool
	rest  bool
}

func (g glyphSpec) listed() []string {
	if !g.split {
		return []string{"*"}
	}
	if g.rest {
		return append(slices.Clone(g.names), "*")
	}
	return g.names
}

// lessonWordRef is a word of a played lesson.
type lessonWordRef struct {
	lesson int
	word   Word
}

type assembled struct {
	exercise *Exercise
	needs    Needs
	problems []string
}

// builder is one assembly (build_data.py).
type builder struct {
	d    *Draft
	data *dataset
	a    *analysis
	info Info

	lw        []lessonWordRef
	needs     Needs
	needWord  map[string]bool
	needChar  map[string]bool
	needComp  map[string]bool
	level     string
	glyphs    map[string]glyphSpec
	hidden    map[string]bool // characters with a component hidden in some question
	compOrder []string
	compChars map[string][]string
	parts     map[string]*partEntry
	partKeys  []string
}

func (d *Draft) playedLessons() []Lesson {
	var played []Lesson
	for _, l := range d.lessons {
		if _, ok := d.groups[l.Number]; ok {
			played = append(played, l)
		}
	}
	return played
}

func (d *Draft) assemble(info Info) assembled {
	d.mu.Lock()
	defer d.mu.Unlock()
	b := &builder{
		d: d, data: d.data, a: d.analysis, info: info,
		needs:     Needs{Words: []WordNeed{}, Chars: []CharNeed{}, Components: []ComponentNeed{}},
		needWord:  map[string]bool{},
		needChar:  map[string]bool{},
		needComp:  map[string]bool{},
		level:     d.opts.Level,
		glyphs:    map[string]glyphSpec{},
		compChars: map[string][]string{},
		parts:     map[string]*partEntry{},
	}
	if b.level == "" {
		b.level = "khoá này"
	}
	played := d.playedLessons()
	for _, l := range played {
		for _, w := range l.Words {
			b.lw = append(b.lw, lessonWordRef{l.Number, w})
		}
	}

	review := Review{
		PinyinWarnings: b.checkPinyin(),
		SkippedLessons: nonNil(d.skipped),
		UnusableWords:  map[string][]string{},
		Groups:         map[string]int{},
		MissingGlyphs:  []string{},
		AIWords:        []string{}, UncertainWords: []string{}, DroppedWords: []string{}, AIChars: []string{}, AIComponents: []string{},
	}
	for n, words := range d.unusable {
		review.UnusableWords[fmt.Sprint(n)] = words
	}
	for _, l := range played {
		review.Groups[fmt.Sprint(l.Number)] = len(d.groups[l.Number])
	}

	meanings := b.wordMeanings(played)
	var allChars []string
	for _, e := range b.lw {
		for _, r := range e.word.Hanzi {
			if !slices.Contains(allChars, string(r)) {
				allChars = append(allChars, string(r))
			}
		}
	}

	review.MissingGlyphs = b.chooseGlyphs(played)
	b.buildComponents()
	chars := b.buildChars(allChars)
	lessons, titles, words := b.buildLessons(played, meanings)

	glyphs := map[string][]string{}
	for c, spec := range b.glyphs {
		glyphs[c] = spec.listed()
	}
	partsJSON := newObjectWriter()
	for _, k := range b.partKeys {
		partsJSON.add(k, b.parts[k])
	}
	charsJSON := newObjectWriter()
	for _, c := range allChars {
		if e, ok := chars.get(c); ok {
			charsJSON.add(c, e)
		}
	}
	wordsJSON := newObjectWriter()
	for _, k := range words.keys {
		wordsJSON.add(k, words.syllables[k])
	}
	lessonsJSON := newObjectWriter()
	for _, l := range played {
		lessonsJSON.add(fmt.Sprint(l.Number), lessons[l.Number])
	}

	options := d.opts
	title := options.PageTitle
	if title == "" {
		title = defaultTitle
		if options.Level != "" {
			title += " – " + options.Level
		}
	}
	preset := options.Preset
	if preset == "" {
		preset = "jade"
	}
	exercise := &Exercise{
		Version: 1, Config: b.config(), Title: title, Footer: "", Preset: preset,
		Parts: partsJSON.json(), Chars: charsJSON.json(), Words: wordsJSON.json(), Lessons: lessonsJSON.json(),
		LessonTitles: titles, Glyphs: glyphs, Review: review,
	}
	problems := b.check(played, lessons, chars, words)
	return assembled{exercise: exercise, needs: b.needs, problems: problems}
}

// ---------- page configuration ----------

func (b *builder) source() string {
	o := b.d.opts
	if o.VocabSource != "" {
		return o.VocabSource
	}
	if o.CourseName != "" {
		return "giáo trình " + o.CourseName
	}
	return ""
}

func (b *builder) config() map[string]string {
	o := b.d.opts
	source := o.VocabSource
	if source == "" {
		source = "bảng từ vựng"
	}
	var starTitle, starNote string
	if o.Level != "" {
		starTitle = "超纲: ngoài cấp độ " + o.Level
		starNote = "từ 超纲 (ngoài cấp độ " + o.Level + "), đánh dấu theo " + source + " của giáo trình."
	} else {
		starTitle = "超纲: ngoài chương trình"
		starNote = "từ 超纲 (ngoài chương trình), đánh dấu theo " + source + " của giáo trình."
	}
	if o.VocabSource != "" {
		starTitle += " (theo " + o.VocabSource + ")"
	}
	return map[string]string{"level": o.Level, "starTitle": starTitle, "starNote": starNote}
}

// pyEscape escapes like Python's html.escape.
func pyEscape(s string) string {
	return strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;", "'", "&#x27;").Replace(s)
}

// ---------- pinyin check ----------

// readingsOf lists the readings of a character, tone marks kept: those of MMAH and of the curated pool.
func (b *builder) readingsOf(char string) []string {
	return b.data.readings(char)
}

// checkPinyin warns where a syllable is no reading of its character: the base letters differ from every reading's,
// or only the tone does. 一 and 不 may carry any tone, a neutral tone is always fine, and 儿 may be r.
func (b *builder) checkPinyin() []PinyinWarning {
	warnings := []PinyinWarning{}
	type seenKey struct{ char, syllable string }
	seen := map[seenKey]bool{}
	for _, e := range b.lw {
		for i, c := range []rune(e.word.Hanzi) {
			char := string(c)
			syllable := norm.NFC.String(strings.ToLower(e.word.Syllables[i]))
			if syllable == "r" || char == "儿" && (syllable == "r" || syllable == "er") {
				continue
			}
			readings := b.readingsOf(char)
			if len(readings) == 0 {
				continue
			}
			bases := map[string]bool{}
			for _, r := range readings {
				bases[pinyinBase(r)] = true
			}
			if slices.Contains(readings, syllable) || bases[pinyinBase(syllable)] && (!hasToneMark(syllable) || char == "一" || char == "不") {
				continue
			}
			key := seenKey{char, syllable}
			if seen[key] {
				continue
			}
			seen[key] = true
			slices.Sort(readings)
			warnings = append(warnings, PinyinWarning{Lesson: e.lesson, Word: e.word.Hanzi, Char: char, Syllable: e.word.Syllables[i], Readings: readings, ToneOnly: bases[pinyinBase(syllable)]})
		}
	}
	return warnings
}

// ---------- meanings ----------

func (b *builder) wordMeanings(played []Lesson) map[lessonWordKey]string {
	meanings := map[lessonWordKey]string{}
	for _, l := range played {
		for _, w := range l.Words {
			meaning := w.Meaning
			if meaning == "" {
				meaning = b.data.poolWords[w.Hanzi]
			}
			if meaning == "" {
				meaning = strings.TrimSpace(b.info.WordMeanings[w.Hanzi])
			}
			if meaning == "" && !b.needWord[w.Hanzi] {
				b.needWord[w.Hanzi] = true
				b.needs.Words = append(b.needs.Words, WordNeed{Hanzi: w.Hanzi, Pinyin: w.Pinyin})
			}
			meanings[lessonWordKey{l.Number, w.Hanzi}] = meaning
		}
	}
	return meanings
}

type lessonWordKey struct {
	lesson int
	hanzi  string
}

// ---------- glyphs ----------

// hasRest says whether some strokes of ch belong to none of the components of d.
func (b *builder) hasRest(ch string, d *decomposition) bool {
	total := len(b.data.entries[ch].Matches)
	owned := map[int]bool{}
	for _, p := range d.parts {
		for _, s := range p.strokes {
			owned[s] = true
		}
	}
	for i := range total {
		if !owned[i] {
			return true
		}
	}
	return false
}

// chooseGlyphs decides how each character of the questions' words is drawn and returns the characters MMAH has no
// strokes for. A character whose component is hidden in some question is split; so is a curated pool character
// whose parts match its split; any other character is drawn whole.
func (b *builder) chooseGlyphs(played []Lesson) []string {
	need := map[string]bool{}
	var used []string
	for _, l := range played {
		for _, g := range b.d.groups[l.Number] {
			for _, q := range append([]question{g.Example}, g.Items...) {
				runes := []rune(q.Word)
				need[string(runes[q.Ci])] = true
				for _, r := range runes {
					if !slices.Contains(used, string(r)) {
						used = append(used, string(r))
					}
				}
			}
		}
	}
	missing := []string{}
	for _, c := range used {
		d := b.a.dec(c)
		pool, inPool := b.data.poolChars[c]
		switch {
		case need[c] && d != nil:
			b.setGlyph(c, glyphSpec{names: d.distinctNames(), split: true, rest: b.hasRest(c, d)})
		case !need[c] && inPool && len(pool.Parts) > 0 && d != nil && sameSet(pool.Parts, d.distinctNames()):
			b.setGlyph(c, glyphSpec{names: d.distinctNames(), split: true, rest: b.hasRest(c, d)})
		case len(b.data.strokes(c)) > 0:
			b.setGlyph(c, glyphSpec{})
		default:
			missing = append(missing, c)
		}
	}
	b.hidden = need
	return missing
}

func (b *builder) setGlyph(c string, spec glyphSpec) {
	b.glyphs[c] = spec
	if spec.split {
		for _, n := range spec.names {
			if _, ok := b.compChars[n]; !ok {
				b.compOrder = append(b.compOrder, n)
			}
			b.compChars[n] = append(b.compChars[n], c)
		}
	}
}

func sameSet(a, b []string) bool {
	for _, x := range a {
		if !slices.Contains(b, x) {
			return false
		}
	}
	for _, x := range b {
		if !slices.Contains(a, x) {
			return false
		}
	}
	return true
}

// ---------- components ----------

func (b *builder) roleGroups(comp string, chars []string) (semantic, phonetic, structural []string) {
	for _, ch := range chars {
		if entry := b.data.entries[ch]; entry != nil && entry.Etymology != nil && entry.Etymology.Type == "pictophonetic" && !roleSkipped[charPair{ch, comp}] {
			if entry.Etymology.Semantic == comp {
				semantic = append(semantic, ch)
				continue
			}
			if entry.Etymology.Phonetic == comp {
				phonetic = append(phonetic, ch)
				continue
			}
		}
		structural = append(structural, ch)
	}
	return
}

func listChars(chars []string) string {
	shown := chars[:min(len(chars), 8)]
	out := strings.Join(shown, ", ")
	if len(chars) > 8 {
		out += " …"
	}
	return out
}

func (b *builder) roleText(comp string, chars []string) string {
	semantic, phonetic, structural := b.roleGroups(comp, chars)
	var out []string
	if len(semantic) > 0 {
		out = append(out, "Nghĩa phù (义符) — gợi ý nghĩa — của "+listChars(semantic)+".")
	}
	if len(phonetic) > 0 {
		out = append(out, "Thanh phù (声符) — gợi âm — của "+listChars(phonetic)+".")
	}
	if len(structural) > 0 {
		out = append(out, "Bộ phận cấu tạo của "+listChars(structural)+".")
	}
	return strings.Join(out, " ")
}

func (b *builder) roleMore(comp string, chars []string) string {
	semantic, phonetic, structural := b.roleGroups(comp, chars)
	var bits []string
	if len(semantic) > 0 {
		bits = append(bits, "nghĩa phù (义符) của "+listChars(semantic))
	}
	if len(phonetic) > 0 {
		bits = append(bits, "thanh phù (声符) của "+listChars(phonetic))
	}
	if len(structural) > 0 {
		bits = append(bits, "bộ phận cấu tạo của "+listChars(structural))
	}
	if len(bits) == 0 {
		return ""
	}
	return "Trong từ vựng " + b.level + ": " + strings.Join(bits, "; ") + "."
}

// strokeCount is the number of strokes of comp in the first of chars that has it.
func (b *builder) strokeCount(comp string, chars []string) int {
	for _, ch := range chars {
		d, err := b.data.split(ch)
		if err != nil {
			continue
		}
		for _, p := range d.parts {
			if p.name == comp {
				return len(p.strokes)
			}
		}
	}
	return 0
}

func isIDSOperator(r rune) bool { return r >= '⿰' && r <= '⿿' }

// componentEntry describes comp for the page, or returns nil and records the need.
func (b *builder) componentEntry(comp string, chars []string) *partEntry {
	cc, ok := b.compChars[comp]
	if !ok {
		cc = chars
	}
	if pool, ok := b.data.poolComponents[comp]; ok {
		e := &partEntry{Name: pool.Name, Zh: pool.Zh, Py: pool.Pinyin, Vi: pool.Vietnamese, St: pool.Strokes, Tip: pool.Tip, NoGlyph: pool.NoGlyph, From: pool.From}
		if pool.BaseRole != "" {
			var fresh []string
			for _, c := range cc {
				if !strings.Contains(pool.BaseRole, c) {
					fresh = append(fresh, c)
				}
			}
			more := ""
			if len(fresh) > 0 {
				more = b.roleMore(comp, fresh)
			}
			e.Role = strings.TrimSpace(pool.BaseRole + " " + more)
		} else {
			e.Role = b.roleText(comp, cc)
		}
		return e
	}
	if given, ok := b.info.Components[comp]; ok {
		e := &partEntry{Name: strings.TrimSpace(given.Name), Zh: comp, Py: strings.TrimSpace(given.Pinyin), Vi: strings.TrimSpace(given.Meaning),
			St: b.strokeCount(comp, cc), Role: b.roleText(comp, cc)}
		if e.Name == "" {
			e.Name = comp
		}
		if e.Py == "" {
			e.Py = "—"
		}
		return e
	}
	if strings.ContainsFunc(comp, isIDSOperator) {
		zh := strings.Map(func(r rune) rune {
			if isIDSOperator(r) {
				return -1
			}
			return r
		}, comp)
		letters := make([]string, 0, utf8.RuneCountInString(zh))
		for _, r := range zh {
			letters = append(letters, string(r))
		}
		return &partEntry{Name: "Phần " + zh, Zh: zh, Py: "—", Vi: "phần ghép gồm " + strings.Join(letters, " + ") + " (không dùng độc lập)",
			St: b.strokeCount(comp, cc), Role: b.roleText(comp, cc)}
	}
	if !b.needComp[comp] {
		b.needComp[comp] = true
		need := ComponentNeed{Component: comp, InChars: slices.Clone(cc[:min(len(cc), 6)]), DictionaryPinyin: []string{}}
		if utf8.RuneCountInString(comp) == 1 {
			if entry := b.data.entries[comp]; entry != nil {
				need.Definition = entry.Definition
				need.DictionaryPinyin = nonNil(entry.Pinyin)
				if entry.Etymology != nil {
					need.EtymologyHint = entry.Etymology.Hint
				}
			}
		}
		b.needs.Components = append(b.needs.Components, need)
	}
	return nil
}

func (b *builder) addPart(comp string, e *partEntry) {
	if _, ok := b.parts[comp]; !ok {
		b.partKeys = append(b.partKeys, comp)
	}
	b.parts[comp] = e
}

func (b *builder) buildComponents() {
	for _, comp := range b.compOrder {
		if e := b.componentEntry(comp, b.compChars[comp]); e != nil {
			b.addPart(comp, e)
		}
	}
	for _, comp := range b.partKeys {
		e := b.parts[comp]
		pseudo := pseudoComponents[comp] != "" || utf8.RuneCountInString(comp) > 1 || len(b.data.strokes(comp)) == 0 || e.NoGlyph
		if !pseudo {
			continue
		}
		source := pseudoComponents[comp]
		if spec, ok := b.glyphs[source]; !ok || !spec.split || !slices.Contains(spec.names, comp) {
			source = ""
			for _, c := range b.compChars[comp] {
				source = c
				break
			}
		}
		if source != "" {
			e.NoGlyph, e.From = true, source
		}
	}
}

// ---------- characters ----------

func (b *builder) charPinyin(ch string) string {
	var readings, toned []string
	for _, e := range b.lw {
		runes := []rune(e.word.Hanzi)
		if i := slices.Index(runes, []rune(ch)[0]); i >= 0 {
			syllable := strings.ToLower(e.word.Syllables[i])
			readings = append(readings, syllable)
			if hasToneMark(syllable) && !slices.Contains(toned, syllable) {
				toned = append(toned, syllable)
			}
		}
	}
	pool, inPool := b.data.poolChars[ch]
	if len(toned) > 0 {
		if inPool && pool.Pinyin != "" && !slices.ContainsFunc(toned, func(t string) bool { return !strings.Contains(pool.Pinyin, t) }) {
			return pool.Pinyin
		}
		return strings.Join(toned, " / ")
	}
	if inPool && pool.Pinyin != "" {
		return pool.Pinyin
	}
	if entry := b.data.entries[ch]; entry != nil && len(entry.Pinyin) > 0 {
		return strings.Join(entry.Pinyin, " / ")
	}
	if len(readings) > 0 {
		return readings[0]
	}
	return ""
}

type charTable struct {
	entries map[string]charEntry
}

func (t charTable) get(c string) (charEntry, bool) {
	e, ok := t.entries[c]
	return e, ok
}

func (b *builder) buildChars(allChars []string) charTable {
	table := charTable{entries: map[string]charEntry{}}
	for _, ch := range allChars {
		pool, inPool := b.data.poolChars[ch]
		var parts []string
		structure := ""
		if spec, ok := b.glyphs[ch]; ok && spec.split {
			d := b.a.dec(ch)
			if b.hidden[ch] {
				parts = d.names()
			} else {
				parts = spec.names
			}
			if inPool && len(pool.Parts) > 0 && sameSet(pool.Parts, parts) {
				parts, structure = pool.Parts, pool.Structure
			} else {
				structure = structureNames[d.op]
			}
		} else if inPool && len(pool.Parts) > 0 {
			parts, structure = pool.Parts, pool.Structure
		}
		for _, p := range parts {
			if _, ok := b.parts[p]; !ok {
				if e := b.componentEntry(p, []string{ch}); e != nil {
					b.addPart(p, e)
				}
			}
		}

		meaning := pool.Vietnamese
		if meaning == "" {
			meaning = strings.TrimSpace(b.info.CharMeanings[ch])
		}
		if meaning == "" {
			if !b.needChar[ch] {
				b.needChar[ch] = true
				b.needs.Chars = append(b.needs.Chars, b.charNeed(ch))
			}
			continue
		}
		strokes := 0
		if entry := b.data.entries[ch]; entry != nil {
			strokes = len(entry.Matches)
		}
		if strokes == 0 {
			strokes = pool.Strokes
		}
		table.entries[ch] = charEntry{Py: b.charPinyin(ch), Vi: meaning, St: strokes, Parts: parts, Struct: structure}
	}
	b.fixPseudoSources()
	return table
}

func (b *builder) charNeed(ch string) CharNeed {
	var words []string
	for _, e := range b.lw {
		if strings.Contains(e.word.Hanzi, ch) {
			words = append(words, e.word.Hanzi)
		}
	}
	words = slices.Compact(slices.Clone(words[:min(len(words), 4)]))
	need := CharNeed{Char: ch, InWords: words, DictionaryPinyin: []string{}}
	if entry := b.data.entries[ch]; entry != nil {
		need.Definition = entry.Definition
		need.DictionaryPinyin = nonNil(entry.Pinyin)
	}
	return need
}

// fixPseudoSources makes sure each component drawn from a source character has one: a curated component marked
// noGlyph whose source is not in the exercise is drawn as text instead.
func (b *builder) fixPseudoSources() {
	for _, comp := range b.partKeys {
		e := b.parts[comp]
		if !e.NoGlyph {
			continue
		}
		if spec, ok := b.glyphs[e.From]; ok && spec.split && slices.Contains(spec.names, comp) {
			continue
		}
		e.NoGlyph, e.From = false, ""
		if cs := b.compChars[comp]; len(cs) > 0 {
			e.NoGlyph, e.From = true, cs[0]
		}
	}
}

// ---------- lessons ----------

type wordTable struct {
	keys      []string
	syllables map[string][]string
}

func (b *builder) buildLessons(played []Lesson, meanings map[lessonWordKey]string) (map[int]lessonEntry, map[string]string, wordTable) {
	lessons := map[int]lessonEntry{}
	titles := map[string]string{}
	words := wordTable{syllables: map[string][]string{}}
	for _, l := range played {
		titles[fmt.Sprint(l.Number)] = l.TitleZh
		var vocab []vocabEntry
		for _, w := range l.Words {
			e := vocabEntry{H: w.Hanzi, P: w.Pinyin, Vi: meanings[lessonWordKey{l.Number, w.Hanzi}], Proper: w.ProperNoun, Star: w.Star}
			var others [][]string
			for _, other := range b.lw {
				if other.word.Hanzi == w.Hanzi && other.lesson != l.Number {
					others = append(others, other.word.Syllables)
				}
			}
			if len(others) > 0 && !slices.ContainsFunc(others, func(o []string) bool { return slices.Equal(o, w.Syllables) }) {
				e.Syl = w.Syllables
			}
			vocab = append(vocab, e)
			if _, ok := words.syllables[w.Hanzi]; !ok {
				words.keys = append(words.keys, w.Hanzi)
				words.syllables[w.Hanzi] = w.Syllables
			}
		}
		entry := lessonEntry{Title: l.TitleVi, Vocab: vocab, Groups: []groupEntry{}}
		for gi, g := range b.d.groups[l.Number] {
			misses := []string{g.Example.Miss}
			for _, it := range g.Items {
				misses = append(misses, it.Miss)
			}
			entry.Groups = append(entry.Groups, groupEntry{Example: g.Example, Items: g.Items, Opts: b.shuffleTray(l.Number, gi, g, misses)})
		}
		lessons[l.Number] = entry
	}
	return lessons, titles, words
}

// shuffleTray orders the six components of a group on the tray: not in the order of the questions, not reversed, and
// not with the example's component first.
func (b *builder) shuffleTray(lesson, gi int, g group, misses []string) []string {
	seed := b.d.opts.Seed
	if seed == 0 {
		seed = 1
	}
	rnd := rand.New(rand.NewPCG(seed, uint64(2000*lesson+gi)))
	opts := slices.Clone(misses)
	for range 500 {
		opts = slices.Clone(misses)
		rnd.Shuffle(len(opts), func(i, j int) { opts[i], opts[j] = opts[j], opts[i] })
		pos := make([]int, len(g.Items))
		for i, it := range g.Items {
			pos[i] = slices.Index(opts, it.Miss)
		}
		ascending, descending := true, true
		for i := 0; i+1 < len(pos); i++ {
			ascending = ascending && pos[i] < pos[i+1]
			descending = descending && pos[i] > pos[i+1]
		}
		if !ascending && !descending && opts[0] != misses[0] {
			break
		}
	}
	return opts
}

// ---------- static checks ----------

func (b *builder) check(played []Lesson, lessons map[int]lessonEntry, chars charTable, words wordTable) []string {
	var errs []string
	for _, l := range played {
		entry := lessons[l.Number]
		inLesson := map[string]bool{}
		for _, v := range entry.Vocab {
			inLesson[v.H] = true
		}
		if b.d.opts.ReviewPrevious {
			for _, earlier := range played {
				if earlier.Number < l.Number {
					for _, v := range lessons[earlier.Number].Vocab {
						inLesson[v.H] = true
					}
				}
			}
		}
		if len(entry.Groups) == 0 {
			errs = append(errs, fmt.Sprintf("Lesson %d: no question groups at all.", l.Number))
		}
		for gi, g := range entry.Groups {
			tag := fmt.Sprintf("Lesson %d group %d", l.Number, gi+1)
			rows := append([]question{g.Example}, g.Items...)
			if len(g.Items) != 5 {
				errs = append(errs, tag+": fewer than 5 questions.")
			}
			if len(g.Opts) != groupSize || len(slices.Compact(sortedCopy(g.Opts))) != groupSize {
				errs = append(errs, tag+": the 6 components are not all different.")
			}
			var answers []string
			for _, r := range rows {
				answers = append(answers, r.Miss)
			}
			if !slices.Equal(sortedCopy(answers), sortedCopy(g.Opts)) {
				errs = append(errs, tag+": the answers differ from the 6 components on the tray.")
			}
			for _, r := range rows {
				runes := []rune(r.Word)
				ch := string(runes[r.Ci])
				if !inLesson[r.Word] {
					errs = append(errs, fmt.Sprintf("%s: word %s does not belong to lesson %d.", tag, r.Word, l.Number))
				}
				if syl, ok := words.syllables[r.Word]; !ok || len(syl) != len(runes) {
					errs = append(errs, fmt.Sprintf("%s: the syllables of %s have the wrong count.", tag, r.Word))
				}
				if spec, ok := b.glyphs[ch]; !ok || !spec.split || !slices.Contains(spec.names, r.Miss) {
					errs = append(errs, fmt.Sprintf("%s: character %s is not split into component %s.", tag, ch, r.Miss))
				}
				if part, ok := b.parts[r.Miss]; !ok {
					errs = append(errs, fmt.Sprintf("%s: missing component description for %s.", tag, r.Miss))
				} else {
					for field, value := range map[string]string{"name": part.Name, "vi": part.Vi, "py": part.Py} {
						if value == "" {
							errs = append(errs, fmt.Sprintf("%s: component %s is missing %q.", tag, r.Miss, field))
						}
					}
				}
				for _, c := range runes {
					if e, ok := chars.get(string(c)); !ok || e.Vi == "" {
						errs = append(errs, fmt.Sprintf("%s: character %c is missing its meaning.", tag, c))
					} else if e.Py == "" {
						errs = append(errs, fmt.Sprintf("%s: character %c is missing its pronunciation.", tag, c))
					}
				}
			}
		}
	}
	for c, e := range chars.entries {
		for _, p := range e.Parts {
			if _, ok := b.parts[p]; !ok {
				errs = append(errs, fmt.Sprintf("character %s: component %s has no description.", c, p))
			}
		}
	}
	for _, k := range b.partKeys {
		e := b.parts[k]
		if e.NoGlyph {
			if spec, ok := b.glyphs[e.From]; !ok || !spec.split || !slices.Contains(spec.names, k) {
				errs = append(errs, fmt.Sprintf("pseudo component %s: source character %s has no shape.", k, e.From))
			}
		}
	}
	slices.Sort(errs)
	return errs
}

func sortedCopy(s []string) []string {
	c := slices.Clone(s)
	slices.Sort(c)
	return c
}
