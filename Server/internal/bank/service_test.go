package bank

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"testing"

	"quiz-csv-import-tool/server/internal/csvgen"
	"quiz-csv-import-tool/server/internal/gesturequiz"
	"quiz-csv-import-tool/server/internal/store"
)

// fakeWriter answers every spec with a valid draft, numbered so that no two are the same question.
type fakeWriter struct {
	calls int
	specs []csvgen.QuestionSpec
	err   error
	// spoil, when set, changes each draft before it is returned.
	spoil func(*csvgen.QuestionDraft)
	n     int
}

func (f *fakeWriter) WriteQuestions(_ context.Context, opts csvgen.Options, v csvgen.Vocabulary, specs []csvgen.QuestionSpec) ([]csvgen.QuestionDraft, csvgen.Usage, error) {
	f.calls++
	f.specs = specs
	usage := csvgen.Usage{Model: "fake", Calls: 1, OutputTokens: 100}
	if f.err != nil {
		return nil, usage, f.err
	}
	words := map[string]csvgen.LessonWord{}
	for _, w := range v.Words {
		words[w.Key()] = w
	}
	var drafts []csvgen.QuestionDraft
	for _, spec := range specs {
		f.n++
		w := words[spec.Word]
		d := csvgen.QuestionDraft{
			Targets: []string{spec.Word}, Format: spec.Format, Difficulty: spec.Difficulty,
			Stem: fmt.Sprintf("%s là gì? (%d)", w.Word, f.n), StemPinyin: w.Pinyin, Answer: fmt.Sprintf("đáp %d", f.n),
			Distractors: []csvgen.DraftText{{Text: "sai a"}, {Text: "sai b"}, {Text: "sai c"}}, Explanation: "Giải thích.",
		}
		if d.Format == "" {
			d.Format = FormatMC
		}
		d.Skill = SkillMeaning
		if len(spec.Skills) > 0 {
			d.Skill = spec.Skills[0]
		}
		switch d.Format {
		case FormatTrueFalse:
			d.Answer, d.Distractors = "Đúng", nil
		case FormatWordOrder:
			d.Answer, d.AnswerPinyin = fmt.Sprintf("我有%s%d。", w.Word, f.n), "wǒ yǒu"
			d.Chunks = []csvgen.DraftText{{Text: "我", Pinyin: "wǒ"}, {Text: "有", Pinyin: "yǒu"}, {Text: fmt.Sprintf("%s%d。", w.Word, f.n), Pinyin: w.Pinyin}}
			d.Distractors = []csvgen.DraftText{{Text: "有我" + fmt.Sprintf("%s%d。", w.Word, f.n), Pinyin: "yǒu wǒ"}}
		}
		if spec.Visual {
			d.ImageURL = fmt.Sprintf("https://images.pexels.com/photos/%d/pexels-photo-%d.jpeg", f.n, f.n)
		}
		if f.spoil != nil {
			f.spoil(&d)
		}
		drafts = append(drafts, d)
	}
	return drafts, usage, nil
}

type fakeNext struct{ calls int }

func (f *fakeNext) Generate(context.Context, []csvgen.Image, bool, csvgen.Options) (csvgen.Result, error) {
	f.calls++
	return csvgen.Result{CSV: "from the model", Usage: csvgen.Usage{Calls: 1}}, nil
}

type brokenBank struct{ store.QuestionBank }

func (brokenBank) Pool(context.Context, int, string, int) ([]store.Question, error) {
	return nil, errors.New("no database")
}

func hskOptions(platform csvgen.ExportType, lessons ...int) csvgen.Options {
	level := 1
	return csvgen.Options{
		Language: csvgen.Chinese, ExportType: platform, CourseType: csvgen.Hsk, HskStandard: csvgen.Hsk3, Level: &level,
		LessonNumbers: lessons,
	}
}

func newTestService(bank store.QuestionBank, writer Writer) *Service {
	id := 0
	return &Service{
		Store: bank, Writer: writer, Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
		Seed:  func() uint64 { return 42 },
		NewID: func() string { id++; return fmt.Sprintf("q%04d", id) },
	}
}

