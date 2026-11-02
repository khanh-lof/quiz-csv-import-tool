package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"quiz-csv-import-tool/server/internal/csvgen"
	"quiz-csv-import-tool/server/internal/radicals"
	"quiz-csv-import-tool/server/internal/store"
)

const radicalsQuery = "?title=Boya-Bai3-4&isCreative=true&exportType=4&courseType=2&courseName=Boya&lessonNumbers=4,3" +
	"&reviewPrevious=true&colorPreset=blue"

func TestCreateJobReadsRadicalsOptions(t *testing.T) {
	env := newEnv(t)
	token, _ := env.login(t, "alice", "pw")

	rec := env.upload(t, upload{token: token, query: radicalsQuery,
		fields: map[string]string{"vocabulary": `{"3":["图书馆","借"],"4":[]}`}})
	if rec.Code != http.StatusAccepted {
		t.Fatalf("create: %d %q", rec.Code, rec.Body)
	}
	opts := env.gen.opts
	if opts.ExportType != csvgen.Radicals || !opts.ReviewPrevious || opts.ColorPreset != "blue" ||
		!reflect.DeepEqual(opts.Vocabulary, map[int][]string{3: {"图书馆", "借"}}) {
		t.Fatalf("generator got %+v", opts)
	}
	job := env.onlyJob(t, "alice")
	if !job.ReviewPrevious || job.ColorPreset != "blue" || !reflect.DeepEqual(job.Vocabulary, map[string][]string{"3": {"图书馆", "借"}}) {
		t.Fatalf("job %+v", job)
	}
}

func TestCreateJobRefusesBadVocabulary(t *testing.T) {
	env := newEnv(t)
	token, _ := env.login(t, "alice", "pw")

	for _, vocabulary := range []string{`{"5":["好"]}`, `{"3":["hao"]}`, `[1]`} {
		rec := env.upload(t, upload{token: token, query: radicalsQuery, fields: map[string]string{"vocabulary": vocabulary}})
		if rec.Code != http.StatusBadRequest || rec.Body.String() != "Invalid vocabulary." {
			t.Errorf("vocabulary %s: %d %q", vocabulary, rec.Code, rec.Body)
		}
	}
	// Only a Radicals job reads the field.
	rec := env.upload(t, upload{token: token, query: "?isCreative=true&exportType=0&courseType=2&courseName=Boya&lessonNumbers=1",
		fields: map[string]string{"vocabulary": "not json"}})
	if rec.Code != http.StatusAccepted {
		t.Fatalf("GimKit with a vocabulary field: %d %q", rec.Code, rec.Body)
	}
	if env.gen.calls != 1 {
		t.Fatalf("generator calls = %d", env.gen.calls)
	}
}

func TestRetryRadicalsJobSendsTheSameRequestAgain(t *testing.T) {
	env := newEnv(t)
	token, _ := env.login(t, "alice", "pw")
	env.gen.err = radicals.ErrNothingToPlay
	env.upload(t, upload{token: token, query: radicalsQuery, fields: map[string]string{"vocabulary": `{"4":["好"]}`}})
	failed := env.onlyJob(t, "alice")
	if failed.Status != store.JobFailed || failed.ErrorStatus != http.StatusUnprocessableEntity ||
		failed.ErrorMessage != radicals.ErrNothingToPlay.Error() {
		t.Fatalf("failed job %+v", failed)
	}
	want := env.gen.opts

	env.gen.err, env.gen.opts = nil, csvgen.Options{}
	if rec := env.retry(t, token, failed.ID); rec.Code != http.StatusAccepted {
		t.Fatalf("retry: %d %q", rec.Code, rec.Body)
	}
	if !reflect.DeepEqual(env.gen.opts, want) {
		t.Fatalf("retry sent %+v, want %+v", env.gen.opts, want)
	}
}

// exercise builds a real exercise of one lesson, with every missing note filled in, as the job would store it.
func exercise(t *testing.T) string {
	t.Helper()
	words := []radicals.Word{}
	for _, w := range [][3]string{
		{"图书馆", "túshūguǎn", "thư viện"}, {"借", "jiè", "mượn"}, {"复习", "fùxí", "ôn tập"}, {"作业", "zuòyè", "bài tập"},
		{"句子", "jùzi", "câu"}, {"词典", "cídiǎn", "từ điển"}, {"练习", "liànxí", "luyện tập"}, {"讲", "jiǎng", "giảng"},
		{"解决", "jiějué", "giải quyết"}, {"努力", "nǔlì", "nỗ lực"}, {"成绩", "chéngjì", "thành tích"}, {"健康", "jiànkāng", "khỏe mạnh"},
	} {
		ways := radicals.SplitPinyin(w[1], len([]rune(w[0])))
		words = append(words, radicals.Word{Hanzi: w[0], Pinyin: w[1], Syllables: ways[0], Meaning: w[2]})
	}
	draft, err := radicals.Plan([]radicals.Lesson{{Number: 1, Words: words}}, radicals.Options{})
	if err != nil {
		t.Fatal(err)
	}
	needs := draft.Needs()
	info := radicals.Info{CharMeanings: map[string]string{}, Components: map[string]radicals.ComponentInfo{}}
	for _, c := range needs.Chars {
		info.CharMeanings[c.Char] = "nghĩa"
	}
	for _, c := range needs.Components {
		info.Components[c.Component] = radicals.ComponentInfo{Name: "Bộ", Pinyin: "—", Meaning: "nghĩa"}
	}
	ex, err := draft.Build(info)
	if err != nil {
		t.Fatal(err)
	}
	out, _ := json.Marshal(ex)
	return string(out)
}

func (e *testEnv) page(t *testing.T, token, id string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/api/csv/jobs/"+id+"/page", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	return e.do(req)
}

func TestJobPage(t *testing.T) {
	env := newEnv(t)
	token, _ := env.login(t, "alice", "pw")
	env.gen.result = exercise(t)
	env.upload(t, upload{token: token, query: radicalsQuery})
	job := env.onlyJob(t, "alice")

	rec := env.page(t, token, job.ID)
	if rec.Code != http.StatusOK || rec.Header().Get("Content-Type") != "text/html; charset=utf-8" ||
		rec.Header().Get("Cache-Control") != "no-store" || !strings.Contains(rec.Body.String(), "</html>") {
		t.Fatalf("page: %d %v %.200q", rec.Code, rec.Header(), rec.Body)
	}

	// Another user's job is not found; a job that is no exercise is refused.
	env.createUser(t, "bob", "pw", []string{"User"})
	bobToken, _ := env.login(t, "bob", "pw")
	if rec := env.page(t, bobToken, job.ID); rec.Code != http.StatusNotFound {
		t.Fatalf("another user's page: %d", rec.Code)
	}
	env.gen.result = ""
	env.upload(t, upload{token: bobToken, query: "?isCreative=true&exportType=0&courseType=2&courseName=Boya&lessonNumbers=1"})
	gimkit := env.onlyJob(t, "bob")
	if rec := env.page(t, bobToken, gimkit.ID); rec.Code != http.StatusConflict || rec.Body.String() != "Job is not a finished radicals exercise." {
		t.Fatalf("GimKit page: %d %q", rec.Code, rec.Body)
	}
	if err := env.jobs.Delete(context.Background(), "alice", job.ID); err != nil {
		t.Fatal(err)
	}
	if rec := env.page(t, token, job.ID); rec.Code != http.StatusNotFound {
		t.Fatalf("deleted job's page: %d", rec.Code)
	}
}
