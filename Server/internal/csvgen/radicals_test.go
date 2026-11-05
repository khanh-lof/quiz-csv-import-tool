package csvgen

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"reflect"
	"slices"
	"strings"
	"sync"
	"testing"

	"quiz-csv-import-tool/server/internal/radicals"
)

func TestLessonVocabulary(t *testing.T) {
	doc := `# 《新HSK教程2》 Lesson 7 — 他篮球打得很好
English: He plays basketball very well · Tiếng Việt: Anh ấy chơi bóng rổ rất giỏi

## New words
| Word | Pinyin | POS | English | Tiếng Việt | Note |
|---|---|---|---|---|---|
| 图书馆 | túshūguǎn | n. | library | thư viện | |
| 南（方） | nán (fāng) | n. | south | phía nam | |
| 聊天（儿） | liáotiān (r) | v. | chat | tán gẫu | |
| 一……就…… | yī… jiù… | conj. | as soon as | hễ … là … | |
| 谁 | shéi/shuí | pron. | who | ai | |
| 红绿灯 | hóng-lǜdēng | n. | traffic light | đèn giao thông | ★ |
| 图书馆 | túshūguǎn | n. | library | thư viện | |

## Proper nouns
| Word | Pinyin | English | Tiếng Việt |
|---|---|---|---|
| 陈天中 | Chén Tiānzhōng | Chen Tianzhong (a name) | Trần Thiên Trung (tên người) |

## Texts
| 不是 | bú shì | x | y | z | |
`
	got := lessonVocabulary(normalizePrompt(doc))
	want := []radicals.Word{
		{Hanzi: "图书馆", Pinyin: "túshūguǎn", Syllables: []string{"tú", "shū", "guǎn"}, Meaning: "thư viện"},
		{Hanzi: "南方", Pinyin: "nánfāng", Syllables: []string{"nán", "fāng"}, Meaning: "phía nam"},
		{Hanzi: "聊天", Pinyin: "liáotiān", Syllables: []string{"liáo", "tiān"}, Meaning: "tán gẫu"},
		{Hanzi: "一", Pinyin: "yī", Syllables: []string{"yī"}},
		{Hanzi: "就", Pinyin: "jiù", Syllables: []string{"jiù"}},
		{Hanzi: "谁", Pinyin: "shéi", Syllables: []string{"shéi"}, Meaning: "ai"},
		{Hanzi: "红绿灯", Pinyin: "hónglǜdēng", Syllables: []string{"hóng", "lǜ", "dēng"}, Meaning: "đèn giao thông", Star: true},
		{Hanzi: "陈天中", Pinyin: "Chén Tiānzhōng", Syllables: []string{"Chén", "Tiān", "zhōng"}, Meaning: "Trần Thiên Trung (tên người)", ProperNoun: true},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("lessonVocabulary:\n got %+v\nwant %+v", got, want)
	}
	if zh, vi := lessonTitles(normalizePrompt(doc)); zh != "他篮球打得很好" || vi != "Anh ấy chơi bóng rổ rất giỏi" {
		t.Fatalf("lessonTitles = %q, %q", zh, vi)
	}
}

// Every word of every embedded book must come with its reading, cut into syllables, so a textbook lesson never
// needs the vocabulary request.
func TestTextbookLessonsGiveRadicalsWords(t *testing.T) {
	for _, book := range books {
		if !book.courseType.Teaches(Chinese) {
			continue // Radicals is only for Chinese
		}
		for n, doc := range book.docs {
			words := lessonVocabulary(doc)
			if len(words) == 0 {
				t.Errorf("%s lesson %d: no word", book.dir, n+1)
				continue
			}
			for _, word := range words {
				if !hasReading(word) {
					t.Errorf("%s lesson %d: %s [%s] has no unique syllable split", book.dir, n+1, word.Hanzi, word.Pinyin)
				}
			}
		}
	}
}