func TestGeneratorFillsTheBankThenUsesItAlone(t *testing.T) {
	bank, writer, next := store.NewMemoryQuestionBank(), &fakeWriter{}, &fakeNext{}
	gen := &Generator{Next: next, Service: newTestService(bank, writer)}
	opts := hskOptions(csvgen.GimKit, 3)
	vocabulary, _ := csvgen.LessonVocabulary(opts)
	ctx := WithJob(context.Background(), "job1")

	first, err := gen.Generate(ctx, nil, true, opts)
	if err != nil {
		t.Fatal(err)
	}
	size := QuizSize(len(vocabulary.Words))
	if writer.calls != 1 || next.calls != 0 || first.FromBank != 0 || len(first.BankQuestions) != size || first.Usage.Calls != 1 {
		t.Fatalf("first quiz: writer %d, next %d, from bank %d of %d, usage %+v",
			writer.calls, next.calls, first.FromBank, len(first.BankQuestions), first.Usage)
	}
	// The gaps are the whole quiz, and every word gets one more question at another level.
	if len(writer.specs) != size+len(vocabulary.Words) {
		t.Errorf("asked for %d questions, want %d", len(writer.specs), size+len(vocabulary.Words))
	}
	if bank.Len() != len(writer.specs) {
		t.Errorf("stored %d of %d questions", bank.Len(), len(writer.specs))
	}
	if q, _ := bank.Get(first.BankQuestions[0]); q.JobID != "job1" || q.Model != "fake" || q.ServedCount != 1 || q.Book != "hsk3-1" {
		t.Errorf("stored question %+v", q)
	}
	if got := len(readRows(t, first.CSV)); got != size {
		t.Errorf("%d rows, want %d", got, size)
	}

	second, err := gen.Generate(ctx, nil, true, opts)
	if err != nil {
		t.Fatal(err)
	}
	if writer.calls != 1 || second.Usage.Calls != 0 || second.FromBank != len(second.BankQuestions) || len(second.BankQuestions) != size {
		t.Errorf("second quiz: writer %d, usage %+v, from bank %d of %d", writer.calls, second.Usage, second.FromBank, len(second.BankQuestions))
	}
}

func TestGeneratorAsksOnlyForWhatTheBankLacks(t *testing.T) {
	bank, writer := store.NewMemoryQuestionBank(), &fakeWriter{}
	gen := &Generator{Next: &fakeNext{}, Service: newTestService(bank, writer)}
	ctx := context.Background()
	if _, err := gen.Generate(ctx, nil, true, hskOptions(csvgen.GimKit, 3)); err != nil {
		t.Fatal(err)
	}
	// Lessons 3 and 4 together: the bank covers lesson 3 already, so only lesson 4's words are new.
	opts := hskOptions(csvgen.GimKit, 3, 4)
	result, err := gen.Generate(ctx, nil, true, opts)
	if err != nil {
		t.Fatal(err)
	}
	vocabulary, _ := csvgen.LessonVocabulary(opts)
	lesson := map[string]int{}
	for _, w := range vocabulary.Words {
		lesson[w.Key()] = w.Lesson
	}
	// The questions of lesson 3 were written for a request whose highest lesson was 3: they may be used again.
	if writer.calls != 2 || result.FromBank == 0 {
		t.Fatalf("writer %d, from bank %d", writer.calls, result.FromBank)
	}
	// Every word of lesson 4 is asked for, twice (its gap and one more for the bank); a word of lesson 3 at most
	// once, to fill a level the bank has too few questions of.
	asked := map[string]int{}
	for _, spec := range writer.specs {
		asked[spec.Word]++
	}
	for _, w := range vocabulary.Words {
		switch n := asked[w.Key()]; {
		case w.Lesson == 4 && n != 2:
			t.Errorf("lesson 4's %s asked %d times", w.Word, n)
		case w.Lesson == 3 && n > 1:
			t.Errorf("lesson 3's %s asked %d times", w.Word, n)
		}
	}
	if len(readRows(t, result.CSV)) != QuizSize(len(vocabulary.Words)) {
		t.Errorf("%d rows", len(readRows(t, result.CSV)))
	}
}

