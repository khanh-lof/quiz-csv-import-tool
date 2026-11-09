package api

import (
	"context"
	"encoding/csv"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"quiz-csv-import-tool/server/internal/bank"
	"quiz-csv-import-tool/server/internal/csvgen"
	"quiz-csv-import-tool/server/internal/store"
)

// bankLesson is HSK 3.0 book 1 lesson 3 for GimKit, the quiz the bank tests fill and ask for.
const bankLesson = "?isCreative=true&exportType=0&courseType=0&hskStandard=3&level=1&lessonNumbers=3&title=HSK-B3"

func bankLessonOptions() csvgen.Options {
	level := 1
	return csvgen.Options{ExportType: csvgen.GimKit, CourseType: csvgen.Hsk, HskStandard: csvgen.Hsk3, Level: &level, LessonNumbers: []int{3}}
}

// useBank gives the server a question bank and returns its store.
func (e *testEnv) useBank() *store.MemoryQuestionBank {
	questions := store.NewMemoryQuestionBank()
	e.srv.Bank = &bank.Service{Store: questions, Logger: slog.New(slog.DiscardHandler)}
	return questions
}

// fillBank stores an easy, a medium and a hard question on every word of the lessons of opts, written at the
// intelligence level.
func fillBank(t *testing.T, questions store.QuestionBank, opts csvgen.Options, intelligence int) {
	t.Helper()
	vocabulary, ok := csvgen.LessonVocabulary(opts)
	if !ok {
		t.Fatal("no vocabulary")
	}
	var all []store.Question
	for i, w := range vocabulary.Words {
		for level, skill := range map[int]string{bank.Easy: bank.SkillMeaning, bank.Medium: bank.SkillFillBlank, bank.Hard: bank.SkillDialogue} {
			id := fmt.Sprintf("%s-%d-%d", vocabulary.Book, i, level)
			all = append(all, store.Question{
				ID: id, Book: vocabulary.Book, Lessons: []int{w.Lesson}, MaxLesson: vocabulary.MaxLesson(), Targets: []string{w.Key()},
				Format: bank.FormatMC, Skill: skill, Difficulty: level, Stem: store.Text{Text: w.Word + "?", Pinyin: w.Pinyin},
				Answer: store.Text{Text: w.Vietnamese}, Distractors: []store.Text{{Text: "x"}, {Text: "y"}, {Text: "z"}},
				Explanation: "e", Intelligence: intelligence, Fingerprint: id, Status: store.QuestionActive, CreatedAt: time.Now(),
			})
		}
	}
	if _, err := questions.Insert(context.Background(), all); err != nil {
		t.Fatal(err)
	}
}

func TestCreateJobFromTheQuestionBank(t *testing.T) {
	env := newEnv(t)
	questions := env.useBank()
	fillBank(t, questions, bankLessonOptions(), 1)
	token, _ := env.login(t, "alice", "pw")
	vocabulary, _ := csvgen.LessonVocabulary(bankLessonOptions())

	// More quizzes than the rate limit allows: none of them is an AI call.
	for i := range env.srv.AICallsPerRound + 1 {
		rec := env.upload(t, upload{token: token, query: bankLesson})
		if rec.Code != http.StatusAccepted {
			t.Fatalf("quiz %d: %d %q", i, rec.Code, rec.Body)
		}
	}
	if env.gen.calls != 0 {
		t.Fatalf("the model was asked %d times", env.gen.calls)
	}
	user, _ := env.users.FindByUsername(context.Background(), "alice")
	if user.AICallCountInRound != 0 {
		t.Errorf("%d AI calls counted", user.AICallCountInRound)
	}
	jobs, _ := env.jobs.List(context.Background(), "alice", 10)
	job, _ := env.jobs.Get(context.Background(), "alice", jobs[0].ID)
	rows, err := csv.NewReader(strings.NewReader(job.CSV)).ReadAll()
	size := bank.QuizSize(len(vocabulary.Words))
	if err != nil || len(rows) != size || len(rows[0]) != 5 {
		t.Fatalf("CSV of %d rows (%v):\n%s", len(rows), err, job.CSV)
	}
	if job.Status != store.JobDone || job.FinishedAt == nil || job.Usage != nil || job.Title != "HSK-B3" || !job.Creative ||
		job.Level == nil || *job.Level != 1 || len(job.BankQuestions) != size || job.FromBank != size {
		t.Errorf("job %+v", job)
	}
	for _, view := range env.listJobs(t, token) {
		if view["id"] == job.ID && (view["status"] != "done" || view["csv"] != job.CSV) {
			t.Errorf("listed %v", view)
		}
	}
	if q, _ := questions.Get(job.BankQuestions[0]); q.ServedCount == 0 {
		t.Error("the question was not counted as served")
	}
}

