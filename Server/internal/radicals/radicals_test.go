package radicals

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"reflect"
	"slices"
	"strings"
	"testing"
)

// complete answers every need of the draft that info does not, with placeholders, and returns the info and how
// many answers it had to invent.
func complete(t testing.TB, d *Draft, info Info) (Info, int) {
	t.Helper()
	out := Info{WordMeanings: map[string]string{}, CharMeanings: map[string]string{}, Components: map[string]ComponentInfo{}}
	for k, v := range info.WordMeanings {
		out.WordMeanings[k] = v
	}
	for k, v := range info.CharMeanings {
		out.CharMeanings[k] = v
	}
	for k, v := range info.Components {
		out.Components[k] = v
	}
	invented := 0
	for round := 0; round < 4; round++ {
		needs := d.assemble(out).needs
		if needs.empty() {
			return out, invented
		}
		for _, w := range needs.Words {
			out.WordMeanings[w.Hanzi] = "nghĩa " + w.Hanzi
			invented++
		}
		for _, c := range needs.Chars {
			out.CharMeanings[c.Char] = "nghĩa " + c.Char
			invented++
		}
		for _, c := range needs.Components {
			out.Components[c.Component] = ComponentInfo{Name: "Tên " + c.Component, Pinyin: "pīn", Meaning: "nghĩa " + c.Component}
			invented++
		}
	}
	t.Fatal("needs do not settle")
	return out, invented
}

func planExample(t testing.TB) (*Draft, Info) {
	t.Helper()
	lessons, info, opts := loadExample(t)
	return mustPlan(t, lessons, opts), info
}

func mustPlan(t testing.TB, lessons []Lesson, opts Options) *Draft {
	t.Helper()
	d, err := Plan(lessons, opts)
	if err != nil {
		t.Fatal(err)
	}
	return d
}

func buildExample(t testing.TB) (*Draft, *Exercise) {
	t.Helper()
	d, info := planExample(t)
	info, _ = complete(t, d, info)
	ex, err := d.Build(info)
	if err != nil {
		t.Fatal(err)
	}
	return d, ex
}

type decodedLesson struct {
	Title string `json:"title"`
	Vocab []struct {
		H string `json:"h"`
		P string `json:"p"`
		V string `json:"vi"`
	} `json:"vocab"`
	Groups []struct {
		Example question   `json:"example"`
		Items   []question `json:"items"`
		Opts    []string   `json:"opts"`
	} `json:"groups"`
}

