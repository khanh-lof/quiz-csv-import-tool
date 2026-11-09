package csvgen

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
	"time"
)

func bankOptions(lessons ...int) Options {
	level := 1
	return Options{Language: Chinese, ExportType: GimKit, CourseType: Hsk, HskStandard: Hsk3, Level: &level, LessonNumbers: lessons, Intelligence: 1}
}

func TestBuildBankRequest(t *testing.T) {
	opts := bankOptions(3)
	vocabulary, ok := LessonVocabulary(opts)
	if !ok {
		t.Fatal("no vocabulary for HSK 3.0 book 1 lesson 3")
	}
	first, second := vocabulary.Words[0], vocabulary.Words[1]
	specs := []QuestionSpec{
		{Word: second.Key(), Format: "mc", Skills: []string{"meaning", "form"}, Difficulty: 1, Options: 4},
		{Word: first.Key(), Format: "", Difficulty: 3},
	}
	req, ids, err := buildBankRequest("m", 0, opts, vocabulary, specs)
	if err != nil {
		t.Fatal(err)
	}
	if ids[first.Key()] != "W1" || ids[second.Key()] != "W2" || len(ids) != len(vocabulary.Words) {
		t.Errorf("ids %v", ids)
	}
	var texts []string
	for _, part := range req.Input[0].Content {
		texts = append(texts, part.Text)
	}
	all := strings.Join(texts, "\n\n")
	for _, want := range []string{
		"LESSON MATERIAL: 《新HSK教程1》",
		"\nW1 " + first.Word + " | " + first.Pinyin + " | ",
		"REQUEST (write these 2 questions, in this order):\n1. W2, format mc, difficulty 1, skill meaning or form\n2. W1, format mc or word_order, difficulty 3",
	} {
		if !strings.Contains(all, want) {
			t.Errorf("the request lacks %q:\n%s", want, all)
		}
	}
	if len(req.Tools) != 0 || req.MaxOutputTokens != maxOutputTokensLarge {
		t.Errorf("tools %v, budget %d", req.Tools, req.MaxOutputTokens)
	}
	for _, want := range []string{"## LESSON SOURCE", "## QUESTION FORMATS", "## PINYIN", `{"questions":[`} {
		if !strings.Contains(req.Instructions, want) {
			t.Errorf("the instructions lack %q", want)
		}
	}
	if strings.Contains(req.Instructions, "{{") || strings.Contains(req.Instructions, "TIME LIMIT") {
		t.Error("the instructions hold a template action or a time limit")
	}

	// A visual question brings web search along; a word outside the lessons is an error.
	specs[0].Visual = true
	if req, _, _ = buildBankRequest("m", time.Minute, opts, vocabulary, specs); len(req.Tools) != 1 || req.Tools[0].Type != "web_search" ||
		!strings.Contains(req.Instructions, "## TIME LIMIT") {
		t.Errorf("visual request: tools %v", req.Tools)
	}
	if _, _, err := buildBankRequest("m", 0, opts, vocabulary, []QuestionSpec{{Word: "其他||"}}); err == nil {
		t.Error("a question about a word outside the lessons was asked")
	}
}

func TestBankPromptForEnglish(t *testing.T) {
	prompt := bankSystemPrompt(English, 0)
	if !strings.Contains(prompt, "This course is English") || strings.Contains(prompt, "Chinese characters and the Vietnamese") {
		t.Errorf("English bank prompt has the wrong pinyin section")
	}
}

func TestCreativePromptKeepsTheGuidanceInPlace(t *testing.T) {
	// The guidance moved to its own block; the creative prompt reads as it did, sections in the same order.
	prompt := creativeSystemPrompt(Chinese, 0)
	at := func(s string) int {
		i := strings.Index(prompt, s)
		if i < 0 {
			t.Fatalf("the creative prompt lacks %q", s)
		}
		return i
	}
	if !(at("* Optional additional instructions.\n\n## LESSON SOURCE") < at("## QUESTION DESIGN") && at("## QUESTION DESIGN") < at("## VOCABULARY COVERAGE") &&
		at("## VOCABULARY COVERAGE") < at("\n\n## CSV REQUIREMENTS")) {
		t.Error("the creative prompt's sections are out of order")
	}
}

func TestWriteQuestions(t *testing.T) {
	opts := bankOptions(3)
	vocabulary, _ := LessonVocabulary(opts)
	answer := `Here you are:
{"questions":[
{"targets":["w2","W1","W999"],"format":"mc","skill":"meaning","difficulty":"2","stem":"Q","stemPinyin":"","answer":"A","answerPinyin":"","distractors":[{"text":"B","pinyin":""}],"chunks":[],"explanation":"E","imageUrl":""},
{"targets":["W999"],"format":"mc","skill":"meaning","difficulty":1,"stem":"lost","answer":"A","explanation":"E"}
]}`
	var asked responsesRequest
	llm := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(body, &asked)
		reply, _ := json.Marshal(map[string]any{"status": "completed", "usage": map[string]int{"input_tokens": 10, "output_tokens": 5},
			"output": []any{map[string]any{"type": "message", "content": []any{map[string]any{"type": "output_text", "text": answer}}}}})
		_, _ = w.Write(reply)
	}))
	t.Cleanup(llm.Close)
	c := NewClient(llm.URL, "key", "base", []string{"low", "high"}, 0, slog.New(slog.DiscardHandler))
	opts.Intelligence = 2
	drafts, usage, err := c.WriteQuestions(context.Background(), opts, vocabulary,
		[]QuestionSpec{{Word: vocabulary.Words[1].Key(), Format: "mc", Difficulty: 2}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if asked.Model != "high" || usage.Model != "high" || usage.Calls != 1 || usage.OutputTokens != 5 {
		t.Errorf("model %q, usage %+v", asked.Model, usage)
	}
	// The question naming no word of the list is left out; ids turn into keys, unknown ones dropped.
	if len(drafts) != 1 {
		t.Fatalf("drafts %+v", drafts)
	}
	d := drafts[0]
	if !slices.Equal(d.Targets, []string{vocabulary.Words[1].Key(), vocabulary.Words[0].Key()}) || d.Difficulty != 2 ||
		d.Stem != "Q" || len(d.Distractors) != 1 {
		t.Errorf("draft %+v", d)
	}

	answer = `{"questions":[{"targets":["W999"],"format":"mc"}]}`
	if _, _, err := c.WriteQuestions(context.Background(), opts, vocabulary, []QuestionSpec{{Word: vocabulary.Words[0].Key()}}, nil); FailureCode(err) != FailureBadOutput {
		t.Errorf("an answer without usable questions: %v", err)
	}
	answer = `not json`
	if _, _, err := c.WriteQuestions(context.Background(), opts, vocabulary, []QuestionSpec{{Word: vocabulary.Words[0].Key()}}, nil); FailureCode(err) != FailureBadOutput {
		t.Errorf("an answer that is not JSON: %v", err)
	}
}
