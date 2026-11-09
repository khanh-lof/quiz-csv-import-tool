package csvgen

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"reflect"
	"slices"
	"strings"
	"testing"

	"quiz-csv-import-tool/server/internal/radicals"
)

// generatedRadicals generates the exercise of modelVocabulary through the fake model, with the model's tone of 借
// wrong, 讲 marked uncertain and 好人 left out for its pinyin.
func generatedRadicals(t *testing.T) Result {
	t.Helper()
	vocabulary := strings.Replace(modelVocabulary, `"pinyin":"jiè","syllables":["jiè"]`, `"pinyin":"jiē","syllables":["jiē"]`, 1)
	vocabulary = strings.Replace(vocabulary, `"meaning":"giảng"}`, `"meaning":"giảng","uncertain":true}`, 1)
	vocabulary = strings.Replace(vocabulary, `]}]}`, `,{"hanzi":"好人","pinyin":"xian","meaning":"người tốt"}]}]}`, 1)
	llm, _ := fakeRadicalsModel(t, vocabulary)
	c := NewClient(llm.URL, "key", "m", "", 0, slog.New(slog.DiscardHandler))
	result, err := c.Generate(context.Background(), nil, true, Options{
		ExportType: Radicals, CourseType: Other, CourseName: "Boya", LessonNumbers: []int{1},
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Source == "" {
		t.Fatal("a Radicals result has no source")
	}
	return result
}

// shownExercise is an exercise with what its page shows of each word (lesson 1), character and component.
type shownExercise struct {
	radicals.Exercise
	words  map[string]string
	chars  map[string]string
	parts  map[string]radicals.ComponentInfo
	groups string
}

func readExercise(t *testing.T, raw string) shownExercise {
	t.Helper()
	var ex shownExercise
	if err := json.Unmarshal([]byte(raw), &ex.Exercise); err != nil {
		t.Fatal(err)
	}
	var lessons map[string]struct {
		Vocab  []struct{ H, P, Vi string }
		Groups json.RawMessage
	}
	var chars map[string]struct{ Vi string }
	var parts map[string]struct{ Name, Py, Vi string }
	if json.Unmarshal(ex.Lessons, &lessons) != nil || json.Unmarshal(ex.Chars, &chars) != nil || json.Unmarshal(ex.Parts, &parts) != nil {
		t.Fatal("the exercise's tables do not read")
	}
	ex.words, ex.chars, ex.parts = map[string]string{}, map[string]string{}, map[string]radicals.ComponentInfo{}
	for _, v := range lessons["1"].Vocab {
		ex.words[v.H] = v.P + " " + v.Vi
	}
	ex.groups = string(lessons["1"].Groups)
	for c, e := range chars {
		ex.chars[c] = e.Vi
	}
	for c, e := range parts {
		ex.parts[c] = radicals.ComponentInfo{Name: e.Name, Pinyin: e.Py, Meaning: e.Vi}
	}
	return ex
}

func editOf(t *testing.T, source string) *RadicalsEdit {
	t.Helper()
	edit, err := RadicalsEditOf(source)
	if err != nil {
		t.Fatal(err)
	}
	return edit
}

func wordRow(t *testing.T, edit *RadicalsEdit, hanzi string) *EditWord {
	t.Helper()
	k := slices.IndexFunc(edit.Words, func(w EditWord) bool { return w.Hanzi == hanzi })
	if k < 0 {
		t.Fatalf("no row for %s in %+v", hanzi, edit.Words)
	}
	return &edit.Words[k]
}

func TestRadicalsEditOfAGeneratedExercise(t *testing.T) {
	result := generatedRadicals(t)
	ex := readExercise(t, result.CSV)
	edit := editOf(t, result.Source)

	// Every word the model wrote, and the one left out.
	if len(edit.Words) != 13 {
		t.Fatalf("%d word rows: %+v", len(edit.Words), edit.Words)
	}
	if w := *wordRow(t, edit, "图书馆"); !reflect.DeepEqual(w, EditWord{Hanzi: "图书馆", Lessons: []int{1}, Pinyin: "túshūguǎn", Meaning: "thư viện", AI: true}) {
		t.Errorf("图书馆 = %+v", w)
	}
	if w := wordRow(t, edit, "讲"); !w.Uncertain || w.Dropped {
		t.Errorf("讲 = %+v", w)
	}
	if w := *wordRow(t, edit, "好人"); !w.Dropped || w.Pinyin != "xian" || w.Meaning != "người tốt" || w.Problem != "" {
		t.Errorf("好人 = %+v", w)
	}
	if !slices.Contains(ex.Review.DroppedWords, "好人") || !slices.ContainsFunc(ex.Review.PinyinWarnings, func(w radicals.PinyinWarning) bool { return w.Word == "借" }) {
		t.Errorf("review = %+v", ex.Review)
	}

	// The characters and components the pools lack, with the notes the page shows.
	if len(edit.Chars) == 0 || len(edit.Components) == 0 {
		t.Fatalf("no character or component rows: %+v", edit)
	}
	for _, row := range edit.Chars {
		if !row.AI || row.Problem != "" || len(row.InWords) == 0 || row.Meaning != ex.chars[row.Char] || row.Meaning != "nghĩa "+row.Char {
			t.Errorf("character row %+v, page shows %q", row, ex.chars[row.Char])
		}
	}
	for _, row := range edit.Components {
		if !row.AI || row.Problem != "" || row.Meaning != "nghĩa" || row.Name != ex.parts[row.Component].Name {
			t.Errorf("component row %+v, page shows %+v", row, ex.parts[row.Component])
		}
	}
	if !reflect.DeepEqual(ex.Review.AIChars, sortedRows(edit.Chars, func(r EditChar) string { return r.Char })) {
		t.Errorf("review's characters %v", ex.Review.AIChars)
	}
}

func sortedRows[R any](rows []R, key func(R) string) []string {
	keys := make([]string, len(rows))
	for i, r := range rows {
		keys[i] = key(r)
	}
	slices.Sort(keys)
	return keys
}

func TestReviseRadicalsWithoutChangesBuildsTheSameExercise(t *testing.T) {
	result := generatedRadicals(t)
	again, edit, err := ReviseRadicals(result.Source, *editOf(t, result.Source))
	if err != nil || edit != nil {
		t.Fatalf("ReviseRadicals: %v %+v", err, edit)
	}
	if again.CSV != result.CSV || again.Source != result.Source {
		t.Fatal("the same table rebuilt another exercise")
	}
}

func TestReviseRadicalsAppliesCorrections(t *testing.T) {
	result := generatedRadicals(t)
	before := readExercise(t, result.CSV)
	edit := editOf(t, result.Source)
	wordRow(t, edit, "图书馆").Meaning = "nhà sách"
	wordRow(t, edit, "借").Pinyin = "jiè"
	wordRow(t, edit, "讲").Meaning = "  nói  "
	char, component := edit.Chars[0].Char, edit.Components[0].Component
	edit.Chars[0].Meaning = "nghĩa mới"
	edit.Components[0].Name, edit.Components[0].Pinyin, edit.Components[0].Meaning = "Bộ mới", "xīn", "mới"

	revised, flagged, err := ReviseRadicals(result.Source, *edit)
	if err != nil || flagged != nil {
		t.Fatalf("ReviseRadicals: %v %+v", err, flagged)
	}
	after := readExercise(t, revised.CSV)
	if after.words["图书馆"] != "túshūguǎn nhà sách" || after.words["借"] != "jiè mượn" || after.words["讲"] != "jiǎng nói" {
		t.Errorf("words = %v", after.words)
	}
	if after.chars[char] != "nghĩa mới" || after.parts[component] != (radicals.ComponentInfo{Name: "Bộ mới", Pinyin: "xīn", Meaning: "mới"}) {
		t.Errorf("%s = %q, %s = %+v", char, after.chars[char], component, after.parts[component])
	}
	// The same questions, and a review without what the teacher changed: 讲 is no longer uncertain, 借 has the
	// teacher's pinyin and no warning, and the character and component are the teacher's.
	if !reflect.DeepEqual(after.groups, before.groups) || len(after.groups) == 0 {
		t.Error("the corrections changed the groups")
	}
	review := after.Review
	if len(review.UncertainWords) != 0 || slices.ContainsFunc(review.PinyinWarnings, func(w radicals.PinyinWarning) bool { return w.Word == "借" }) ||
		slices.Contains(review.AIChars, char) || slices.Contains(review.AIComponents, component) || !slices.Contains(review.AIWords, "图书馆") {
		t.Errorf("review = %+v", review)
	}

	// The next table shows the corrections; a word keeps its AI mark while one of its notes is the model's.
	next := editOf(t, revised.Source)
	if w := *wordRow(t, next, "图书馆"); w.Meaning != "nhà sách" || !w.AI {
		t.Errorf("图书馆 = %+v", w)
	}
	if w := *wordRow(t, next, "讲"); w.Meaning != "nói" || w.Uncertain {
		t.Errorf("讲 = %+v", w)
	}
	if row := next.Chars[slices.IndexFunc(next.Chars, func(r EditChar) bool { return r.Char == char })]; row.AI || row.Meaning != "nghĩa mới" {
		t.Errorf("character row %+v", row)
	}
}

func TestReviseRadicalsRevivesADroppedWord(t *testing.T) {
	result := generatedRadicals(t)
	edit := editOf(t, result.Source)
	wordRow(t, edit, "好人").Pinyin = "hǎo rén"

	revised, flagged, err := ReviseRadicals(result.Source, *edit)
	if errors.Is(err, ErrIncomplete) {
		// The word may bring characters or components no note covers yet: the table asks for them.
		for i := range flagged.Chars {
			if flagged.Chars[i].Problem == ProblemMissing {
				flagged.Chars[i].Meaning = "nghĩa"
			}
		}
		for i := range flagged.Components {
			if flagged.Components[i].Problem == ProblemMissing {
				flagged.Components[i].Name, flagged.Components[i].Meaning = "Bộ", "nghĩa"
			}
		}
		if w := wordRow(t, flagged, "好人"); w.Dropped || w.Pinyin != "hǎo rén" {
			t.Fatalf("好人 in the flagged table = %+v", w)
		}
		revised, flagged, err = ReviseRadicals(result.Source, *flagged)
	}
	if err != nil {
		t.Fatalf("ReviseRadicals: %v %+v", err, flagged)
	}
	after := readExercise(t, revised.CSV)
	if after.words["好人"] != "hǎo rén người tốt" || len(after.Review.DroppedWords) != 0 {
		t.Fatalf("好人 = %q, dropped %v", after.words["好人"], after.Review.DroppedWords)
	}
	if w := wordRow(t, editOf(t, revised.Source), "好人"); w.Dropped {
		t.Errorf("好人 = %+v", w)
	}
}

func TestReviseRadicalsFlagsWhatItCannotBuild(t *testing.T) {
	result := generatedRadicals(t)
	edit := editOf(t, result.Source)
	wordRow(t, edit, "借").Pinyin = "jiexyz"
	edit.Chars[0].Meaning = " "
	edit.Components[0].Meaning = ""
	// A word whose meaning is cleared takes the pool's, and needs one only when the pool has none.
	var needsMeaning, poolMeaning string
	for i, row := range edit.Words {
		if row.Hanzi == "借" || row.Dropped {
			continue
		}
		if pool := radicals.PoolWordMeaning(row.Hanzi); pool == "" && needsMeaning == "" {
			needsMeaning, edit.Words[i].Meaning = row.Hanzi, ""
		} else if pool != "" && poolMeaning == "" {
			poolMeaning, edit.Words[i].Meaning = row.Hanzi, ""
		}
	}

	_, flagged, err := ReviseRadicals(result.Source, *edit)
	if !errors.Is(err, ErrIncomplete) {
		t.Fatalf("error = %v", err)
	}
	if w := wordRow(t, flagged, "借"); w.Problem != ProblemPinyin || w.Pinyin != "jiexyz" || w.Dropped {
		t.Errorf("借 = %+v", w)
	}
	if flagged.Chars[0].Problem != ProblemMissing || flagged.Components[0].Problem != ProblemMissing || flagged.Components[0].Name == "" {
		t.Errorf("character %+v, component %+v", flagged.Chars[0], flagged.Components[0])
	}
	if needsMeaning != "" {
		if w := wordRow(t, flagged, needsMeaning); w.Problem != ProblemMissing {
			t.Errorf("%s = %+v", needsMeaning, w)
		}
	}
	if poolMeaning != "" {
		if w := wordRow(t, flagged, poolMeaning); w.Problem != "" || w.Meaning != radicals.PoolWordMeaning(poolMeaning) {
			t.Errorf("%s = %+v", poolMeaning, w)
		}
	}
	for _, row := range flagged.Words {
		if row.Problem != "" && row.Hanzi != "借" && row.Hanzi != needsMeaning {
			t.Errorf("unexpected problem %+v", row)
		}
	}
}

func TestReviseRadicalsRefusals(t *testing.T) {
	result := generatedRadicals(t)
	long := strings.Repeat("a", maxEditNoteRunes+1)
	for name, corrections := range map[string]RadicalsEdit{
		"unknown word":        {Words: []EditWord{{Hanzi: "飞机", Pinyin: "fēijī", Meaning: "máy bay"}}},
		"long meaning":        {Words: []EditWord{{Hanzi: "借", Pinyin: "jiè", Meaning: long}}},
		"two characters":      {Chars: []EditChar{{Char: "图书", Meaning: "x"}}},
		"no character":        {Chars: []EditChar{{Char: "a", Meaning: "x"}}},
		"no component":        {Components: []EditComponent{{Component: " ", Meaning: "x"}}},
		"long component":      {Components: []EditComponent{{Component: "亻", Name: long, Meaning: "x"}}},
		"long character note": {Chars: []EditChar{{Char: "借", Meaning: long}}},
	} {
		if _, _, err := ReviseRadicals(result.Source, corrections); !errors.Is(err, ErrInvalidCorrections) {
			t.Errorf("%s: error = %v", name, err)
		}
	}

	// Without any pinyin, no word is left to group.
	edit := editOf(t, result.Source)
	var src radicalsSource
	if err := json.Unmarshal([]byte(result.Source), &src); err != nil {
		t.Fatal(err)
	}
	edit.Words = nil
	for _, w := range src.Lessons[0].Words {
		edit.Words = append(edit.Words, EditWord{Hanzi: w.Hanzi, Meaning: w.Meaning})
	}
	if _, _, err := ReviseRadicals(result.Source, *edit); !errors.Is(err, radicals.ErrNothingToPlay) {
		t.Fatalf("error = %v, want ErrNothingToPlay", err)
	}
}