// TestExampleMirrorsStaticChecks ports check_data of the KIT as assertions on the example.
func TestExampleMirrorsStaticChecks(t *testing.T) {
	d, info := planExample(t)
	full, invented := complete(t, d, info)
	t.Logf("the example's own answers left %d needs to invent", invented)
	if needs := d.assemble(full).needs; !needs.empty() {
		t.Fatalf("needs after Info: %+v", needs)
	}
	ex, err := d.Build(full)
	if err != nil {
		t.Fatal(err)
	}

	var parts map[string]partEntry
	var chars map[string]charEntry
	var words map[string][]string
	var lessons map[string]decodedLesson
	for raw, target := range map[*json.RawMessage]any{&ex.Parts: &parts, &ex.Chars: &chars, &ex.Words: &words, &ex.Lessons: &lessons} {
		if err := json.Unmarshal(*raw, target); err != nil {
			t.Fatal(err)
		}
	}
	if len(lessons) != 3 {
		t.Fatalf("lessons: %d", len(lessons))
	}
	groups := 0
	for n, lesson := range lessons {
		inLesson := map[string]bool{}
		for _, v := range lesson.Vocab {
			inLesson[v.H] = true
		}
		if len(lesson.Groups) == 0 {
			t.Errorf("lesson %s has no groups", n)
		}
		for gi, g := range lesson.Groups {
			groups++
			tag := fmt.Sprintf("lesson %s group %d", n, gi+1)
			rows := append([]question{g.Example}, g.Items...)
			if len(g.Items) != 5 {
				t.Errorf("%s: %d items", tag, len(g.Items))
			}
			if len(g.Opts) != 6 || len(slices.Compact(sortedCopy(g.Opts))) != 6 {
				t.Errorf("%s: tray %v", tag, g.Opts)
			}
			var answers []string
			for _, r := range rows {
				answers = append(answers, r.Miss)
				runes := []rune(r.Word)
				ch := string(runes[r.Ci])
				if !inLesson[r.Word] {
					t.Errorf("%s: %s is not in the lesson", tag, r.Word)
				}
				if len(words[r.Word]) != len(runes) {
					t.Errorf("%s: syllables of %s: %v", tag, r.Word, words[r.Word])
				}
				if !slices.Contains(ex.Glyphs[ch], r.Miss) {
					t.Errorf("%s: %s is not split into %s: %v", tag, ch, r.Miss, ex.Glyphs[ch])
				}
				part, ok := parts[r.Miss]
				if !ok || part.Name == "" || part.Vi == "" || part.Py == "" {
					t.Errorf("%s: component %s: %+v", tag, r.Miss, part)
				}
				for _, c := range runes {
					if e, ok := chars[string(c)]; !ok || e.Vi == "" || e.Py == "" {
						t.Errorf("%s: character %c: %+v", tag, c, e)
					}
				}
			}
			if !slices.Equal(sortedCopy(answers), sortedCopy(g.Opts)) {
				t.Errorf("%s: answers %v are not the tray %v", tag, answers, g.Opts)
			}
		}
	}
	for c, e := range chars {
		for _, p := range e.Parts {
			if _, ok := parts[p]; !ok {
				t.Errorf("character %s: component %s has no description", c, p)
			}
		}
	}
	for k, e := range parts {
		if e.NoGlyph && !slices.Contains(ex.Glyphs[e.From], k) {
			t.Errorf("pseudo component %s: source %s has no shape", k, e.From)
		}
	}
	if ex.Review.Groups["1"] != len(lessons["1"].Groups) {
		t.Errorf("review groups: %v", ex.Review.Groups)
	}
	t.Logf("%d groups in 3 lessons; %d parts, %d chars, %d glyphs", groups, len(parts), len(chars), len(ex.Glyphs))
}

func TestBuildNeedsAnswers(t *testing.T) {
	d, _ := planExample(t)
	needs := d.Needs()
	if len(needs.Chars) == 0 || len(needs.Components) == 0 {
		t.Fatalf("a plan with no answers must need some: %+v", needs)
	}
	if _, err := d.Build(Info{}); err == nil || !strings.Contains(err.Error(), "still missing") {
		t.Fatalf("Build without answers: %v", err)
	}
	for _, c := range needs.Chars {
		if len(c.InWords) == 0 || len(c.InWords) > 4 || c.Definition == "" {
			t.Errorf("char need %+v", c)
		}
	}
	for _, c := range needs.Components {
		if len(c.InChars) == 0 || len(c.InChars) > 6 {
			t.Errorf("component need %+v", c)
		}
	}
}

func TestPoolWinsOverInfoAndMeaningWinsOverPool(t *testing.T) {
	lessons, info, opts := loadExample(t)
	lessons[0].Words = append(lessons[0].Words, Word{Hanzi: "你好", Pinyin: "nǐhǎo"})
	lessons[0].Words[1].Meaning = "mượn của giáo viên"
	d := mustPlan(t, lessons, opts)
	info, _ = complete(t, d, info)
	info.CharMeanings["爱"] = "không dùng"
	info.WordMeanings["你好"] = "không dùng"
	ex, err := d.Build(info)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(ex.Chars), "không dùng") || strings.Contains(string(ex.Lessons), "không dùng") {
		t.Error("an answer overrode curated data")
	}
	if !strings.Contains(string(ex.Lessons), "mượn của giáo viên") {
		t.Error("the word's own meaning was lost")
	}
}

func TestDeterministic(t *testing.T) {
	lessons, info, opts := loadExample(t)
	var results []string
	for range 2 {
		d := mustPlan(t, lessons, opts)
		full, _ := complete(t, d, info)
		ex, err := d.Build(full)
		if err != nil {
			t.Fatal(err)
		}
		raw, err := json.Marshal(ex)
		if err != nil {
			t.Fatal(err)
		}
		results = append(results, string(raw))
	}
	if results[0] != results[1] {
		t.Error("the same input gave different exercises")
	}
	other := opts
	other.Seed = 7
	if reflect.DeepEqual(mustPlan(t, lessons, other).groups, mustPlan(t, lessons, opts).groups) {
		t.Error("a different seed gave the same questions")
	}
}