func TestGeneratorBuildsAGame(t *testing.T) {
	bank, writer := store.NewMemoryQuestionBank(), &fakeWriter{}
	gen := &Generator{Next: &fakeNext{}, Service: newTestService(bank, writer)}
	opts := hskOptions(csvgen.GestureQuiz, 5)
	opts.GestureStages, opts.QuestionsPerStage = []int{1, 4, 6}, 4
	result, err := gen.Generate(context.Background(), nil, true, opts)
	if err != nil {
		t.Fatal(err)
	}
	quiz := gesturequiz.Parse(result.CSV)
	if quiz.Skipped != 0 || quiz.Count(1) != 4 || quiz.Count(4) != 4 || quiz.Count(6) != 4 || quiz.Total() != 12 {
		t.Errorf("the game read %v, skipped %d:\n%s", quiz.StageCounts(), quiz.Skipped, result.CSV)
	}
	// Built again from the bank alone.
	if result, err = gen.Generate(context.Background(), nil, true, opts); err != nil || writer.calls != 1 ||
		gesturequiz.Parse(result.CSV).Total() != 12 {
		t.Errorf("second game: writer %d, %v", writer.calls, err)
	}
}

func TestGeneratorFailures(t *testing.T) {
	opts := hskOptions(csvgen.Blooket, 2)

	// The model's failure is the job's, with nothing stored.
	bank := store.NewMemoryQuestionBank()
	writer := &fakeWriter{err: csvgen.BadOutput(errors.New("not JSON"))}
	_, err := (&Generator{Next: &fakeNext{}, Service: newTestService(bank, writer)}).Generate(context.Background(), nil, true, opts)
	if csvgen.FailureCode(err) != csvgen.FailureBadOutput || bank.Len() != 0 {
		t.Errorf("got %v, %d stored", err, bank.Len())
	}

	// Questions that all fail Validate leave the quiz without questions.
	writer = &fakeWriter{spoil: func(d *csvgen.QuestionDraft) { d.Explanation = "" }}
	result, err := (&Generator{Next: &fakeNext{}, Service: newTestService(bank, writer)}).Generate(context.Background(), nil, true, opts)
	if csvgen.FailureCode(err) != csvgen.FailureBadOutput || bank.Len() != 0 || result.Usage.Calls != 1 {
		t.Errorf("got %v, %d stored, usage %+v", err, bank.Len(), result.Usage)
	}
}

func TestGeneratorLeavesOtherJobsToTheModel(t *testing.T) {
	other := hskOptions(csvgen.GimKit, 1)
	other.CourseType = csvgen.Other
	for name, call := range map[string]struct {
		opts     csvgen.Options
		images   []csvgen.Image
		creative bool
		bank     store.QuestionBank
	}{
		"radicals":       {hskOptions(csvgen.Radicals, 1), nil, true, store.NewMemoryQuestionBank()},
		"formatted mode": {hskOptions(csvgen.GimKit, 1), []csvgen.Image{{}}, false, store.NewMemoryQuestionBank()},
		"images":         {hskOptions(csvgen.GimKit, 1), []csvgen.Image{{}}, true, store.NewMemoryQuestionBank()},
		"no textbook":    {other, nil, true, store.NewMemoryQuestionBank()},
		"bank down":      {hskOptions(csvgen.GimKit, 1), nil, true, brokenBank{}},
	} {
		t.Run(name, func(t *testing.T) {
			next, writer := &fakeNext{}, &fakeWriter{}
			gen := &Generator{Next: next, Service: newTestService(call.bank, writer)}
			result, err := gen.Generate(context.Background(), call.images, call.creative, call.opts)
			if err != nil || next.calls != 1 || writer.calls != 0 || result.CSV != "from the model" {
				t.Errorf("next %d, writer %d, %q, %v", next.calls, writer.calls, result.CSV, err)
			}
		})
	}
}