func TestQuestionBankLeavesOtherQuizzesToTheModel(t *testing.T) {
	env := newEnv(t)
	env.srv.AICallsPerRound = 5
	fillBank(t, env.useBank(), bankLessonOptions(), 1)
	token, _ := env.login(t, "alice", "pw")

	for name, u := range map[string]upload{
		"images":         {token: token, query: bankLesson, files: 1},
		"another lesson": {token: token, query: strings.Replace(bankLesson, "lessonNumbers=3", "lessonNumbers=4", 1)},
		"no textbook":    {token: token, query: "?isCreative=true&exportType=0&courseType=2&courseName=Boya&lessonNumbers=3"},
		// The bank's questions were written at Standard intelligence; a High intelligence quiz wants better.
		"high intelligence": {token: token, query: bankLesson + "&intelligence=2"},
	} {
		calls := env.gen.calls
		if rec := env.upload(t, u); rec.Code != http.StatusAccepted || env.gen.calls != calls+1 {
			t.Errorf("%s: %d %q, model asked %d times", name, rec.Code, rec.Body, env.gen.calls-calls)
		}
		if got := len(env.gen.images); got != u.files {
			t.Errorf("%s: the model got %d images, want %d", name, got, u.files)
		}
	}
}

// recordingProxy stands in for the High intelligence server.
type recordingProxy struct {
	mu    sync.Mutex
	calls int
}

func (p *recordingProxy) ServeHTTP(w http.ResponseWriter, _ *http.Request) {
	p.mu.Lock()
	p.calls++
	p.mu.Unlock()
	writeText(w, http.StatusAccepted, `{"id":"remote"}`)
}

func (p *recordingProxy) Wake(context.Context) {}

func TestHighIntelligenceQuizFromTheBankStaysHere(t *testing.T) {
	env := newEnv(t)
	proxy := &recordingProxy{}
	env.srv.HighIntelligenceProxy = proxy
	fillBank(t, env.useBank(), bankLessonOptions(), 2)
	token, _ := env.login(t, "alice", "pw")

	if rec := env.upload(t, upload{token: token, query: bankLesson + "&intelligence=2"}); rec.Code != http.StatusAccepted || proxy.calls != 0 {
		t.Fatalf("%d %q, proxied %d times", rec.Code, rec.Body, proxy.calls)
	}
	if job := env.onlyJob(t, "alice"); job.Status != store.JobDone || job.Intelligence != 2 {
		t.Errorf("job %+v", job)
	}
	// With images the job is the model's, on the High intelligence server, its body intact.
	if rec := env.upload(t, upload{token: token, query: bankLesson + "&intelligence=2", files: 1}); rec.Code != http.StatusAccepted ||
		proxy.calls != 1 {
		t.Errorf("%d %q, proxied %d times", rec.Code, rec.Body, proxy.calls)
	}
}

func TestRetryJobFromTheQuestionBank(t *testing.T) {
	env := newEnv(t)
	questions := env.useBank()
	token, _ := env.login(t, "alice", "pw")
	env.gen.err = errors.New("boom")
	env.upload(t, upload{token: token, query: bankLesson})
	failed := env.onlyJob(t, "alice")
	if failed.Status != store.JobFailed || env.gen.calls != 1 {
		t.Fatalf("job %+v", failed)
	}

	// The bank has the lesson by the time the teacher retries.
	fillBank(t, questions, bankLessonOptions(), 1)
	rec := env.retry(t, token, failed.ID)
	job := env.onlyJob(t, "alice")
	if rec.Code != http.StatusAccepted || job.ID == failed.ID || job.Status != store.JobDone || job.Title != "HSK-B3" ||
		len(job.BankQuestions) == 0 || env.gen.calls != 1 {
		t.Fatalf("retry: %d %q, job %+v, model asked %d times", rec.Code, rec.Body, job, env.gen.calls)
	}
}
