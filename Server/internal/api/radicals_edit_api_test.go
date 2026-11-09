package api

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync/atomic"
	"testing"

	"quiz-csv-import-tool/server/internal/csvgen"
	"quiz-csv-import-tool/server/internal/radicals"
	"quiz-csv-import-tool/server/internal/store"
)

// lessonThreeWords is the model's word list for lesson 3 of radicalsQuery; lesson 4 gets none and is left out.
const lessonThreeWords = `{"lessons":[{"number":3,"titleZh":"借书","titleVi":"Mượn sách","words":[` +
	`{"hanzi":"图书馆","pinyin":"túshūguǎn","meaning":"thư viện"},{"hanzi":"借","pinyin":"jiè","meaning":"mượn"},` +
	`{"hanzi":"复习","pinyin":"fùxí","meaning":"ôn tập"},{"hanzi":"作业","pinyin":"zuòyè","meaning":"bài tập"},` +
	`{"hanzi":"句子","pinyin":"jùzi","meaning":"câu"},{"hanzi":"词典","pinyin":"cídiǎn","meaning":"từ điển"},` +
	`{"hanzi":"练习","pinyin":"liànxí","meaning":"luyện tập"},{"hanzi":"讲","pinyin":"jiǎng","meaning":"giảng"},` +
	`{"hanzi":"解决","pinyin":"jiějué","meaning":"giải quyết"},{"hanzi":"努力","pinyin":"nǔlì","meaning":"nỗ lực"},` +
	`{"hanzi":"成绩","pinyin":"chéngjì","meaning":"thành tích"},{"hanzi":"健康","pinyin":"jiànkāng","meaning":"khỏe mạnh"}]}]}`

// radicalsModel is an LLM that answers a Radicals job's two requests: lessonThreeWords, then a note for everything
// the details request asks about. It counts the requests it gets.
func radicalsModel(t *testing.T) (*httptest.Server, *atomic.Int32) {
	t.Helper()
	var calls atomic.Int32
	llm := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		var req struct {
			Instructions string
			Input        []struct{ Content []struct{ Text string } }
		}
		body, _ := io.ReadAll(r.Body)
		if err := json.Unmarshal(body, &req); err != nil {
			t.Errorf("request: %v", err)
		}
		answer := lessonThreeWords
		if text := req.Input[0].Content[0].Text; strings.Contains(req.Instructions, "short Vietnamese notes") {
			var needs radicals.Needs
			if err := json.Unmarshal([]byte(text[strings.Index(text, "{"):]), &needs); err != nil {
				t.Errorf("details payload: %v", err)
			}
			notes := map[string]map[string]any{"words": {}, "chars": {}, "components": {}}
			for _, c := range needs.Chars {
				notes["chars"][c.Char] = "nghĩa " + c.Char
			}
			for _, c := range needs.Components {
				notes["components"][c.Component] = radicals.ComponentInfo{Name: "Bộ " + c.Component, Pinyin: "—", Meaning: "nghĩa"}
			}
			b, _ := json.Marshal(notes)
			answer = string(b)
		}
		reply, _ := json.Marshal(map[string]any{"status": "completed", "output": []any{
			map[string]any{"type": "message", "content": []any{map[string]any{"type": "output_text", "text": answer}}},
		}})
		_, _ = w.Write(reply)
	}))
	t.Cleanup(llm.Close)
	return llm, &calls
}

// radicalsJobOf makes alice's Radicals job with the real generator over radicalsModel.
func radicalsJobOf(t *testing.T, env *testEnv, token string) (*store.Job, *atomic.Int32) {
	t.Helper()
	llm, calls := radicalsModel(t)
	env.srv.Generator = csvgen.NewClient(llm.URL, "key", "m", "", 0, slog.New(slog.DiscardHandler))
	if rec := env.upload(t, upload{token: token, query: radicalsQuery}); rec.Code != http.StatusAccepted {
		t.Fatalf("create: %d %q", rec.Code, rec.Body)
	}
	listed := env.onlyJob(t, "alice")
	job, err := env.jobs.Get(context.Background(), "alice", listed.ID)
	if err != nil || job.Status != store.JobDone || job.Source == "" {
		t.Fatalf("job %+v %v", job, err)
	}
	return job, calls
}

func (e *testEnv) radicals(t *testing.T, method, token, id, body string) *httptest.ResponseRecorder {
	t.Helper()
	var reader io.Reader
	if body != "" {
		reader = strings.NewReader(body)
	}
	req := httptest.NewRequest(method, "/api/csv/jobs/"+id+"/radicals", reader)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	return e.do(req)
}

