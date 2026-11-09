package bank

import (
	"slices"
	"strings"
	"testing"
	"time"

	"quiz-csv-import-tool/server/internal/csvgen"
	"quiz-csv-import-tool/server/internal/store"
)

func testOrigin() Origin {
	return Origin{Vocabulary: testVocabulary(4, 2), Language: csvgen.Chinese, Intelligence: 2, Model: "m", JobID: "job", Now: time.Unix(1, 0)}
}

// goodDraft is a valid multiple-choice draft on the first two words.
func goodDraft(o Origin) csvgen.QuestionDraft {
	return csvgen.QuestionDraft{
		Targets: []string{o.Vocabulary.Words[1].Key(), o.Vocabulary.Words[0].Key()}, Format: FormatMC, Skill: SkillMeaning, Difficulty: 2,
		Stem: "  词2 和 词1\n是什么？ ", StemPinyin: "cí2 hé cí1 shì shénme?", Answer: "từ", AnswerPinyin: "",
		Distractors: []csvgen.DraftText{{Text: "nhà"}, {Text: " Từ "}, {Text: ""}, {Text: "nhà"}, {Text: "cây"}},
		Explanation: "Giải thích.",
	}
}

func TestValidateKeepsAGoodDraft(t *testing.T) {
	o := testOrigin()
	q, err := Validate(goodDraft(o), o, "id1")
	if err != nil {
		t.Fatal(err)
	}
	if q.Stem.Text != "词2 和 词1 是什么？" || q.Book != "test-1" || q.MaxLesson != 2 || !slices.Equal(q.Lessons, []int{1, 2}) ||
		q.Intelligence != 2 || q.Model != "m" || q.JobID != "job" || q.Status != store.QuestionActive || q.ID != "id1" {
		t.Errorf("question %+v", q)
	}
	// The empty wrong answer, the repeated one and the one that reads as the answer are dropped.
	if len(q.Distractors) != 2 || q.Distractors[0].Text != "nhà" || q.Distractors[1].Text != "cây" {
		t.Errorf("distractors %+v", q.Distractors)
	}
	if q.Fingerprint != Fingerprint(FormatMC, "词2  和 词1 是什么？", "TỪ") {
		t.Error("the fingerprint depends on spacing or case")
	}
}

func TestValidateRefuses(t *testing.T) {
	o := testOrigin()
	for _, tt := range []struct {
		name   string
		change func(*csvgen.QuestionDraft)
		want   string
	}{
		{"format", func(d *csvgen.QuestionDraft) { d.Format = "essay" }, "unknown format"},
		{"skill", func(d *csvgen.QuestionDraft) { d.Skill = "spelling" }, "unknown skill"},
		{"difficulty", func(d *csvgen.QuestionDraft) { d.Difficulty = 4 }, "difficulty"},
		{"target", func(d *csvgen.QuestionDraft) { d.Targets = []string{"其他|qítā|pron."} }, "not a word"},
		{"no target", func(d *csvgen.QuestionDraft) { d.Targets = nil }, "no target"},
		{"empty stem", func(d *csvgen.QuestionDraft) { d.Stem = " " }, "empty"},
		{"no explanation", func(d *csvgen.QuestionDraft) { d.Explanation = "" }, "empty"},
		{"no wrong answer", func(d *csvgen.QuestionDraft) { d.Distractors = []csvgen.DraftText{{Text: "từ"}} }, "without wrong answers"},
		{"no pinyin", func(d *csvgen.QuestionDraft) { d.StemPinyin = "" }, "no pinyin"},
		{"wrong answer pinyin", func(d *csvgen.QuestionDraft) { d.Distractors = []csvgen.DraftText{{Text: "人"}} }, "no pinyin"},
		{"true/false", func(d *csvgen.QuestionDraft) { d.Format = FormatTrueFalse; d.Answer = "Có" }, "neither"},
		{"chunks", func(d *csvgen.QuestionDraft) {
			d.Format, d.Answer, d.AnswerPinyin = FormatWordOrder, "我喜欢词1。", "wǒ xǐhuan cí1."
			d.Chunks = []csvgen.DraftText{{Text: "我", Pinyin: "wǒ"}, {Text: "词1。", Pinyin: "cí1."}}
		}, "do not make"},
		{"visual without image", func(d *csvgen.QuestionDraft) { d.Skill = SkillVisual }, "image"},
		{"wikimedia", func(d *csvgen.QuestionDraft) {
			d.Skill, d.ImageURL = SkillVisual, "https://upload.wikimedia.org/a.jpg"
		}, "image"},
		{"http image", func(d *csvgen.QuestionDraft) { d.Skill, d.ImageURL = SkillVisual, "http://images.pexels.com/a.jpg" }, "image"},
		{"long typed answer", func(d *csvgen.QuestionDraft) {
			d.Format, d.Answer = FormatTyped, strings.Repeat("dài ", 20)
		}, "too long"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			d := goodDraft(o)
			tt.change(&d)
			if _, err := Validate(d, o, "x"); err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Errorf("got %v, want an error containing %q", err, tt.want)
			}
		})
	}
}

