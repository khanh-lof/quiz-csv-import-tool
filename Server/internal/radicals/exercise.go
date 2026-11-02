package radicals

import (
	"bytes"
	"encoding/json"
)

// Exercise is everything the page needs except the glyph outlines, which RenderHTML draws from MMAH (keeping the
// stored JSON small). It round-trips through JSON.
type Exercise struct {
	Version      int                 `json:"version"` // 1
	Config       map[string]string   `json:"config"`  // the page's CFG: level, starTitle, starNote
	Title        string              `json:"title"`   // the page title, plain text
	Footer       string              `json:"footer"`  // HTML-escaped footer text
	Preset       string              `json:"preset"`
	Parts        json.RawMessage     `json:"parts"`        // PARTS: components, in insertion order
	Chars        json.RawMessage     `json:"chars"`        // CHARS
	Words        json.RawMessage     `json:"words"`        // WORDS: the syllables of each word
	Lessons      json.RawMessage     `json:"lessons"`      // LESSONS
	LessonTitles map[string]string   `json:"lessonTitles"` // LESSON_TITLES, the Chinese titles
	Glyphs       map[string][]string `json:"glyphs"`       // character to the component names drawn; "*" is the part no component owns, or the whole character when it is not split
	Review       Review              `json:"review"`
}

// Review is what the teacher should check; the client renders it in Vietnamese.
type Review struct {
	PinyinWarnings []PinyinWarning     `json:"pinyinWarnings"` // a syllable that is no reading of its character
	SkippedLessons []SkippedLesson     `json:"skippedLessons"` // lessons that could not be grouped
	UnusableWords  map[string][]string `json:"unusableWords"`  // lesson to the words that gave no question
	Groups         map[string]int      `json:"groups"`         // lesson to its number of groups
	MissingGlyphs  []string            `json:"missingGlyphs"`  // characters MMAH cannot draw, shown as text

	// The caller fills these in after Build; the engine leaves them empty.
	AIWords        []string `json:"aiWords"`        // words whose pinyin or meaning the model wrote
	UncertainWords []string `json:"uncertainWords"` // words the model flagged as uncertain
	DroppedWords   []string `json:"droppedWords"`   // words left out because they had no usable pinyin
	AIChars        []string `json:"aiChars"`        // characters whose meaning the model wrote
	AIComponents   []string `json:"aiComponents"`   // components the model described
}

// PinyinWarning is a syllable that is not any reading of its character: most likely a tone or syllable typo.
type PinyinWarning struct {
	Lesson   int      `json:"lesson"`
	Word     string   `json:"word"`
	Char     string   `json:"char"`
	Syllable string   `json:"syllable"`
	Readings []string `json:"readings"`
	// ToneOnly is true when the syllable's letters match a reading and only the tone differs. MMAH lacks some
	// readings of polyphonic characters, so these are the likelier false alarms.
	ToneOnly bool `json:"toneOnly,omitempty"`
}

// SkippedLesson is a lesson with too few usable words for a group.
type SkippedLesson struct {
	Lesson          int      `json:"lesson"`
	UsableWordCount int      `json:"usableWordCount"`
	UnusableWords   []string `json:"unusableWords"`
}

// Needs lists the language data Build still lacks, in first-seen order.
type Needs struct {
	Words      []WordNeed      `json:"words"`
	Chars      []CharNeed      `json:"chars"`
	Components []ComponentNeed `json:"components"`
}

// WordNeed is a word with no meaning.
type WordNeed struct {
	Hanzi  string `json:"hanzi"`
	Pinyin string `json:"pinyin"`
}

// CharNeed is a character with no meaning in the pool.
type CharNeed struct {
	Char             string   `json:"char"`
	InWords          []string `json:"inWords"`    // up to 4
	Definition       string   `json:"definition"` // MMAH's English definition
	DictionaryPinyin []string `json:"dictionaryPinyin"`
}

// ComponentNeed is a component that appears in the exercise with no description.
type ComponentNeed struct {
	Component        string   `json:"component"`
	InChars          []string `json:"inChars"` // up to 6
	Definition       string   `json:"definition"`
	DictionaryPinyin []string `json:"dictionaryPinyin"`
	EtymologyHint    string   `json:"etymologyHint"`
}

// Info is the answer to Needs, from the model or anyone. Pool data wins over Info for the same key, since the pool
// is curated; a word's own Meaning wins over both.
type Info struct {
	WordMeanings map[string]string // hanzi to Vietnamese
	CharMeanings map[string]string // character to a short Vietnamese meaning
	Components   map[string]ComponentInfo
}

// ComponentInfo describes a component.
type ComponentInfo struct {
	Name    string `json:"name"`    // Sino-Vietnamese name, e.g. "Giản"
	Pinyin  string `json:"pinyin"`  // with tone marks
	Meaning string `json:"meaning"` // Vietnamese
}

func (n Needs) empty() bool { return len(n.Words)+len(n.Chars)+len(n.Components) == 0 }

// objectWriter writes a JSON object keeping the order keys are added in.
type objectWriter struct {
	buf   bytes.Buffer
	count int
}

func newObjectWriter() *objectWriter {
	w := &objectWriter{}
	w.buf.WriteByte('{')
	return w
}

func (w *objectWriter) add(key string, value any) {
	if w.count > 0 {
		w.buf.WriteByte(',')
	}
	w.count++
	w.buf.Write(marshal(key))
	w.buf.WriteByte(':')
	w.buf.Write(marshal(value))
}

func (w *objectWriter) json() json.RawMessage {
	out := make([]byte, 0, w.buf.Len()+1)
	out = append(out, w.buf.Bytes()...)
	return append(out, '}')
}