func readEdit(t *testing.T, rec *httptest.ResponseRecorder) csvgen.RadicalsEdit {
	t.Helper()
	var edit csvgen.RadicalsEdit
	if err := json.NewDecoder(rec.Body).Decode(&edit); err != nil {
		t.Fatal(err)
	}
	return edit
}

func setMeaning(edit *csvgen.RadicalsEdit, hanzi, meaning string) {
	for i := range edit.Words {
		if edit.Words[i].Hanzi == hanzi {
			edit.Words[i].Meaning = meaning
		}
	}
}

func marshalEdit(t *testing.T, edit csvgen.RadicalsEdit) string {
	t.Helper()
	b, err := json.Marshal(edit)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestReviseRadicalsRebuildsWithoutTheModel(t *testing.T) {
	env := newEnv(t)
	token, _ := env.login(t, "alice", "pw")
	job, calls := radicalsJobOf(t, env, token)

	// The list carries the exercise, never the source.
	listed := env.listJobs(t, token)
	if _, ok := listed[0]["source"]; ok || listed[0]["csv"] != job.CSV {
		t.Fatalf("listed job %v", listed[0])
	}

	rec := env.radicals(t, http.MethodGet, token, job.ID, "")
	if rec.Code != http.StatusOK || rec.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("table: %d %q", rec.Code, rec.Body)
	}
	edit := readEdit(t, rec)
	if len(edit.Words) != 12 || !slices.ContainsFunc(edit.Words, func(w csvgen.EditWord) bool { return w.Hanzi == "图书馆" && w.Meaning == "thư viện" && w.AI }) {
		t.Fatalf("words %+v", edit.Words)
	}

	// The user's AI calls are used up: a correction still goes through, since it asks no model.
	if rec := env.upload(t, upload{token: token, query: radicalsQuery}); rec.Code != http.StatusAccepted {
		t.Fatalf("second create: %d %q", rec.Code, rec.Body)
	}
	if rec := env.upload(t, upload{token: token, query: radicalsQuery}); rec.Code != http.StatusForbidden {
		t.Fatalf("third create: %d %q", rec.Code, rec.Body)
	}
	user, _ := env.users.FindByUsername(context.Background(), "alice")
	modelCalls, aiCalls := calls.Load(), user.AICallCountInRound

	setMeaning(&edit, "图书馆", "nhà sách mới")
	rec = env.radicals(t, http.MethodPut, token, job.ID, marshalEdit(t, edit))
	if rec.Code != http.StatusOK || rec.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("revise: %d %q", rec.Code, rec.Body)
	}
	var view jobView
	if err := json.NewDecoder(rec.Body).Decode(&view); err != nil {
		t.Fatal(err)
	}
	if view.ID != job.ID || view.Status != "done" || !strings.Contains(view.CSV, "nhà sách mới") || strings.Contains(view.CSV, `"vi":"thư viện"`) {
		t.Fatalf("revised job %+v", view)
	}
	if user, _ = env.users.FindByUsername(context.Background(), "alice"); calls.Load() != modelCalls || user.AICallCountInRound != aiCalls {
		t.Fatalf("model calls %d → %d, AI calls %d → %d", modelCalls, calls.Load(), aiCalls, user.AICallCountInRound)
	}

	// The page and the next table show the correction.
	if page := env.page(t, token, job.ID); page.Code != http.StatusOK || !strings.Contains(page.Body.String(), "nhà sách mới") {
		t.Fatalf("page: %d", page.Code)
	}
	again := readEdit(t, env.radicals(t, http.MethodGet, token, job.ID, ""))
	if !slices.ContainsFunc(again.Words, func(w csvgen.EditWord) bool { return w.Hanzi == "图书馆" && w.Meaning == "nhà sách mới" }) {
		t.Fatalf("words after the correction %+v", again.Words)
	}
}