func TestExerciseRoundTrips(t *testing.T) {
	_, ex := buildExample(t)
	ex.Review.AIWords = []string{"图书馆"}
	raw, err := json.Marshal(ex)
	if err != nil {
		t.Fatal(err)
	}
	var back Exercise
	if err := json.Unmarshal(raw, &back); err != nil {
		t.Fatal(err)
	}
	again, err := json.Marshal(&back)
	if err != nil {
		t.Fatal(err)
	}
	if string(raw) != string(again) {
		t.Error("the exercise changed in a JSON round trip")
	}
	before, err := RenderHTML(ex)
	if err != nil {
		t.Fatal(err)
	}
	after, err := RenderHTML(&back)
	if err != nil {
		t.Fatal(err)
	}
	if before != after {
		t.Error("the page changed in a JSON round trip")
	}
	for _, key := range []string{"aiWords", "uncertainWords", "droppedWords", "aiChars", "aiComponents"} {
		if !strings.Contains(string(raw), `"`+key+`"`) {
			t.Errorf("review lacks %s", key)
		}
	}
}

func TestPartsKeepInsertionOrder(t *testing.T) {
	_, ex := buildExample(t)
	dec := json.NewDecoder(strings.NewReader(string(ex.Parts)))
	var keys []string
	if _, err := dec.Token(); err != nil {
		t.Fatal(err)
	}
	for dec.More() {
		tok, _ := dec.Token()
		keys = append(keys, tok.(string))
		var skip json.RawMessage
		if err := dec.Decode(&skip); err != nil {
			t.Fatal(err)
		}
	}
	if len(keys) < 6 || slices.IsSorted(keys) {
		t.Errorf("parts keys look sorted, not in insertion order: %v", keys)
	}
}

func TestRenderHTML(t *testing.T) {
	_, ex := buildExample(t)
	page, err := RenderHTML(ex)
	if err != nil {
		t.Fatal(err)
	}
	for _, placeholder := range []string{"{{", "/*FONT_FACES*/", "/*THEME_OVERRIDE*/", "/*GLYPHS_JSON*/"} {
		if strings.Contains(page, placeholder) {
			t.Errorf("placeholder %s left", placeholder)
		}
	}
	data, _ := loadData()
	if got, want := strings.Count(page, "</script>"), strings.Count(data.head+data.logic, "</script>"); got != want {
		t.Errorf("</script> appears %d times, the template has %d", got, want)
	}
	for _, want := range []string{"<title>Ghép bộ thủ thành chữ Hán – Sơ trung cấp (thử)</title>", "lxgw-wenkai-webfont@1.7.0", "fonts.googleapis.com", "Từ vựng theo bảng từ vựng ví dụ."} {
		if !strings.Contains(page, want) {
			t.Errorf("page lacks %q", want)
		}
	}

	var lessons, want map[string]decodedLesson
	if err := json.Unmarshal(jsConstant(t, page, "LESSONS"), &lessons); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(ex.Lessons, &want); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(lessons, want) {
		t.Error("the page's LESSONS differ from the exercise's")
	}
	var glyphs map[string]map[string]string
	if err := json.Unmarshal(jsConstant(t, page, "GLYPHS"), &glyphs); err != nil {
		t.Fatal(err)
	}
	for n, lesson := range lessons {
		for gi, g := range lesson.Groups {
			for _, q := range append([]question{g.Example}, g.Items...) {
				ch := string([]rune(q.Word)[q.Ci])
				path := glyphs[ch][q.Miss]
				if !strings.HasPrefix(path, "M") || !strings.HasSuffix(path, "Z") {
					t.Errorf("lesson %s group %d: glyph of %s lacks the path of %s: %q", n, gi+1, ch, q.Miss, path)
				}
			}
		}
	}
	for c, names := range ex.Glyphs {
		for _, name := range names {
			if name != "*" && glyphs[c][name] == "" {
				t.Errorf("glyph %s lacks %s", c, name)
			}
		}
	}
	if !strings.Contains(page, ":root{--paper:#fff;") || !strings.Contains(page, "--jade:#0e7a67") {
		t.Error("no theme override")
	}
}

