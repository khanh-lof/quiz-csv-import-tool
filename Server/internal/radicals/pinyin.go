package radicals

import (
	"slices"
	"strings"
	"unicode"

	"golang.org/x/text/unicode/norm"
)

var pinyinInitials = []string{"zh", "ch", "sh", "b", "p", "m", "f", "d", "t", "n", "l", "g", "k", "h", "j", "q", "x", "r", "z", "c", "s", "y", "w", ""}

var pinyinFinals = strings.Fields("a ai an ang ao e ei en eng er i ia ian iang iao ie in ing iong iu o ong ou u ua uai uan uang ue ui un uo v ve van vn " +
	"a ai an ang ao e ei en eng er o ou ong")

// pinyinSyllables are the strings accepted as one syllable when cutting a word's pinyin (pyseg.SYL).
var pinyinSyllables = func() map[string]bool {
	set := map[string]bool{}
	for _, initial := range pinyinInitials {
		for _, final := range pinyinFinals {
			syllable := initial + final
			if !strings.ContainsRune("iuv", rune(syllable[0])) {
				set[syllable] = true
			}
		}
	}
	for _, s := range strings.Fields("yi ya yao ye you yan yin yang ying yong yu yue yuan yun wu wa wo wai wei wan wen wang weng r ng m n hm") {
		set[s] = true
	}
	return set
}()

// baseLetters turns each letter of pinyin into its plain lower-case letter, with ü as v (pyseg.base). The result has
// one rune per rune of the NFC form of s.
func baseLetters(s string) []rune {
	var out []rune
	for _, c := range norm.NFC.String(s) {
		switch c {
		case 'ü', 'ǖ', 'ǘ', 'ǚ', 'ǜ':
			out = append(out, 'v')
			continue
		}
		decomposed := []rune(norm.NFD.String(string(c)))
		out = append(out, unicode.ToLower(decomposed[0]))
	}
	return out
}

func pinyinBase(s string) string { return string(baseLetters(s)) }

// toneless drops tone marks and lower-cases (grouping.toneless).
func toneless(s string) string {
	var b strings.Builder
	for _, c := range norm.NFD.String(s) {
		if !unicode.Is(unicode.Mn, c) {
			b.WriteRune(c)
		}
	}
	return strings.ReplaceAll(strings.ToLower(b.String()), "ü", "v")
}

var toneMarked = map[rune]bool{}

func init() {
	for _, c := range "āáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ" {
		toneMarked[c] = true
	}
}

func hasToneMark(s string) bool {
	for _, c := range s {
		if toneMarked[c] {
			return true
		}
	}
	return false
}

// SplitPinyin returns every way to cut pinyin into n syllables. A space or an apostrophe always cuts. Each way
// lists the syllables as written, tone marks kept.
func SplitPinyin(pinyin string, n int) [][]string {
	pinyin = norm.NFC.String(pinyin)
	parts := strings.FieldsFunc(pinyin, func(r rune) bool { return r == ' ' || r == '\'' || r == '’' })
	ways := [][]string{{}}
	for _, part := range parts {
		options := cutSyllables([]rune(part))
		var next [][]string
		for _, way := range ways {
			for _, option := range options {
				next = append(next, append(append([]string{}, way...), option...))
			}
		}
		ways = next
	}
	var out [][]string
	for _, way := range ways {
		if len(way) == n {
			out = append(out, way)
		}
	}
	return out
}

// SplitPinyinFor cuts the pinyin of a word into one syllable per character. When the letters cut in several ways
// (dàngāo: dàn·gāo or dàng·āo), the one way whose syllables are all readings of their characters wins, tones aside.
// Nil when no single way is left.
func SplitPinyinFor(hanzi, pinyin string) []string {
	chars := []rune(hanzi)
	ways := SplitPinyin(pinyin, len(chars))
	if len(ways) <= 1 {
		if len(ways) == 1 {
			return ways[0]
		}
		return nil
	}
	data, err := loadData()
	if err != nil {
		return nil
	}
	var fitting [][]string
	for _, way := range ways {
		fits := true
		for i, syllable := range way {
			base := pinyinBase(syllable)
			readings := data.readings(string(chars[i]))
			// 儿 may be the r-ending; a character the data does not know is no evidence either way.
			if chars[i] == '儿' && (base == "r" || base == "er") || len(readings) == 0 {
				continue
			}
			if !slices.ContainsFunc(readings, func(r string) bool { return pinyinBase(r) == base }) {
				fits = false
				break
			}
		}
		if fits {
			fitting = append(fitting, way)
		}
	}
	if len(fitting) != 1 {
		return nil
	}
	return fitting[0]
}

// cutSyllables lists the ways to cut one unbroken run of pinyin into syllables, longest first.
func cutSyllables(part []rune) [][]string {
	letters := baseLetters(string(part))
	var options [][]string
	var rec func(i int, current []string)
	rec = func(i int, current []string) {
		if i == len(letters) {
			options = append(options, current)
			return
		}
		for j := len(letters); j > i; j-- {
			syllable := string(letters[i:j])
			if pinyinSyllables[syllable] && (syllable != "r" || i > 0) {
				rec(j, append(append([]string{}, current...), string(part[i:j])))
			}
		}
	}
	rec(0, nil)
	return options
}