func TestValidateFormats(t *testing.T) {
	o := testOrigin()

	d := goodDraft(o)
	d.Format, d.Answer = FormatTrueFalse, "đúng."
	if q, err := Validate(d, o, "tf"); err != nil || q.Answer.Text != "Đúng" || q.Distractors != nil {
		t.Errorf("true/false: %+v, %v", q, err)
	}

	d = goodDraft(o)
	d.Format, d.Answer, d.AnswerPinyin = FormatWordOrder, "我喜欢词1。", "wǒ xǐhuan cí1."
	d.Chunks = []csvgen.DraftText{{Text: "我", Pinyin: "wǒ"}, {Text: " 喜欢 ", Pinyin: "xǐhuan"}, {Text: "词1。", Pinyin: "cí1."}}
	d.Distractors = []csvgen.DraftText{{Text: "我 喜欢 词1。"}, {Text: "喜欢我词1。"}}
	if q, err := Validate(d, o, "wo"); err != nil || len(q.Chunks) != 3 || q.Chunks[1].Text != "喜欢" ||
		len(q.Distractors) != 1 || q.Distractors[0].Text != "喜欢我词1。" {
		t.Errorf("word order: %+v, %v", q, err)
	}

	d = goodDraft(o)
	d.Format = FormatTyped
	if q, err := Validate(d, o, "ty"); err != nil || q.Distractors != nil {
		t.Errorf("typed: %+v, %v", q, err)
	}

	d = goodDraft(o)
	d.Skill, d.ImageURL = SkillVisual, " https://images.pexels.com/photos/1/pexels-photo-1.jpeg "
	if q, err := Validate(d, o, "vi"); err != nil || q.ImageURL != "https://images.pexels.com/photos/1/pexels-photo-1.jpeg" {
		t.Errorf("visual: %+v, %v", q, err)
	}
	d.Skill = SkillMeaning
	if q, err := Validate(d, o, "vi"); err != nil || q.ImageURL != "" {
		t.Errorf("an image on a text question is dropped: %+v, %v", q, err)
	}

	// A question about the pinyin itself has none.
	d = goodDraft(o)
	d.Skill, d.StemPinyin = SkillForm, ""
	if _, err := Validate(d, o, "fo"); err != nil {
		t.Errorf("form question: %v", err)
	}

	// An English course has no pinyin at all.
	english := o
	english.Language = csvgen.English
	d = goodDraft(o)
	d.Distractors = []csvgen.DraftText{{Text: "nhà", Pinyin: "x"}}
	if q, err := Validate(d, english, "en"); err != nil || q.Stem.Pinyin != "" || q.Distractors[0].Pinyin != "" || q.Language != 1 {
		t.Errorf("English: %+v, %v", q, err)
	}
}
