package bank

import (
	"fmt"
	"time"

	"quiz-csv-import-tool/server/internal/csvgen"
	"quiz-csv-import-tool/server/internal/store"
)

// testVocabulary is n words of a made-up book, lesson 1 to lessons in turn.
func testVocabulary(n, lessons int) csvgen.Vocabulary {
	v := csvgen.Vocabulary{Book: "test-1"}
	for l := 1; l <= lessons; l++ {
		v.Lessons = append(v.Lessons, l)
	}
	for i := range n {
		v.Words = append(v.Words, csvgen.LessonWord{
			Lesson: i%lessons + 1, Word: fmt.Sprintf("词%d", i+1), Pinyin: fmt.Sprintf("cí%d", i+1), POS: "n.",
			English: "word", Vietnamese: fmt.Sprintf("từ %d", i+1),
		})
	}
	return v
}

// mc is a valid multiple-choice question on word, as the bank stores it.
func mc(id string, v csvgen.Vocabulary, word, difficulty int, skill string) store.Question {
	w := v.Words[word]
	return store.Question{
		ID: id, Book: v.Book, Lessons: []int{w.Lesson}, MaxLesson: v.MaxLesson(), Targets: []string{w.Key()},
		Format: FormatMC, Skill: skill, Difficulty: difficulty,
		Stem: store.Text{Text: id + " " + w.Word + " nghĩa là gì?", Pinyin: w.Pinyin}, Answer: store.Text{Text: w.Vietnamese},
		Distractors: []store.Text{{Text: "sai 1"}, {Text: "sai 2"}, {Text: "sai 3"}}, Explanation: "Giải thích.",
		Intelligence: 1, Fingerprint: id, Status: store.QuestionActive, CreatedAt: time.Now(),
	}
}

func trueFalse(id string, v csvgen.Vocabulary, word int) store.Question {
	q := mc(id, v, word, Easy, SkillMeaning)
	q.Format, q.Answer, q.Distractors = FormatTrueFalse, store.Text{Text: "Sai"}, nil
	return q
}

func wordOrder(id string, v csvgen.Vocabulary, word int) store.Question {
	w := v.Words[word]
	q := mc(id, v, word, Hard, SkillTranslation)
	q.Format = FormatWordOrder
	q.Stem = store.Text{Text: "Tôi thích " + w.Vietnamese}
	q.Chunks = []store.Text{{Text: "我", Pinyin: "wǒ"}, {Text: "喜欢", Pinyin: "xǐhuan"}, {Text: w.Word + "。", Pinyin: w.Pinyin + "."}}
	q.Answer = store.Text{Text: "我喜欢" + w.Word + "。"}
	q.Distractors = []store.Text{{Text: "喜欢我" + w.Word + "。"}}
	return q
}

func gameRequest(v csvgen.Vocabulary, stages []int, perStage int) Request {
	return Request{Platform: csvgen.GestureQuiz, Vocabulary: v, Intelligence: 1, Stages: stages, PerStage: perStage}
}

func request(platform csvgen.ExportType, v csvgen.Vocabulary) Request {
	return Request{Platform: platform, Vocabulary: v, Intelligence: 1}
}