func TestReviseRadicalsRefusals(t *testing.T) {
	env := newEnv(t)
	token, _ := env.login(t, "alice", "pw")
	job, _ := radicalsJobOf(t, env, token)
	edit := readEdit(t, env.radicals(t, http.MethodGet, token, job.ID, ""))
	unchanged := func() {
		t.Helper()
		if now, _ := env.jobs.Get(context.Background(), "alice", job.ID); now.CSV != job.CSV || now.Source != job.Source {
			t.Fatal("a refused correction changed the job")
		}
	}

	for _, method := range []string{http.MethodGet, http.MethodPut} {
		if rec := env.radicals(t, method, "", job.ID, "{}"); rec.Code != http.StatusUnauthorized {
			t.Errorf("%s without a token: %d", method, rec.Code)
		}
		if rec := env.radicals(t, method, token, "missing", "{}"); rec.Code != http.StatusNotFound || rec.Body.String() != "Job not found" {
			t.Errorf("%s of a missing job: %d %q", method, rec.Code, rec.Body)
		}
	}
	env.createUser(t, "bob", "pw", []string{"User"})
	bobToken, _ := env.login(t, "bob", "pw")
	if rec := env.radicals(t, http.MethodPut, bobToken, job.ID, marshalEdit(t, edit)); rec.Code != http.StatusNotFound {
		t.Errorf("another user's job: %d", rec.Code)
	}

	for _, c := range []struct {
		body   string
		status int
		text   string
	}{
		{"", http.StatusBadRequest, "Missing body"},
		{"[", http.StatusBadRequest, "Invalid payload"},
		{`{"words":[{"hanzi":"飞机","pinyin":"fēijī","meaning":"máy bay"}]}`, http.StatusBadRequest, "Invalid corrections."},
		{`{"chars":[{"char":"图书","meaning":"x"}]}`, http.StatusBadRequest, "Invalid corrections."},
	} {
		if rec := env.radicals(t, http.MethodPut, token, job.ID, c.body); rec.Code != c.status || rec.Body.String() != c.text {
			t.Errorf("body %q: %d %q", c.body, rec.Code, rec.Body)
		}
	}
	unchanged()

	// A pinyin that does not cut into its characters' syllables comes back flagged, and nothing is saved.
	flagged := edit
	flagged.Words = slices.Clone(edit.Words)
	for i := range flagged.Words {
		if flagged.Words[i].Hanzi == "借" {
			flagged.Words[i].Pinyin = "jiexyz"
		}
	}
	rec := env.radicals(t, http.MethodPut, token, job.ID, marshalEdit(t, flagged))
	if rec.Code != http.StatusUnprocessableEntity || !strings.HasPrefix(rec.Header().Get("Content-Type"), "application/json") {
		t.Fatalf("bad pinyin: %d %q", rec.Code, rec.Body)
	}
	table := readEdit(t, rec)
	if !slices.ContainsFunc(table.Words, func(w csvgen.EditWord) bool {
		return w.Hanzi == "借" && w.Pinyin == "jiexyz" && w.Problem == csvgen.ProblemPinyin
	}) {
		t.Fatalf("flagged table %+v", table.Words)
	}
	unchanged()

	// Without any pinyin, no lesson is left to group.
	cleared := edit
	cleared.Words = slices.Clone(edit.Words)
	for i := range cleared.Words {
		cleared.Words[i].Pinyin = ""
	}
	if rec := env.radicals(t, http.MethodPut, token, job.ID, marshalEdit(t, cleared)); rec.Code != http.StatusConflict ||
		rec.Body.String() != radicals.ErrNothingToPlay.Error() {
		t.Fatalf("no pinyin: %d %q", rec.Code, rec.Body)
	}
	unchanged()
}

func TestRadicalsEditNeedsAnExerciseWithItsSource(t *testing.T) {
	env := newEnv(t)
	token, _ := env.login(t, "alice", "pw")
	env.upload(t, upload{token: token, query: "?isCreative=true&exportType=0&courseType=2&courseName=Boya&lessonNumbers=1"})
	gimkit := env.onlyJob(t, "alice")
	// A Radicals job made before the source was kept.
	env.gen.result = exercise(t)
	env.upload(t, upload{token: token, query: radicalsQuery})
	jobs, _ := env.jobs.List(context.Background(), "alice", 10)
	old := jobs[slices.IndexFunc(jobs, func(j store.Job) bool { return j.ID != gimkit.ID })]

	for _, method := range []string{http.MethodGet, http.MethodPut} {
		if rec := env.radicals(t, method, token, gimkit.ID, "{}"); rec.Code != http.StatusConflict || rec.Body.String() != "Job is not a finished radicals exercise." {
			t.Errorf("%s of a GimKit job: %d %q", method, rec.Code, rec.Body)
		}
		if rec := env.radicals(t, method, token, old.ID, "{}"); rec.Code != http.StatusConflict || rec.Body.String() != "Job cannot be edited." {
			t.Errorf("%s of a job without its source: %d %q", method, rec.Code, rec.Body)
		}
	}
	// Its page still opens.
	if rec := env.page(t, token, old.ID); rec.Code != http.StatusOK {
		t.Fatalf("page of a job without its source: %d", rec.Code)
	}
}