// jsConstant returns the JSON of `const NAME = ...;` of a page.
func jsConstant(t testing.TB, page, name string) []byte {
	t.Helper()
	marker := "const " + name + " = "
	start := strings.Index(page, marker)
	if start < 0 {
		t.Fatalf("no const %s", name)
	}
	rest := page[start+len(marker):]
	end := strings.Index(rest, ";\n")
	if end < 0 {
		t.Fatalf("const %s is not closed", name)
	}
	return []byte(rest[:end])
}

func TestRenderHTMLIsScriptSafe(t *testing.T) {
	lessons, info, opts := loadExample(t)
	lessons[0].TitleVi = `</script><script>alert(1)</script> & "x"`
	lessons[0].TitleZh = "学习\u2028<!--"
	opts.PageTitle = `<b>"A" & 'B'</b>`
	opts.VocabSource = `a </script> b`
	d := mustPlan(t, lessons, opts)
	info, _ = complete(t, d, info)
	info.Components["奴"] = ComponentInfo{Name: "</script>", Pinyin: "nú", Meaning: "<img src=x>"}
	ex, err := d.Build(info)
	if err != nil {
		t.Fatal(err)
	}
	page, err := RenderHTML(ex)
	if err != nil {
		t.Fatal(err)
	}
	data, _ := loadData()
	if got, want := strings.Count(page, "</script>"), strings.Count(data.head+data.logic, "</script>"); got != want {
		t.Errorf("</script> appears %d times, the template has %d", got, want)
	}
	for name, bad := range map[string]bool{
		"U+2028":   strings.Contains(page, "\u2028"),
		"img":      strings.Contains(page, "<img src=x>"),
		"title":    strings.Contains(page, `<b>"A"`),
		"comments": strings.Count(page, "<!--") != strings.Count(data.head+data.logic, "<!--"),
	} {
		if bad {
			t.Errorf("unescaped %s in the page", name)
		}
	}
	if !strings.Contains(page, "&lt;b&gt;&quot;A&quot; &amp; &#x27;B&#x27;&lt;/b&gt;") {
		t.Error("the title is not escaped like html.escape")
	}
	if !strings.Contains(ex.Footer, "a &lt;/script&gt; b") {
		t.Errorf("footer %q", ex.Footer)
	}
}

func TestUnknownPreset(t *testing.T) {
	lessons, _, opts := loadExample(t)
	opts.Preset = "neon"
	if _, err := Plan(lessons, opts); err == nil || !strings.Contains(err.Error(), "neon") {
		t.Errorf("Plan: %v", err)
	}
	for _, p := range Presets() {
		opts.Preset = p
		if _, err := Plan(lessons, opts); err != nil {
			t.Errorf("preset %s: %v", p, err)
		}
	}
	if got := Presets()[0]; got != "jade" {
		t.Errorf("first preset %s", got)
	}
}

type pythonGolden struct {
	Themes map[string]string `json:"themes"`
	Pinyin []struct {
		In  string     `json:"in"`
		N   int        `json:"n"`
		Out [][]string `json:"out"`
	} `json:"pinyin"`
}

func readGolden(t testing.TB) pythonGolden {
	t.Helper()
	raw, err := os.ReadFile("testdata/python_golden.json")
	if err != nil {
		t.Fatal(err)
	}
	var golden pythonGolden
	if err := json.Unmarshal(raw, &golden); err != nil {
		t.Fatal(err)
	}
	return golden
}

func TestThemeMatchesPython(t *testing.T) {
	golden := readGolden(t)
	for _, p := range Presets() {
		got, err := themeCSS(p)
		if err != nil {
			t.Fatal(err)
		}
		if got != golden.Themes[p] {
			t.Errorf("preset %s:\n got %s\nwant %s", p, got, golden.Themes[p])
		}
	}
}