func TestMergeVocabulary(t *testing.T) {
	lessons := []radicalsLesson{
		{Number: 1, Words: []radicalsWord{
			{Word: radicals.Word{Hanzi: "借"}},
			{Word: radicals.Word{Hanzi: "图书馆", Pinyin: "túshūguǎn", Syllables: []string{"tú", "shū", "guǎn"}, Meaning: "thư viện"}},
			{Word: radicals.Word{Hanzi: "还"}},
		}, source: wordsFromBook},
		{Number: 2, source: wordsFromModel},
	}
	answer := vocabularyAnswer{Lessons: []vocabularyLesson{
		{Number: 1, TitleZh: "学习", Words: []vocabularyWord{
			{Hanzi: "还", Pinyin: "huán", Syllables: []string{"huán"}, Meaning: "trả lại", Uncertain: true},
			{Hanzi: "借", Pinyin: "jiè", Syllables: []string{"jiè"}, Meaning: "mượn"},
			{Hanzi: "图书馆", Pinyin: "wrong", Meaning: "wrong"},
			{Hanzi: "多余", Pinyin: "duōyú", Syllables: []string{"duō", "yú"}, Meaning: "thừa"},
		}},
		{Number: 2, Words: []vocabularyWord{
			{Hanzi: "复习", Pinyin: "fùxí", Syllables: []string{"fù", "xí"}, Meaning: "ôn tập"},
			{Hanzi: "fuxi", Pinyin: "fùxí", Meaning: "ôn tập"},
			{Hanzi: "作业", Pinyin: "zuòyè", Syllables: []string{"zuò"}, Meaning: "bài tập"},
			{Hanzi: "好人", Pinyin: "xian", Meaning: "người tốt"},
			{Hanzi: "复习", Pinyin: "fùxí", Syllables: []string{"fù", "xí"}, Meaning: "ôn tập"},
		}},
	}}
	got := mergeVocabulary(lessons, answer)

	hanzi := func(words []radicalsWord) []string {
		var out []string
		for _, w := range words {
			out = append(out, w.Hanzi)
		}
		return out
	}
	// The textbook's words, in its order, nothing added, and what was known kept.
	if h := hanzi(got[0].Words); !reflect.DeepEqual(h, []string{"借", "图书馆", "还"}) {
		t.Fatalf("lesson 1 words = %v", h)
	}
	if got[0].Words[1].Meaning != "thư viện" || got[0].Words[0].Meaning != "mượn" || got[0].TitleZh != "学习" {
		t.Fatalf("lesson 1 = %+v", got[0])
	}
	// Where each note came from: the model filled in 借 and 还, and was unsure of 还; the textbook's 图书馆 is kept.
	flags := func(w radicalsWord) [3]bool { return [3]bool{w.AIPinyin, w.AIMeaning, w.Uncertain} }
	if f := flags(got[0].Words[0]); f != [3]bool{true, true, false} {
		t.Errorf("借 flags = %v", f)
	}
	if f := flags(got[0].Words[1]); f != [3]bool{} {
		t.Errorf("图书馆 flags = %v", f)
	}
	if f := flags(got[0].Words[2]); f != [3]bool{true, true, true} {
		t.Errorf("还 flags = %v", f)
	}
	// The model's list minus what is no word, with a pinyin that splits on its own kept, and an unsplittable one kept
	// without a reading, to be left out of the exercise.
	if h := hanzi(got[1].Words); !reflect.DeepEqual(h, []string{"复习", "作业", "好人"}) {
		t.Fatalf("lesson 2 words = %v", h)
	}
	if !reflect.DeepEqual(got[1].Words[1].Syllables, []string{"zuò", "yè"}) {
		t.Fatalf("作业 syllables = %v", got[1].Words[1].Syllables)
	}
	if w := got[1].Words[2]; hasReading(w.Word) || w.Pinyin != "xian" || w.Meaning != "người tốt" || !w.AIPinyin {
		t.Fatalf("好人 = %+v", w)
	}

	src := &radicalsSource{Lessons: got, AIChars: []string{"借"}}
	var review radicals.Review
	src.fillReview(&review)
	if !reflect.DeepEqual(review.AIWords, []string{"借", "还", "复习", "作业"}) || !reflect.DeepEqual(review.UncertainWords, []string{"还"}) ||
		!reflect.DeepEqual(review.DroppedWords, []string{"好人"}) || !reflect.DeepEqual(review.AIChars, []string{"借"}) ||
		review.AIComponents == nil {
		t.Fatalf("review = %+v", review)
	}
}

func TestDecodeJSONAnswer(t *testing.T) {
	var v struct{ A int }
	for _, text := range []string{`{"A":1}`, "```json\n{\"A\":1}\n```", "Here it is: {\"A\":1} done"} {
		v.A = 0
		if err := decodeJSONAnswer(text, &v); err != nil || v.A != 1 {
			t.Errorf("decodeJSONAnswer(%q) = %v, %v", text, v, err)
		}
	}
	if err := decodeJSONAnswer("no json", &v); err == nil {
		t.Error("want an error for an answer without JSON")
	}
}

// fakeRadicalsModel answers the two requests of a Radicals job: the vocabulary request with vocabulary, and the
// details request with a note for everything it asks about.
func fakeRadicalsModel(t *testing.T, vocabulary string) (*httptest.Server, *[]string) {
	var mu sync.Mutex
	var calls []string
	llm := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req responsesRequest
		body, _ := io.ReadAll(r.Body)
		if err := json.Unmarshal(body, &req); err != nil {
			t.Errorf("request: %v", err)
		}
		text := req.Input[0].Content[0].Text
		var answer string
		if strings.Contains(req.Instructions, "need short Vietnamese notes") || strings.Contains(req.Instructions, "needs short Vietnamese notes") {
			mu.Lock()
			calls = append(calls, "details")
			mu.Unlock()
			var needs radicals.Needs
			if err := json.Unmarshal([]byte(text[strings.Index(text, "{"):]), &needs); err != nil {
				t.Errorf("details payload: %v", err)
			}
			out := detailsAnswer{Words: map[string]string{}, Chars: map[string]string{}, Components: map[string]radicals.ComponentInfo{}}
			for _, w := range needs.Words {
				out.Words[w.Hanzi] = "nghĩa " + w.Hanzi
			}
			for _, c := range needs.Chars {
				out.Chars[c.Char] = "nghĩa " + c.Char
			}
			for _, c := range needs.Components {
				out.Components[c.Component] = radicals.ComponentInfo{Name: "Bộ " + c.Component, Pinyin: "—", Meaning: "nghĩa"}
			}
			b, _ := json.Marshal(out)
			answer = string(b)
		} else {
			mu.Lock()
			calls = append(calls, "vocabulary")
			mu.Unlock()
			answer = vocabulary
		}
		reply, _ := json.Marshal(map[string]any{"status": "completed", "output": []any{
			map[string]any{"type": "message", "content": []any{map[string]any{"type": "output_text", "text": answer}}},
		}})
		_, _ = w.Write(reply)
	}))
	t.Cleanup(llm.Close)
	return llm, &calls
}

func TestGenerateRadicalsFromTextbook(t *testing.T) {
	llm, calls := fakeRadicalsModel(t, `{"lessons":[]}`)
	level := 1
	c := NewClient(llm.URL, "key", "m", nil, 0, slog.New(slog.DiscardHandler))
	result, err := c.Generate(context.Background(), nil, true, Options{
		ExportType: Radicals, CourseType: Hsk, HskStandard: Hsk3, Level: &level, LessonNumbers: []int{5, 6},
	})
	if err != nil {
		t.Fatal(err)
	}
	var exercise radicals.Exercise
	if err := json.Unmarshal([]byte(result.CSV), &exercise); err != nil {
		t.Fatalf("result is not an exercise: %v", err)
	}
	if exercise.LessonTitles["5"] == "" {
		t.Errorf("lesson 5 has no title: %v", exercise.LessonTitles)
	}
	if _, err := radicals.RenderHTML(&exercise); err != nil {
		t.Fatalf("RenderHTML: %v", err)
	}
	// The book gives every word with its reading and meaning, and the pools cover most characters: at most the
	// details request is needed.
	if slices.Contains(*calls, "vocabulary") {
		t.Errorf("calls = %v, want no vocabulary request for a textbook lesson", *calls)
	}
}