func TestSplitPinyin(t *testing.T) {
	for _, c := range readGolden(t).Pinyin {
		got := SplitPinyin(c.In, c.N)
		if len(got) != len(c.Out) || (len(got) > 0 && !reflect.DeepEqual(got, c.Out)) {
			t.Errorf("SplitPinyin(%q, %d) = %v, Python gives %v", c.In, c.N, got, c.Out)
		}
	}

	cases := []struct {
		in   string
		n    int
		want [][]string
	}{
		{"túshūguǎn", 3, [][]string{{"tú", "shū", "guǎn"}}},
		{"túshūguǎn", 1, nil},
		{"xian", 1, [][]string{{"xian"}}},
		{"xian", 2, [][]string{{"xia", "n"}, {"xi", "an"}}},
		{"nǚ'ér", 2, [][]string{{"nǚ", "ér"}}},
		{"nǚér", 2, [][]string{{"nǚé", "r"}, {"nǚ", "ér"}}},
		{"huār", 2, [][]string{{"huā", "r"}}},
		{"bù xíng", 2, [][]string{{"bù", "xíng"}}},
	}
	for _, c := range cases {
		if got := SplitPinyin(c.in, c.n); len(got) != len(c.want) || (len(got) > 0 && !reflect.DeepEqual(got, c.want)) {
			t.Errorf("SplitPinyin(%q, %d) = %v, want %v", c.in, c.n, got, c.want)
		}
	}
}

func TestSplitPinyinFor(t *testing.T) {
	for _, c := range []struct {
		hanzi, pinyin string
		want          []string
	}{
		{"蛋糕", "dàngāo", []string{"dàn", "gāo"}},
		{"西安", "xian", []string{"xi", "an"}},
		{"图书馆", "túshūguǎn", []string{"tú", "shū", "guǎn"}},
		{"一会儿", "yíhuìr", []string{"yí", "huì", "r"}},
		{"好人", "xian", nil},
		{"好", "hǎohǎo", nil},
	} {
		if got := SplitPinyinFor(c.hanzi, c.pinyin); !reflect.DeepEqual(got, c.want) {
			t.Errorf("SplitPinyinFor(%s, %s) = %v, want %v", c.hanzi, c.pinyin, got, c.want)
		}
	}
}

func TestIsHanzi(t *testing.T) {
	for s, want := range map[string]bool{"图书馆": true, "𠂇": true, "㐀": true, "": false, "图 书": false, "tu": false, "图1": false, "あ": false, "𠀀": true} {
		if IsHanzi(s) != want {
			t.Errorf("IsHanzi(%q) = %v", s, !want)
		}
	}
}

func TestPinyinWarnings(t *testing.T) {
	data, err := loadData()
	if err != nil {
		t.Fatal(err)
	}
	words := []Word{
		{Hanzi: "借", Syllables: []string{"jiě"}},        // wrong tone
		{Hanzi: "好", Syllables: []string{"hēi"}},        // wrong letters
		{Hanzi: "好", Syllables: []string{"hǎo"}},        // right
		{Hanzi: "不对", Syllables: []string{"bú", "duì"}}, // sandhi
		{Hanzi: "一起", Syllables: []string{"yì", "qǐ"}},  // sandhi
		{Hanzi: "花儿", Syllables: []string{"huā", "r"}},  // erhua
		{Hanzi: "女儿", Syllables: []string{"nǚ", "er"}},
		{Hanzi: "桌子", Syllables: []string{"zhuō", "zi"}}, // neutral tone
		{Hanzi: "觉得", Syllables: []string{"jué", "de"}},
		{Hanzi: "睡觉", Syllables: []string{"shuì", "jiào"}}, // a pool reading MMAH may lack
		{Hanzi: "借", Syllables: []string{"jiě"}},           // reported once
	}
	b := &builder{data: data}
	for _, w := range words {
		w.Pinyin = strings.Join(w.Syllables, "")
		b.lw = append(b.lw, lessonWordRef{lesson: 1, word: w})
	}
	var got []string
	for _, w := range b.checkPinyin() {
		got = append(got, fmt.Sprintf("%s %s %s %v", w.Word, w.Char, w.Syllable, w.ToneOnly))
	}
	want := []string{"借 借 jiě true", "好 好 hēi false"}
	if !slices.Equal(got, want) {
		t.Errorf("warnings %q, want %q", got, want)
	}
}

func TestPinyinWarningsReachTheReview(t *testing.T) {
	lessons, info, opts := loadExample(t)
	lessons[0].Words[1].Pinyin = "jiě"
	d := mustPlan(t, lessons, opts)
	info, _ = complete(t, d, info)
	ex, err := d.Build(info)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, w := range ex.Review.PinyinWarnings {
		found = found || w.Word == "借" && w.Syllable == "jiě" && slices.Equal(w.Readings, []string{"jiè"}) && w.ToneOnly
	}
	if !found {
		t.Errorf("no warning for 借: %+v", ex.Review.PinyinWarnings)
	}
}