// modelVocabulary is the model's answer to the vocabulary request for a lesson of 12 words.
const modelVocabulary = `{"lessons":[{"number":1,"titleZh":"","titleVi":"","words":[` +
	`{"hanzi":"图书馆","pinyin":"túshūguǎn","syllables":["tú","shū","guǎn"],"meaning":"thư viện"},` +
	`{"hanzi":"借","pinyin":"jiè","syllables":["jiè"],"meaning":"mượn"},` +
	`{"hanzi":"复习","pinyin":"fùxí","syllables":["fù","xí"],"meaning":"ôn tập"},` +
	`{"hanzi":"作业","pinyin":"zuòyè","syllables":["zuò","yè"],"meaning":"bài tập"},` +
	`{"hanzi":"句子","pinyin":"jùzi","syllables":["jù","zi"],"meaning":"câu"},` +
	`{"hanzi":"词典","pinyin":"cídiǎn","syllables":["cí","diǎn"],"meaning":"từ điển"},` +
	`{"hanzi":"练习","pinyin":"liànxí","syllables":["liàn","xí"],"meaning":"luyện tập"},` +
	`{"hanzi":"讲","pinyin":"jiǎng","syllables":["jiǎng"],"meaning":"giảng"},` +
	`{"hanzi":"解决","pinyin":"jiějué","syllables":["jiě","jué"],"meaning":"giải quyết"},` +
	`{"hanzi":"努力","pinyin":"nǔlì","syllables":["nǔ","lì"],"meaning":"nỗ lực"},` +
	`{"hanzi":"成绩","pinyin":"chéngjì","syllables":["chéng","jì"],"meaning":"thành tích"},` +
	`{"hanzi":"健康","pinyin":"jiànkāng","syllables":["jiàn","kāng"],"meaning":"khỏe mạnh"}]}]}`

func TestGenerateRadicalsFromModel(t *testing.T) {
	llm, calls := fakeRadicalsModel(t, modelVocabulary)
	c := NewClient(llm.URL, "key", "m", nil, 0, slog.New(slog.DiscardHandler))
	result, err := c.Generate(context.Background(), nil, true, Options{
		ExportType: Radicals, CourseType: Other, CourseName: "Boya", LessonNumbers: []int{1},
	})
	if err != nil {
		t.Fatal(err)
	}
	if (*calls)[0] != "vocabulary" {
		t.Fatalf("calls = %v", *calls)
	}
	var exercise radicals.Exercise
	if err := json.Unmarshal([]byte(result.CSV), &exercise); err != nil {
		t.Fatal(err)
	}
	if exercise.Preset != "jade" || exercise.Review.Groups["1"] == 0 || len(exercise.Review.AIWords) != 12 {
		t.Fatalf("exercise = preset %q, groups %v, aiWords %v", exercise.Preset, exercise.Review.Groups, exercise.Review.AIWords)
	}
}

func TestGenerateRadicalsWithTooFewWords(t *testing.T) {
	llm, _ := fakeRadicalsModel(t, `{"lessons":[]}`)
	c := NewClient(llm.URL, "key", "m", nil, 0, slog.New(slog.DiscardHandler))
	_, err := c.Generate(context.Background(), nil, true, Options{
		ExportType: Radicals, CourseType: Other, CourseName: "Boya", LessonNumbers: []int{1},
	})
	if err == nil {
		t.Fatal("want an error for a lesson the model gave no word")
	}
	if !errors.Is(err, radicals.ErrNothingToPlay) {
		t.Fatalf("error = %v, want ErrNothingToPlay", err)
	}
}