func TestShortLessonsAreSkippedUnlessReviewFillsThem(t *testing.T) {
	lessons, info, opts := loadExample(t)
	short := Lesson{Number: 4, TitleZh: "短", Words: []Word{lessons[1].Words[0], lessons[1].Words[1], lessons[1].Words[2]}}
	lessons = append(lessons, short)

	d := mustPlan(t, lessons, opts)
	if len(d.skipped) != 1 || d.skipped[0].Lesson != 4 || d.skipped[0].UsableWordCount > 3 {
		t.Fatalf("skipped: %+v", d.skipped)
	}
	full, _ := complete(t, d, info)
	ex, err := d.Build(full)
	if err != nil {
		t.Fatal(err)
	}
	if len(ex.Review.SkippedLessons) != 1 || ex.Review.Groups["4"] != 0 || len(ex.LessonTitles) != 3 {
		t.Errorf("review: %+v titles %v", ex.Review, ex.LessonTitles)
	}

	opts.ReviewPrevious = true
	d = mustPlan(t, lessons, opts)
	if len(d.skipped) != 0 {
		t.Fatalf("with ReviewPrevious the lesson should be filled: %+v", d.skipped)
	}
	if len(d.groups[4]) != 1 {
		t.Errorf("groups of lesson 4: %d", len(d.groups[4]))
	}
	full, _ = complete(t, d, info)
	if _, err := d.Build(full); err != nil {
		t.Fatal(err)
	}
}

func TestNothingToPlay(t *testing.T) {
	lessons := []Lesson{{Number: 1, Words: []Word{{Hanzi: "你好", Pinyin: "nǐhǎo", Meaning: "xin chào"}, {Hanzi: "我", Pinyin: "wǒ", Meaning: "tôi"}}}}
	d, err := Plan(lessons, Options{})
	if err != nil {
		t.Fatal(err)
	}
	if len(d.skipped) != 1 {
		t.Fatalf("skipped: %+v", d.skipped)
	}
	if !d.Needs().empty() {
		t.Error("a draft with nothing to play needs nothing")
	}
	if _, err := d.Build(Info{}); !errors.Is(err, ErrNothingToPlay) {
		t.Errorf("Build: %v", err)
	}
}

func TestPlanValidation(t *testing.T) {
	ok := Word{Hanzi: "图书馆", Pinyin: "túshūguǎn", Meaning: "thư viện"}
	cases := map[string]struct {
		lessons []Lesson
		want    string
	}{
		"no lessons":       {nil, "No lessons"},
		"non-hanzi":        {[]Lesson{{Number: 1, Words: []Word{{Hanzi: "tu 图", Pinyin: "tu"}}}}, `Lesson 1, word #1 "tu 图"`},
		"duplicate word":   {[]Lesson{{Number: 2, Words: []Word{ok, ok}}}, `Lesson 2, word #2 "图书馆": duplicated`},
		"duplicate lesson": {[]Lesson{{Number: 1, Words: []Word{ok}}, {Number: 1, Words: []Word{ok}}}, "Lesson 1 is declared twice"},
		"bad number":       {[]Lesson{{Number: 0, Words: []Word{ok}}}, "must be positive"},
		"no words":         {[]Lesson{{Number: 3}}, "Lesson 3 has no words"},
		"missing pinyin":   {[]Lesson{{Number: 1, Words: []Word{{Hanzi: "图"}}}}, "missing pinyin"},
		"syllable count":   {[]Lesson{{Number: 1, Words: []Word{{Hanzi: "图书馆", Pinyin: "túshūguǎn", Syllables: []string{"tú", "shū"}}}}}, "syllables must be exactly 3"},
		"ambiguous pinyin": {[]Lesson{{Number: 1, Words: []Word{{Hanzi: "西安", Pinyin: "xian"}}}}, "exactly one way"},
	}
	for name, c := range cases {
		if _, err := Plan(c.lessons, Options{}); err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s: error %v, want it to contain %q", name, err, c.want)
		}
	}

	explicit := Word{Hanzi: "西安", Pinyin: "xian", Syllables: []string{"xī", "ān"}, Meaning: "Tây An", ProperNoun: true}
	d, err := Plan([]Lesson{{Number: 5, Words: []Word{explicit}}, {Number: 2, Words: []Word{ok}}}, Options{})
	if err != nil {
		t.Fatal(err)
	}
	if d.lessons[0].Number != 2 || d.lessons[1].Words[0].Syllables[0] != "xī" || d.lessons[0].Words[0].Syllables[2] != "guǎn" {
		t.Errorf("lessons %+v", d.lessons)
	}
}

func TestEmbeddedData(t *testing.T) {
	data, err := loadData()
	if err != nil {
		t.Fatal(err)
	}
	if len(data.gb2312Level1) != 3755 || len(data.poolChars) != 394 || len(data.poolComponents) != 236 || len(data.commonChars) != 1000 {
		t.Errorf("sizes: gb2312 %d, pool chars %d, pool components %d, common %d", len(data.gb2312Level1), len(data.poolChars), len(data.poolComponents), len(data.commonChars))
	}
	for c := range data.gb2312Level1 {
		if data.entries[c] == nil {
			t.Fatalf("GB2312 character %s is missing from MMAH", c)
		}
	}
	for c, e := range data.entries {
		if n := len(data.strokes(c)); n != len(e.Matches) {
			t.Fatalf("%s: %d strokes, %d matches", c, n, len(e.Matches))
		}
	}
	for comp, p := range data.poolComponents {
		if p.NoGlyph && pseudoComponents[comp] == "" {
			t.Errorf("pool component %s is noGlyph but not a pseudo component", comp)
		}
	}
	for c, p := range data.poolChars {
		if p.Vietnamese == "" || p.Pinyin == "" {
			t.Errorf("pool char %s: %+v", c, p)
		}
	}
}

// TestMatchesPythonReference compares what does not depend on the random numbers with the Python KIT run on the same
// data: the components that may be hidden in each GB2312 level 1 character, and for the example's words the options,
// their costs and the conflicts between them (testdata/python_reference.json, from the KIT's own analysis.py and
// grouping.py with every splittable character counted as good).
func TestMatchesPythonReference(t *testing.T) {
	raw, err := os.ReadFile("testdata/python_reference.json")
	if err != nil {
		t.Fatal(err)
	}
	var ref struct {
		Cand     map[string][]string `json:"cand"`
		Options  map[string][][]any  `json:"options"`
		Cost     map[string]float64  `json:"cost"`
		Conflict map[string]int      `json:"conflict"`
	}
	if err := json.Unmarshal(raw, &ref); err != nil {
		t.Fatal(err)
	}
	d, _ := planExample(t)
	a := d.analysis
	for c, want := range ref.Cand {
		if got := a.candidates(c); len(got) != len(want) || (len(got) > 0 && !slices.Equal(got, want)) {
			t.Errorf("candidates of %s: %v, Python gives %v", c, got, want)
		}
	}
	g := newGrouper(a, map[int][]lessonWord{}, false, 1, 1)
	conflicts := map[string]int{}
	for _, l := range d.lessons {
		var all []option
		for _, w := range l.Words {
			opts := g.optionsFor(w.Hanzi)
			all = append(all, opts...)
			if len(opts) != len(ref.Options[w.Hanzi]) {
				t.Errorf("options of %s: %d, Python gives %d", w.Hanzi, len(opts), len(ref.Options[w.Hanzi]))
			}
			for _, o := range opts {
				key := fmt.Sprintf("%s|%d|%s", o.word, o.ci, o.hide)
				if want, ok := ref.Cost[key]; !ok || math.Abs(want-g.cost(o)) > 1e-9 {
					t.Errorf("cost of %s: %v, Python gives %v", key, g.cost(o), want)
				}
			}
		}
		for _, x := range all {
			for _, y := range all {
				if x != y {
					if k := g.conflictKind(x, y); k != 0 {
						conflicts[fmt.Sprintf("%s|%d|%s#%s|%d|%s", x.word, x.ci, x.hide, y.word, y.ci, y.hide)] = k
					}
				}
			}
		}
	}
	if !reflect.DeepEqual(conflicts, ref.Conflict) {
		t.Errorf("conflicts differ from Python's: %d here, %d there", len(conflicts), len(ref.Conflict))
	}
}
