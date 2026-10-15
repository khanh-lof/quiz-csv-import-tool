package api

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"quiz-csv-import-tool/server/internal/gesturequiz"
	"quiz-csv-import-tool/server/internal/store"
)

// ---- fixtures ----

// quizRows is n rows of a stage as the AI would write them. Every question and answer carries its stage and
// its number, so a test can tell them apart, and every explanation starts with EXPL, so a test can tell that
// none has leaked into a reply that must not hold it.
func quizRows(stage, n int) string {
	var rows []string
	for k := 1; k <= n; k++ {
		q, why := fmt.Sprintf("Q%d-%d", stage, k), fmt.Sprintf("EXPL-%d-%d", stage, k)
		switch stage {
		case 1:
			answer := "Đúng"
			if k%2 == 0 {
				answer = "Sai"
			}
			rows = append(rows, fmt.Sprintf("1,%s,%s,,,,%s", q, answer, why))
		case 2:
			rows = append(rows, fmt.Sprintf("2,%s,R2-%d,W2-%d,,,%s", q, k, k, why))
		case 3, 4:
			rows = append(rows, fmt.Sprintf("%d,%s,R%d-%d,W%d-%da,W%d-%db,,%s", stage, q, stage, k, stage, k, stage, k, why))
		case 5:
			rows = append(rows, fmt.Sprintf("5,%s,R5-%d,W5-%da,W5-%db,W5-%dc,%s", q, k, k, k, k, why))
		case 6:
			rows = append(rows, fmt.Sprintf("6,%s,A6-%d / B6-%d / C6-%d,,,,%s", q, k, k, k, why))
		}
	}
	return strings.Join(rows, "\n") + "\n"
}

// quizCSV is the rows of every stage that has questions, easiest first.
func quizCSV(counts map[int]int) string {
	var csv string
	for stage := 1; stage <= 6; stage++ {
		if counts[stage] > 0 {
			csv += quizRows(stage, counts[stage])
		}
	}
	return csv
}

// gestureCSV is what the seeded job holds: stage 1 of 5 questions and stage 2 of 10. The assignment must
// copy it as it is.
var gestureCSV = quizCSV(map[int]int{1: 5, 2: 10})

// fullCSV has all six games, three questions each in the last four.
var fullCSV = quizCSV(map[int]int{1: 5, 2: 10, 3: 3, 4: 3, 5: 3, 6: 3})

// ---- what a student's page sees ----

type dealtQuestion struct {
	Index      int      `json:"index"`
	Question   string   `json:"question"`
	Options    []string `json:"options"`
	Chunks     []string `json:"chunks"`
	TimeLeftMs *int64   `json:"timeLeftMs"`
	GraceMs    int64    `json:"graceMs"`
}

type startedRun struct {
	RunID    string        `json:"runId"`
	Stage    int           `json:"stage"`
	Total    int           `json:"total"`
	Attempts int           `json:"attempts"`
	Question dealtQuestion `json:"question"`
}

// ---- the student's requests ----

func (c *classroom) quizText() string {
	if c.csv == "" {
		return gestureCSV
	}
	return c.csv
}

func (c *classroom) shareURL(path string) string { return "/api/share/" + c.a.Code + path }

func (c *classroom) startRun(token string, stage int) *httptest.ResponseRecorder {
	return c.startRunBody(token, jsonOf(map[string]any{"stage": stage}))
}

func (c *classroom) startRunBody(token, body string) *httptest.ResponseRecorder {
	return c.send(http.MethodPost, c.shareURL("/runs"), body, header(playerTokenHeader, token))
}

func (c *classroom) nextQuestion(token, runID string) *httptest.ResponseRecorder {
	return c.send(http.MethodPost, c.shareURL("/runs/"+runID+"/next"), "", header(playerTokenHeader, token))
}

func (c *classroom) answerBody(token, runID, body string) *httptest.ResponseRecorder {
	return c.send(http.MethodPost, c.shareURL("/runs/"+runID+"/answers"), body, header(playerTokenHeader, token))
}

func (c *classroom) answer(token, runID string, index int, choice any) *httptest.ResponseRecorder {
	return c.answerBody(token, runID, jsonOf(map[string]any{"index": index, "choice": choice}))
}

// start starts a run that must be accepted.
func (c *classroom) start(t *testing.T, token string, stage int) startedRun {
	t.Helper()
	rec := c.startRun(token, stage)
	wantStatus(t, rec, http.StatusCreated)
	return decode[startedRun](t, rec)
}

// next asks for the next question and must get one.
func (c *classroom) next(t *testing.T, token, runID string) dealtQuestion {
	t.Helper()
	rec := c.nextQuestion(token, runID)
	wantStatus(t, rec, http.StatusOK)
	return decode[struct{ Question dealtQuestion }](t, rec).Question
}

// answerOK answers a question and must get a verdict.
func (c *classroom) answerOK(t *testing.T, token, runID string, index int, choice any) verdict {
	t.Helper()
	rec := c.answer(token, runID, index, choice)
	wantStatus(t, rec, http.StatusOK)
	return decode[verdict](t, rec)
}

// source is the quiz's own question behind a dealt one, found by its text.
func (c *classroom) source(t *testing.T, stage int, text string) gesturequiz.Question {
	t.Helper()
	for _, q := range gesturequiz.Parse(c.quizText()).Stages[stage] {
		if q.Question == text {
			return q
		}
	}
	t.Fatalf("no question %q in stage %d", text, stage)
	return gesturequiz.Question{}
}

// choice is the choice that answers the dealt question right, or one that answers it wrong.
func (c *classroom) choice(t *testing.T, stage int, q dealtQuestion, right bool) any {
	t.Helper()
	source := c.source(t, stage, q.Question)
	if stage == gesturequiz.WordOrderStage {
		if right {
			return source.Chunks
		}
		wrong := slices.Clone(source.Chunks)
		slices.Reverse(wrong)
		return wrong
	}
	at := slices.Index(q.Options, source.Correct)
	if at < 0 {
		t.Fatalf("question %q does not offer its answer %q: %v", q.Question, source.Correct, q.Options)
	}
	if right {
		return at
	}
	return (at + 1) % len(q.Options)
}

// complete plays a started run to its end, the first `correct` questions right and the rest wrong, and
// returns the verdict of the last, which holds the result.
func (c *classroom) complete(t *testing.T, token string, run startedRun, correct int) verdict {
	t.Helper()
	q := run.Question
	for i := range run.Total {
		if q.Index != i {
			t.Fatalf("question %d is dealt as index %d", i, q.Index)
		}
		v := c.answerOK(t, token, run.RunID, i, c.choice(t, run.Stage, q, i < correct))
		if i == run.Total-1 {
			if v.Result == nil {
				t.Fatalf("the last verdict has no result: %+v", v)
			}
			return v
		}
		q = c.next(t, token, run.RunID)
	}
	t.Fatal("a run with no questions")
	return verdict{}
}

// finish plays a whole run of the stage with `correct` right answers and returns the last verdict.
func (c *classroom) finish(t *testing.T, token string, stage, correct int) verdict {
	t.Helper()
	return c.complete(t, token, c.start(t, token, stage), correct)
}

// playerOf is what the store holds of the student with that token, run included.
func (c *classroom) playerOf(t *testing.T, token string) *store.Player {
	t.Helper()
	p, err := c.assignments.PlayerByToken(context.Background(), c.a.ID, hashPlayerToken(token))
	if err != nil {
		t.Fatal(err)
	}
	return p
}

// newClassroomCSV is newClassroom for a job that holds another quiz.
func newClassroomCSV(t *testing.T, csv string, createOverrides map[string]any) *classroom {
	t.Helper()
	env := newEnv(t)
	env.seedJob(t, "alice", "job1", func(j *store.Job) { j.CSV = csv })
	token, _ := env.login(t, "alice", "pw")
	c := &classroom{testEnv: env, token: token, csv: csv}
	rec := c.teacher(http.MethodPost, "/api/assignments", createBody(createOverrides))
	wantStatus(t, rec, http.StatusCreated)
	c.a = decode[assignmentView](t, rec)
	return c
}

// wantNoAnswers fails when a reply that must not give an answer away holds a field that would, or any of
// the explanations.
func wantNoAnswers(t *testing.T, rec *httptest.ResponseRecorder) {
	t.Helper()
	body := rec.Body.String()
	for _, leak := range []string{"EXPL", "explanation", "correctIndex", "correctOrder", `"answer"`, `"correct"`} {
		if strings.Contains(body, leak) {
			t.Fatalf("a question reply holds %q: %s", leak, body)
		}
	}
}

// ---- starting a run ----

func TestPlayAWholeStageOfEveryGame(t *testing.T) {
	c := newClassroomCSV(t, fullCSV, map[string]any{"stageLock": "open"})
	_, token := c.join(t, "Lan")
	quiz := gesturequiz.Parse(fullCSV)
	limits := map[int]int64{1: 12000, 2: 12000, 3: 15000, 4: 15000, 5: 20000, 6: 45000}
	optionCounts := map[int]int{1: 2, 2: 2, 3: 3, 4: 3, 5: 4, 6: 0}

	for stage := 1; stage <= 6; stage++ {
		t.Run(fmt.Sprintf("stage %d", stage), func(t *testing.T) {
			total := quiz.Count(stage)
			rec := c.startRun(token, stage)
			wantStatus(t, rec, http.StatusCreated)
			wantNoAnswers(t, rec)
			if got := rec.Header().Get("Cache-Control"); got != "no-store" {
				t.Errorf("the start is cacheable: %q", got)
			}
			raw := decode[map[string]any](t, rec)
			if got, want := keysOf(raw), []string{"attempts", "question", "runId", "stage", "total"}; !slices.Equal(got, want) {
				t.Fatalf("start keys %v, want %v", got, want)
			}
			if got, want := keysOf(raw["question"].(map[string]any)), []string{"chunks", "graceMs", "index", "options", "question", "timeLeftMs"}; !slices.Equal(got, want) {
				t.Fatalf("question keys %v, want %v", got, want)
			}
			run := decode[startedRun](t, rec)
			if len(run.RunID) != 32 || run.Stage != stage || run.Total != total || run.Attempts != 1 {
				t.Fatalf("run %+v", run)
			}

			seen := map[string]bool{}
			q := run.Question
			for i := range total {
				if q.Index != i {
					t.Fatalf("question %d is dealt as index %d", i, q.Index)
				}
				if seen[q.Question] {
					t.Fatalf("%q was dealt twice", q.Question)
				}
				seen[q.Question] = true
				source := c.source(t, stage, q.Question)

				if q.TimeLeftMs == nil || *q.TimeLeftMs != limits[stage] || q.GraceMs != 5000 {
					t.Fatalf("question %d clock: %v left, %d grace", i, q.TimeLeftMs, q.GraceMs)
				}
				switch stage {
				case 1:
					if !slices.Equal(q.Options, []string{"Đúng", "Sai"}) || q.Chunks != nil {
						t.Fatalf("true or false dealt %v %v", q.Options, q.Chunks)
					}
				case 6:
					if q.Options == nil || len(q.Options) != 0 || len(q.Chunks) != len(source.Chunks) || slices.Equal(q.Chunks, source.Chunks) ||
						!slices.Equal(slices.Sorted(slices.Values(q.Chunks)), slices.Sorted(slices.Values(source.Chunks))) {
						t.Fatalf("sentence dealt options %v, chunks %v for %v", q.Options, q.Chunks, source.Chunks)
					}
				default:
					want := slices.Sorted(slices.Values(append([]string{source.Correct}, source.Wrong...)))
					if len(q.Options) != optionCounts[stage] || !slices.Equal(slices.Sorted(slices.Values(q.Options)), want) || q.Chunks != nil {
						t.Fatalf("options %v, want the %v shuffled", q.Options, want)
					}
				}

				rec := c.answer(token, run.RunID, i, c.choice(t, stage, q, true))
				wantStatus(t, rec, http.StatusOK)
				if got := rec.Header().Get("Cache-Control"); got != "no-store" {
					t.Errorf("the verdict is cacheable: %q", got)
				}
				v := decode[verdict](t, rec)
				verdictRaw := decode[map[string]any](t, rec)
				if !v.Correct || v.TimedOut || v.Answer != source.Correct || v.Explanation != source.Explanation {
					t.Fatalf("verdict %+v for %+v", v, source)
				}
				if stage == 6 {
					if !slices.Equal(v.CorrectOrder, source.Chunks) || v.CorrectIndex != nil || verdictRaw["correctIndex"] != nil {
						t.Fatalf("sentence verdict %+v", v)
					}
				} else if v.CorrectIndex == nil || q.Options[*v.CorrectIndex] != source.Correct || v.CorrectOrder != nil || verdictRaw["correctOrder"] != nil {
					t.Fatalf("option verdict %+v", v)
				}
				if _, has := verdictRaw["result"]; !has {
					t.Fatalf("the verdict has no result key: %v", verdictRaw)
				}

				if i == total-1 {
					if v.Result == nil || *v.Result != (runResult{Correct: total, Total: total, Passed: true}) {
						t.Fatalf("last verdict %+v", v)
					}
					break
				}
				if v.Result != nil {
					t.Fatalf("a result before the last question: %+v", v)
				}
				rec = c.nextQuestion(token, run.RunID)
				wantStatus(t, rec, http.StatusOK)
				wantNoAnswers(t, rec)
				if got, want := keysOf(decode[map[string]any](t, rec)), []string{"question"}; !slices.Equal(got, want) {
					t.Fatalf("next keys %v, want %v", got, want)
				}
				q = decode[struct{ Question dealtQuestion }](t, rec).Question
			}
			if len(seen) != total {
				t.Fatalf("%d of %d questions were dealt", len(seen), total)
			}

			// The run is over: there is no question after the last, and the score is recorded.
			wantError(t, c.nextQuestion(token, run.RunID), http.StatusConflict, "Run is over")
			lan := c.detail(t).Players[0]
			if got, want := lan.Stages[fmt.Sprint(stage)], (stageScore{Correct: total, Total: total, Passed: true, Attempts: 1}); got != want {
				t.Fatalf("stage %d on the leaderboard: %+v, want %+v", stage, got, want)
			}
		})
	}
	if lan := c.detail(t).Players[0]; lan.StagesPassed != 6 || lan.Correct != quiz.Total() || lan.Possible != quiz.Total() {
		t.Fatalf("lan %+v", lan)
	}
}

// Two runs of one stage ask the questions in different orders and show the options in different orders:
// the server shuffles, and the page does not have to.
func TestRunsAreShuffled(t *testing.T) {
	c := newClassroomCSV(t, quizCSV(map[int]int{1: 10, 2: 10, 6: 6}), map[string]any{"stageLock": "open"})
	_, token := c.join(t, "Lan")
	for stage, field := range map[int]string{2: "questions", 6: "chunks"} {
		orders := map[string]bool{}
		for range 8 {
			run := c.start(t, token, stage)
			var order []string
			q := run.Question
			for i := range run.Total {
				order = append(order, q.Question)
				if field == "chunks" {
					order = append(order, strings.Join(q.Chunks, ","))
				} else {
					order = append(order, strings.Join(q.Options, ","))
				}
				if i < run.Total-1 {
					c.answerOK(t, token, run.RunID, i, c.choice(t, stage, q, true))
					q = c.next(t, token, run.RunID)
				}
			}
			orders[strings.Join(order, ";")] = true
		}
		if len(orders) < 4 {
			t.Errorf("stage %d: only %d different runs out of 8", stage, len(orders))
		}
	}
}

func TestStartRunValidation(t *testing.T) {
	c := newClassroomCSV(t, quizCSV(map[int]int{1: 5, 4: 5}), nil) // sequential, stages 1 and 4
	_, token := c.join(t, "Lan")

	for name, tt := range map[string]struct{ body, status string }{
		"stage missing":                {`{}`, "Invalid stage."},
		"stage zero":                   {`{"stage":0}`, "Invalid stage."},
		"negative stage":               {`{"stage":-1}`, "Invalid stage."},
		"stage 7":                      {`{"stage":7}`, "Invalid stage."},
		"a stage the quiz lacks":       {`{"stage":2}`, "Invalid stage."},
		"a stage the quiz lacks, last": {`{"stage":6}`, "Invalid stage."},
		"stage as a string":            {`{"stage":"1"}`, "Invalid payload"},
		"stage as a fraction":          {`{"stage":1.5}`, "Invalid payload"},
		"not json":                     {`nope`, "Invalid payload"},
		"no body":                      {``, "Missing body"},
	} {
		t.Run(name, func(t *testing.T) {
			wantError(t, c.startRunBody(token, tt.body), http.StatusBadRequest, tt.status)
		})
	}
	// A stage the quiz lacks is a 400 before the lock is looked at; a stage it has is locked, not invalid.
	wantError(t, c.startRun(token, 4), http.StatusConflict, "Stage locked")

	// None of them started anything.
	if p := c.playerOf(t, token); len(p.Started) != 0 || p.Run != nil || p.LastPlayedAt != nil {
		t.Fatalf("player %+v", p)
	}
	raw := decode[map[string]any](t, c.send(http.MethodGet, c.shareURL(""), "", header(playerTokenHeader, token)))
	if attempts, _ := raw["attempts"].(map[string]any); len(attempts) != 0 {
		t.Fatalf("attempts %v", attempts)
	}
}

func TestRunRoutesNeedAKnownPlayer(t *testing.T) {
	c := newClassroom(t, nil)
	_, lanToken := c.join(t, "Lan")
	run := c.start(t, lanToken, 1)
	players, _ := c.assignments.ListPlayers(context.Background(), c.a.ID)
	other := decode[assignmentView](t, c.teacher(http.MethodPost, "/api/assignments", createBody(nil)))
	otherURL := "/api/share/" + other.Code

	type route struct {
		name   string
		method string
		path   string
		body   string
	}
	routes := []route{
		{"start", http.MethodPost, c.shareURL("/runs"), `{"stage":1}`},
		{"next", http.MethodPost, c.shareURL("/runs/" + run.RunID + "/next"), ""},
		{"answer", http.MethodPost, c.shareURL("/runs/" + run.RunID + "/answers"), `{"index":0,"choice":0}`},
	}
	for _, rt := range routes {
		for _, opts := range [][]reqOpt{
			nil, // no token
			{header(playerTokenHeader, "")},
			{header(playerTokenHeader, "not-a-token")},
			{header(playerTokenHeader, players[0].TokenHash)}, // the stored hash is not the token
			{header(playerTokenHeader, lanToken+"\n")},
		} {
			wantError(t, c.send(rt.method, rt.path, rt.body, opts...), http.StatusForbidden, "Unknown player")
		}
		// The token is checked before the body is read.
		wantError(t, c.send(rt.method, rt.path, "nope"), http.StatusForbidden, "Unknown player")
		// A token is good for its own assignment only.
		path := strings.Replace(rt.path, "/api/share/"+c.a.Code, otherURL, 1)
		wantError(t, c.send(rt.method, path, rt.body, header(playerTokenHeader, lanToken)), http.StatusForbidden, "Unknown player")
	}

	// A student the teacher removed has lost the run with the rest.
	wantStatus(t, c.teacher(http.MethodDelete, "/api/assignments/"+c.a.ID+"/players/"+players[0].ID, ""), http.StatusNoContent)
	for _, rt := range routes {
		wantError(t, c.send(rt.method, rt.path, rt.body, header(playerTokenHeader, lanToken)), http.StatusForbidden, "Unknown player")
	}
}

// ---- the stage lock and the replay limit ----

func TestSequentialStageLock(t *testing.T) {
	c := newClassroomCSV(t, quizCSV(map[int]int{1: 5, 2: 5, 4: 5, 6: 5}), nil)
	_, token := c.join(t, "Lan")

	// Only the first stage the quiz has is open, and a refused start is not an attempt.
	for _, stage := range []int{2, 4, 6} {
		wantError(t, c.startRun(token, stage), http.StatusConflict, "Stage locked")
	}
	if p := c.playerOf(t, token); len(p.Started) != 0 || p.Run != nil {
		t.Fatalf("a refused start left %+v", p)
	}

	// A stage that is played but not passed keeps the next one shut.
	if v := c.finish(t, token, 1, 3); v.Result.Passed {
		t.Fatalf("3 of 5 passed: %+v", v.Result)
	}
	wantError(t, c.startRun(token, 2), http.StatusConflict, "Stage locked")
	if v := c.finish(t, token, 1, 4); !v.Result.Passed {
		t.Fatalf("4 of 5 did not pass: %+v", v.Result)
	}

	// Stage 2 is open now, and stage 4 waits for it; every stage before it has to be passed, not only the
	// one just before.
	wantError(t, c.startRun(token, 4), http.StatusConflict, "Stage locked")
	wantError(t, c.startRun(token, 6), http.StatusConflict, "Stage locked")
	c.finish(t, token, 2, 5)
	c.finish(t, token, 4, 5)
	wantStatus(t, c.startRun(token, 6), http.StatusCreated)
	// A passed stage can be played again.
	wantStatus(t, c.startRun(token, 1), http.StatusCreated)

	// The stages the quiz does not have block nothing: a quiz of stages 4 and 6 opens at 4.
	d := newClassroomCSV(t, quizCSV(map[int]int{4: 5, 6: 5}), nil)
	_, dToken := d.join(t, "Lan")
	wantError(t, d.startRun(dToken, 6), http.StatusConflict, "Stage locked")
	wantStatus(t, d.startRun(dToken, 4), http.StatusCreated)
}

func TestOpenStageLockAllowsAnyStage(t *testing.T) {
	c := newClassroomCSV(t, quizCSV(map[int]int{1: 5, 2: 5, 4: 5, 6: 5}), map[string]any{"stageLock": "open"})
	_, token := c.join(t, "Lan")
	for _, stage := range []int{6, 4, 2, 1} {
		wantStatus(t, c.startRun(token, stage), http.StatusCreated)
	}
	// A stage the quiz does not have is still refused.
	wantError(t, c.startRunBody(token, `{"stage":3}`), http.StatusBadRequest, "Invalid stage.")
}

func TestAStageLockedStartDoesNotReplaceTheRun(t *testing.T) {
	c := newClassroom(t, nil)
	_, token := c.join(t, "Lan")
	run := c.start(t, token, 1)
	wantError(t, c.startRun(token, 2), http.StatusConflict, "Stage locked")
	// The run in progress is the one it was.
	c.answerOK(t, token, run.RunID, 0, c.choice(t, 1, run.Question, true))
}

func TestReplayLimitCountsEveryStartedRun(t *testing.T) {
	c := newClassroom(t, map[string]any{"stageLock": "open", "maxAttempts": 2})
	_, token := c.join(t, "Lan")

	// A run left after one answer counts, and so does the one that replaces it.
	first := c.start(t, token, 1)
	c.answerOK(t, token, first.RunID, 0, c.choice(t, 1, first.Question, true))
	second := c.start(t, token, 1)
	if first.Attempts != 1 || second.Attempts != 2 {
		t.Fatalf("attempts %d then %d", first.Attempts, second.Attempts)
	}
	wantError(t, c.startRun(token, 1), http.StatusConflict, "Replay limit reached")
	wantError(t, c.startRun(token, 1), http.StatusConflict, "Replay limit reached")

	// A refused start leaves the run in progress alone, and it can still be finished.
	v := c.complete(t, token, second, 5)
	if !v.Result.Passed || v.Result.Correct != 5 {
		t.Fatalf("result %+v", v.Result)
	}
	wantError(t, c.startRun(token, 1), http.StatusConflict, "Replay limit reached")

	// The limit is per stage and per student, and an invalid stage is a 400 before it.
	wantStatus(t, c.startRun(token, 2), http.StatusCreated)
	_, other := c.join(t, "Nam")
	wantStatus(t, c.startRun(other, 1), http.StatusCreated)
	wantError(t, c.startRunBody(token, `{"stage":9}`), http.StatusBadRequest, "Invalid stage.")

	// The share answer tells the page how many runs a stage has used.
	rec := c.send(http.MethodGet, c.shareURL(""), "", header(playerTokenHeader, token))
	if got := decode[struct{ Attempts map[string]int }](t, rec).Attempts; !reflect.DeepEqual(got, map[string]int{"1": 2, "2": 1}) {
		t.Fatalf("attempts %v", got)
	}
}

// A sequential assignment has no replay limit, whatever the stage's runs add up to.
func TestNoReplayLimitStartsManyRuns(t *testing.T) {
	for name, overrides := range map[string]map[string]any{"sequential": nil, "open": {"stageLock": "open"}} {
		c := newClassroom(t, overrides)
		_, token := c.join(t, "Lan")
		for i := range 15 {
			if run := c.start(t, token, 1); run.Attempts != i+1 {
				t.Fatalf("%s: run %d has attempts %d", name, i+1, run.Attempts)
			}
		}
	}
}

// ---- time ----

func TestAWrongAnswerATimeoutAndALateAnswer(t *testing.T) {
	c := newClassroom(t, map[string]any{"stageLock": "open"}) // stage 2: ten questions, 12 s and 5 s of grace
	_, token := c.join(t, "Lan")
	run := c.start(t, token, 2)
	q := run.Question

	// A wrong answer: not a timeout, and the right one is shown.
	v := c.answerOK(t, token, run.RunID, 0, c.choice(t, 2, q, false))
	source := c.source(t, 2, q.Question)
	if v.Correct || v.TimedOut || v.CorrectIndex == nil || q.Options[*v.CorrectIndex] != source.Correct || v.Answer != source.Correct || v.Explanation != source.Explanation {
		t.Fatalf("wrong answer: %+v", v)
	}

	// No choice at all is a timeout, which the browser reports when its own clock ran out.
	q = c.next(t, token, run.RunID)
	v = c.answerOK(t, token, run.RunID, 1, nil)
	source = c.source(t, 2, q.Question)
	if v.Correct || !v.TimedOut || v.CorrectIndex == nil || q.Options[*v.CorrectIndex] != source.Correct || v.Answer != source.Correct {
		t.Fatalf("null choice: %+v", v)
	}

	// An answer exactly at the limit plus the grace is still on time.
	q = c.next(t, token, run.RunID)
	c.clock.Advance(17 * time.Second)
	if v = c.answerOK(t, token, run.RunID, 2, c.choice(t, 2, q, true)); !v.Correct || v.TimedOut {
		t.Fatalf("an answer at 17 s: %+v", v)
	}

	// A millisecond later it is a timeout, even for the right choice, and the right answer is still shown.
	q = c.next(t, token, run.RunID)
	c.clock.Advance(17*time.Second + time.Millisecond)
	v = c.answerOK(t, token, run.RunID, 3, c.choice(t, 2, q, true))
	source = c.source(t, 2, q.Question)
	if v.Correct || !v.TimedOut || v.CorrectIndex == nil || q.Options[*v.CorrectIndex] != source.Correct {
		t.Fatalf("a late answer: %+v", v)
	}

	// Six right answers and the one before make seven of ten, which passes.
	q = c.next(t, token, run.RunID)
	for i := 4; i < 10; i++ {
		v = c.answerOK(t, token, run.RunID, i, c.choice(t, 2, q, true))
		if i < 9 {
			q = c.next(t, token, run.RunID)
		}
	}
	if v.Result == nil || *v.Result != (runResult{Correct: 7, Total: 10, Passed: true}) {
		t.Fatalf("result %+v", v.Result)
	}
	if lan := c.detail(t).Players[0]; lan.Stages["2"] != (stageScore{Correct: 7, Total: 10, Passed: true, Attempts: 1}) {
		t.Fatalf("lan %+v", lan)
	}
}

// A timed out last question finishes the run like any other.
func TestATimeoutOnTheLastQuestionFinishesTheRun(t *testing.T) {
	c := newClassroom(t, nil)
	_, token := c.join(t, "Lan")
	run := c.start(t, token, 1)
	q := run.Question
	for i := range 4 {
		c.answerOK(t, token, run.RunID, i, c.choice(t, 1, q, true))
		q = c.next(t, token, run.RunID)
	}
	v := c.answerOK(t, token, run.RunID, 4, nil)
	if !v.TimedOut || v.Result == nil || *v.Result != (runResult{Correct: 4, Total: 5, Passed: true}) {
		t.Fatalf("last verdict %+v", v)
	}
}

func TestUnlimitedTimeHasNoDeadline(t *testing.T) {
	c := newClassroom(t, map[string]any{"timeMode": "unlimited"})
	_, token := c.join(t, "Lan")
	rec := c.startRun(token, 1)
	wantStatus(t, rec, http.StatusCreated)
	question := decode[map[string]any](t, rec)["question"].(map[string]any)
	if left, has := question["timeLeftMs"]; !has || left != nil || question["graceMs"] != float64(5000) {
		t.Fatalf("question %v", question)
	}
	run := decode[startedRun](t, rec)

	// Hours later the answer still counts.
	c.clock.Advance(100 * time.Hour)
	if v := c.answerOK(t, token, run.RunID, 0, c.choice(t, 1, run.Question, true)); !v.Correct || v.TimedOut {
		t.Fatalf("an answer after 100 hours: %+v", v)
	}
	q := c.next(t, token, run.RunID)
	if q.TimeLeftMs != nil {
		t.Fatalf("the next question has a clock: %d", *q.TimeLeftMs)
	}
	c.clock.Advance(100 * time.Hour)
	// A choice of null is still a timeout: the student gave up the question.
	if v := c.answerOK(t, token, run.RunID, 1, nil); !v.TimedOut || v.Correct {
		t.Fatalf("a null choice: %+v", v)
	}
	// The question after it has no clock either, and asking for it again does not give it one.
	for range 2 {
		if q = c.next(t, token, run.RunID); q.TimeLeftMs != nil || q.Index != 2 {
			t.Fatalf("question %+v", q)
		}
	}
}

func TestExtraTimeIsOneAndAHalfTimes(t *testing.T) {
	c := newClassroomCSV(t, fullCSV, map[string]any{"stageLock": "open", "timeMode": "extra"})
	_, token := c.join(t, "Lan")
	for stage, want := range map[int]int64{1: 18000, 2: 18000, 3: 23000, 4: 23000, 5: 30000, 6: 68000} {
		if got := c.start(t, token, stage).Question.TimeLeftMs; got == nil || *got != want {
			t.Errorf("stage %d: %v, want %d", stage, got, want)
		}
	}

	// The deadline is the extra time plus the grace: 23 s for a 12 s question, 18 s would be too early to refuse.
	run := c.start(t, token, 1)
	c.clock.Advance(23 * time.Second)
	if v := c.answerOK(t, token, run.RunID, 0, c.choice(t, 1, run.Question, true)); !v.Correct || v.TimedOut {
		t.Fatalf("an answer at 23 s: %+v", v)
	}
	q := c.next(t, token, run.RunID)
	c.clock.Advance(23*time.Second + time.Millisecond)
	if v := c.answerOK(t, token, run.RunID, 1, c.choice(t, 1, q, true)); v.Correct || !v.TimedOut {
		t.Fatalf("an answer at 23 s and a millisecond: %+v", v)
	}
}

func TestNextReservesTheSameQuestionWithoutResettingItsClock(t *testing.T) {
	c := newClassroom(t, nil)
	_, token := c.join(t, "Lan")
	run := c.start(t, token, 1)

	// Asking again, as a page does after a reload or a lost reply, shows the same question with less time.
	c.clock.Advance(5 * time.Second)
	again := c.next(t, token, run.RunID)
	if again.Index != 0 || again.Question != run.Question.Question || !slices.Equal(again.Options, run.Question.Options) ||
		again.TimeLeftMs == nil || *again.TimeLeftMs != 7000 {
		t.Fatalf("question again: %+v", again)
	}
	c.clock.Advance(3 * time.Second)
	if again = c.next(t, token, run.RunID); *again.TimeLeftMs != 4000 {
		t.Fatalf("left %d", *again.TimeLeftMs)
	}
	// It never goes below nothing, nor above the limit.
	c.clock.Advance(time.Minute)
	if again = c.next(t, token, run.RunID); *again.TimeLeftMs != 0 {
		t.Fatalf("left %d", *again.TimeLeftMs)
	}
	// Asking is not a write that could buy time: the stored question was served once, at the start.
	served := c.playerOf(t, token).Run.Questions[0].ServedAt
	if served == nil || !served.Equal(testClockStart) {
		t.Fatalf("served at %v, want %v", served, testClockStart)
	}

	// The next question's clock starts when it is first asked for, and asking again does not restart it.
	c.answerOK(t, token, run.RunID, 0, c.choice(t, 1, run.Question, true))
	c.clock.Advance(time.Minute)
	q := c.next(t, token, run.RunID)
	if q.Index != 1 || *q.TimeLeftMs != 12000 {
		t.Fatalf("question 1: %+v", q)
	}
	c.clock.Advance(4 * time.Second)
	if q = c.next(t, token, run.RunID); q.Index != 1 || *q.TimeLeftMs != 8000 {
		t.Fatalf("question 1 again: %+v", q)
	}
	if got := c.playerOf(t, token).Run.Questions[1].ServedAt; got == nil || !got.Equal(testClockStart.Add(5*time.Second+3*time.Second+time.Minute+time.Minute)) {
		t.Fatalf("question 1 served at %v", got)
	}
}

// The clock of a question runs from the moment it is first dealt, whether or not the page has shown it: a
// question that was asked for and then left alone is late like any other.
func TestAQuestionAskedForRunsOutWhetherOrNotItWasShown(t *testing.T) {
	c := newClassroom(t, nil)
	_, token := c.join(t, "Lan")
	run := c.start(t, token, 1)
	c.answerOK(t, token, run.RunID, 0, c.choice(t, 1, run.Question, true))
	q := c.next(t, token, run.RunID)
	c.clock.Advance(time.Hour)
	if v := c.answerOK(t, token, run.RunID, 1, c.choice(t, 1, q, true)); !v.TimedOut || v.Correct {
		t.Fatalf("an answer an hour late: %+v", v)
	}
}

// ---- resending ----

func TestResendingAnAnswerReturnsTheStoredVerdict(t *testing.T) {
	c := newClassroom(t, nil)
	_, token := c.join(t, "Lan")
	run := c.start(t, token, 1)
	q := run.Question

	first := c.answerOK(t, token, run.RunID, 0, c.choice(t, 1, q, true))
	version := c.playerOf(t, token).Version
	// The same question again, however the choice is now (the reply was lost, or the page is confused): the
	// verdict is the first one and nothing is written or counted twice.
	for _, choice := range []any{c.choice(t, 1, q, true), c.choice(t, 1, q, false), nil, 7, []string{"x"}} {
		if got := c.answerOK(t, token, run.RunID, 0, choice); !reflect.DeepEqual(got, first) {
			t.Fatalf("resend with %v: %+v, want %+v", choice, got, first)
		}
	}
	if got := c.playerOf(t, token).Version; got != version {
		t.Fatalf("a resend wrote: version %d, was %d", got, version)
	}

	// Finish the run with the first question counted once, whatever was resent.
	q = c.next(t, token, run.RunID)
	for i := 1; i < 5; i++ {
		last := c.answerOK(t, token, run.RunID, i, c.choice(t, 1, q, i != 4))
		if i < 4 {
			q = c.next(t, token, run.RunID)
			continue
		}
		if last.Result == nil || *last.Result != (runResult{Correct: 4, Total: 5, Passed: true}) {
			t.Fatalf("result %+v", last.Result)
		}
		// The reply to the last answer is lost: asking again returns the verdict with the result.
		for _, choice := range []any{c.choice(t, 1, q, false), nil} {
			if got := c.answerOK(t, token, run.RunID, 4, choice); !reflect.DeepEqual(got, last) {
				t.Fatalf("resent last answer: %+v, want %+v", got, last)
			}
		}
	}
	// An earlier question of the finished run gives its own verdict, without a result.
	if got := c.answerOK(t, token, run.RunID, 0, 0); !reflect.DeepEqual(got, first) || got.Result != nil {
		t.Fatalf("resent first answer of a finished run: %+v", got)
	}
	if lan := c.detail(t).Players[0]; lan.Stages["1"] != (stageScore{Correct: 4, Total: 5, Passed: true, Attempts: 1}) {
		t.Fatalf("the resends changed the leaderboard: %+v", lan)
	}
	wantError(t, c.nextQuestion(token, run.RunID), http.StatusConflict, "Run is over")
}

func TestAnswersAreRefusedForAQuestionNotYetAsked(t *testing.T) {
	c := newClassroom(t, nil)
	_, token := c.join(t, "Lan")
	run := c.start(t, token, 1)
	c.answerOK(t, token, run.RunID, 0, c.choice(t, 1, run.Question, true))

	// The second question has not been dealt: next has to ask for it first, so its clock starts then.
	wantError(t, c.answer(token, run.RunID, 1, 0), http.StatusBadRequest, "Invalid answer.")
	c.next(t, token, run.RunID)
	wantStatus(t, c.answer(token, run.RunID, 1, 0), http.StatusOK)
}

// ---- a run is replaced, found or gone ----

func TestARunReplacedByANewOneIsNotFound(t *testing.T) {
	c := newClassroom(t, map[string]any{"stageLock": "open"})
	_, token := c.join(t, "Lan")
	_, other := c.join(t, "Nam")
	first := c.start(t, token, 1)
	c.answerOK(t, token, first.RunID, 0, c.choice(t, 1, first.Question, true))

	// Starting another run, of any stage, replaces it: a second tab cannot play beside the first.
	second := c.start(t, token, 2)
	if second.RunID == first.RunID {
		t.Fatal("two runs share an id")
	}
	wantError(t, c.nextQuestion(token, first.RunID), http.StatusNotFound, "Run not found")
	wantError(t, c.answer(token, first.RunID, 1, 0), http.StatusNotFound, "Run not found")
	// The replaced run's answers are not recorded, and its first answer did not become a result.
	for _, p := range c.detail(t).Players {
		if p.Name == "Lan" && (len(p.Stages) != 0 || p.Attempts != 2) {
			t.Fatalf("lan %+v", p)
		}
	}
	wantStatus(t, c.answer(token, second.RunID, 0, 0), http.StatusOK)

	// A run id that was never issued, another player's run and a player with no run at all.
	wantError(t, c.nextQuestion(token, "no-such-run"), http.StatusNotFound, "Run not found")
	wantError(t, c.nextQuestion(other, second.RunID), http.StatusNotFound, "Run not found")
	wantError(t, c.answer(other, second.RunID, 0, 0), http.StatusNotFound, "Run not found")
	wantError(t, c.answerBody(other, "x", "nope"), http.StatusNotFound, "Run not found") // before the body is read
}

// ---- answers: what is refused, and what is only wrong ----

func TestAnswerValidation(t *testing.T) {
	c := newClassroom(t, map[string]any{"stageLock": "open"})
	_, token := c.join(t, "Lan")
	run := c.start(t, token, 2)

	for name, tt := range map[string]struct{ body, status string }{
		"index missing":           {`{"choice":0}`, "Invalid answer."},
		"index null":              {`{"index":null,"choice":0}`, "Invalid answer."},
		"index as a string":       {`{"index":"0","choice":0}`, "Invalid answer."},
		"index as a fraction":     {`{"index":0.5,"choice":0}`, "Invalid answer."},
		"index with an exponent":  {`{"index":1e0,"choice":0}`, "Invalid answer."},
		"index true":              {`{"index":true,"choice":0}`, "Invalid answer."},
		"index an array":          {`{"index":[0],"choice":0}`, "Invalid answer."},
		"index negative":          {`{"index":-1,"choice":0}`, "Invalid answer."},
		"index beyond the run":    {`{"index":10,"choice":0}`, "Invalid answer."},
		"index far beyond":        {`{"index":99999999999999999999,"choice":0}`, "Invalid answer."},
		"index not the current":   {`{"index":1,"choice":0}`, "Invalid answer."},
		"choice missing":          {`{"index":0}`, "Invalid answer."},
		"choice a string":         {`{"index":0,"choice":"1"}`, "Invalid answer."},
		"choice a fraction":       {`{"index":0,"choice":1.5}`, "Invalid answer."},
		"choice with an exponent": {`{"index":0,"choice":1e0}`, "Invalid answer."},
		"choice true":             {`{"index":0,"choice":true}`, "Invalid answer."},
		"choice an object":        {`{"index":0,"choice":{"a":1}}`, "Invalid answer."},
		"choice numbers in array": {`{"index":0,"choice":[1,2]}`, "Invalid answer."},
		"choice a null in array":  {`{"index":0,"choice":["a",null]}`, "Invalid answer."},
		"choice nested arrays":    {`{"index":0,"choice":[["a"]]}`, "Invalid answer."},
		"not json":                {`nope`, "Invalid payload"},
		"an array body":           {`[]`, "Invalid payload"},
		"no body":                 {``, "Missing body"},
	} {
		t.Run(name, func(t *testing.T) {
			wantError(t, c.answerBody(token, run.RunID, tt.body), http.StatusBadRequest, tt.status)
		})
	}
	// Nothing was judged: the question is still open with its full time, and nothing was written but the run.
	if p := c.playerOf(t, token); p.Run.Questions[0].AnsweredAt != nil || p.Version != 1 {
		t.Fatalf("a refused answer changed the run: %+v", p.Run.Questions[0])
	}

	// A number or an array that is out of range or of the wrong kind is not refused: it is a wrong answer.
	q := run.Question
	right := c.choice(t, 2, q, true).(int)
	for i, choice := range []any{99, -1, []string{"R2-1"}, []string{}, right + 100} {
		fresh := c.start(t, token, 2)
		v := c.answerOK(t, token, fresh.RunID, 0, choice)
		if v.Correct || v.TimedOut || v.CorrectIndex == nil {
			t.Fatalf("choice %d (%v): %+v", i, choice, v)
		}
	}

	// A run that is over has no question to answer: an index past the last is refused like any other.
	done := c.start(t, token, 2)
	c.complete(t, token, done, 10)
	wantError(t, c.answer(token, done.RunID, 10, 0), http.StatusBadRequest, "Invalid answer.")
	wantError(t, c.answer(token, done.RunID, -1, 0), http.StatusBadRequest, "Invalid answer.")
}

func TestSentenceAnswers(t *testing.T) {
	csv := "6,Q1,go / to / go / home,,,,why 1\n6,Q2,我 / 是 / 学生,,,,why 2\n6,Q3,A / B,,,,why 3\n6,Q4,C / D,,,,why 4\n"
	c := newClassroomCSV(t, csv, nil)
	_, token := c.join(t, "Lan")
	run := c.start(t, token, 6)
	if run.Total != 4 {
		t.Fatalf("run %+v", run)
	}

	var seen []string
	q := run.Question
	for i := range run.Total {
		seen = append(seen, q.Question)
		source := c.source(t, 6, q.Question)
		var choice any
		switch q.Question {
		case "Q1":
			// The repeated word is compared as text, so either copy of "go" will do, and so will the dealt
			// pieces themselves once they are put in order.
			choice = []string{"go", "to", "go", "home"}
		case "Q2":
			choice = []string{"我", "学生", "是"} // the right pieces in a wrong order
		case "Q3":
			choice = []string{"A"} // too few
		default:
			choice = 1 // an index, for a sentence
		}
		v := c.answerOK(t, token, run.RunID, i, choice)
		want := q.Question == "Q1"
		if v.Correct != want || v.TimedOut || !slices.Equal(v.CorrectOrder, source.Chunks) || v.CorrectIndex != nil ||
			v.Answer != strings.Join(source.Chunks, " / ") {
			t.Fatalf("%s: %+v", q.Question, v)
		}
		if i < run.Total-1 {
			q = c.next(t, token, run.RunID)
		} else if v.Result == nil || v.Result.Correct != 1 || v.Result.Total != 4 || v.Result.Passed {
			t.Fatalf("result %+v", v.Result)
		}
	}
	slices.Sort(seen)
	if !slices.Equal(seen, []string{"Q1", "Q2", "Q3", "Q4"}) {
		t.Fatalf("questions dealt %v", seen)
	}
}

// ---- results ----

func TestPassUsesTheAssignmentsPassPercent(t *testing.T) {
	c := newClassroom(t, map[string]any{"stageLock": "open", "passPercents": map[string]int{"1": 60, "2": 100}})
	_, token := c.join(t, "Lan")
	if v := c.finish(t, token, 1, 3); v.Result == nil || *v.Result != (runResult{Correct: 3, Total: 5, Passed: true}) {
		t.Fatalf("3 of 5 at 60%%: %+v", v.Result)
	}
	if v := c.finish(t, token, 2, 9); v.Result == nil || *v.Result != (runResult{Correct: 9, Total: 10}) {
		t.Fatalf("9 of 10 at 100%%: %+v", v.Result)
	}
	if v := c.finish(t, token, 2, 10); !v.Result.Passed {
		t.Fatalf("10 of 10 at 100%%: %+v", v.Result)
	}
	// The same 3 of 5 does not pass where the teacher set nothing.
	d := newClassroom(t, nil)
	_, dToken := d.join(t, "Lan")
	if v := d.finish(t, dToken, 1, 3); v.Result.Passed {
		t.Fatalf("3 of 5 at the default 70%%: %+v", v.Result)
	}
}

func TestTheBestRunStaysAndAReplayCanOnlyRaiseIt(t *testing.T) {
	c := newClassroom(t, nil)
	_, token := c.join(t, "Lan")
	c.finish(t, token, 1, 4)
	c.clock.Advance(time.Minute)
	c.finish(t, token, 1, 2) // worse: keeps the 4 and the pass
	lan := c.detail(t).Players[0]
	if got := lan.Stages["1"]; got != (stageScore{Correct: 4, Total: 5, Passed: true, Attempts: 2}) {
		t.Fatalf("after a worse run: %+v", got)
	}
	if lan.ReachedAt == nil || !lan.ReachedAt.Equal(testClockStart) {
		t.Fatalf("reached at %v, the best run was at %v", lan.ReachedAt, testClockStart)
	}
	c.clock.Advance(time.Minute)
	c.finish(t, token, 1, 5)
	lan = c.detail(t).Players[0]
	if got := lan.Stages["1"]; got != (stageScore{Correct: 5, Total: 5, Passed: true, Attempts: 3}) {
		t.Fatalf("after a better run: %+v", got)
	}
	if lan.ReachedAt == nil || !lan.ReachedAt.Equal(testClockStart.Add(2*time.Minute)) || lan.LastPlayedAt == nil || !lan.LastPlayedAt.Equal(testClockStart.Add(2*time.Minute)) {
		t.Fatalf("lan %+v", lan)
	}
}

// A run that was started and never finished is an attempt and no score: the player is not ranked for it.
func TestAnUnfinishedRunIsAnAttemptWithNoScore(t *testing.T) {
	c := newClassroom(t, nil)
	_, abandoned := c.join(t, "Abandoned")
	_, played := c.join(t, "Played")
	run := c.start(t, abandoned, 1)
	c.answerOK(t, abandoned, run.RunID, 0, c.choice(t, 1, run.Question, true))
	c.finish(t, played, 1, 5)
	// The player who played also leaves a second run half way.
	second := c.start(t, played, 1)
	c.answerOK(t, played, second.RunID, 0, c.choice(t, 1, second.Question, false))

	detail := c.detail(t)
	if len(detail.Players) != 2 || detail.Players[0].Name != "Played" || detail.Players[1].Name != "Abandoned" {
		t.Fatalf("players %+v", detail.Players)
	}
	played0, abandoned0 := detail.Players[0], detail.Players[1]
	if abandoned0.Rank != nil || len(abandoned0.Stages) != 0 || abandoned0.Attempts != 1 || abandoned0.Correct != 0 || abandoned0.ReachedAt != nil {
		t.Errorf("abandoned %+v", abandoned0)
	}
	// Two runs started, one finished: two attempts, the score of the one that finished.
	if entryRank(played0) != 1 || played0.Stages["1"] != (stageScore{Correct: 5, Total: 5, Passed: true, Attempts: 2}) || played0.Attempts != 2 {
		t.Errorf("played %+v", played0)
	}
	// The students' board ranks by results alone.
	board := boardOf(t, c.board(abandoned))
	if got := boardNames(board); !slices.Equal(got, []string{"Played"}) || board.You == nil || board.You.Rank != nil {
		t.Errorf("board %+v", board)
	}
}

func TestShareAnswersTheCallersResults(t *testing.T) {
	c := newClassroom(t, map[string]any{"stageLock": "open"})
	_, lan := c.join(t, "Lan")
	_, nam := c.join(t, "Nam")
	shared := func(opts ...reqOpt) (results map[string]sharedStageResult, attempts map[string]int, counts map[string]int) {
		t.Helper()
		rec := c.send(http.MethodGet, c.shareURL(""), "", opts...)
		wantStatus(t, rec, http.StatusOK)
		if body := rec.Body.String(); strings.Contains(body, `"csv"`) || strings.Contains(body, "EXPL") || strings.Contains(body, "Q1-1") {
			t.Fatalf("the share answer holds the quiz: %s", body)
		}
		raw := decode[map[string]any](t, rec)
		for _, key := range []string{"results", "attempts", "stageCounts"} {
			if _, ok := raw[key].(map[string]any); !ok {
				t.Fatalf("%s is %v, want an object", key, raw[key])
			}
		}
		got := decode[struct {
			Results     map[string]sharedStageResult
			Attempts    map[string]int
			StageCounts map[string]int
		}](t, rec)
		return got.Results, got.Attempts, got.StageCounts
	}

	results, attempts, counts := shared()
	if len(results) != 0 || len(attempts) != 0 || !reflect.DeepEqual(counts, map[string]int{"1": 5, "2": 10}) {
		t.Fatalf("no token: %v %v %v", results, attempts, counts)
	}
	if results, attempts, _ = shared(header(playerTokenHeader, lan)); len(results) != 0 || len(attempts) != 0 {
		t.Fatalf("before any run: %v %v", results, attempts)
	}

	c.finish(t, lan, 1, 3)
	c.finish(t, lan, 1, 5)
	c.finish(t, lan, 1, 4)
	c.start(t, lan, 2) // left unfinished
	c.finish(t, nam, 2, 9)

	results, attempts, _ = shared(header(playerTokenHeader, lan))
	if want := map[string]sharedStageResult{"1": {Correct: 5, Total: 5, Passed: true}}; !reflect.DeepEqual(results, want) {
		t.Errorf("lan results %v, want %v", results, want)
	}
	if want := map[string]int{"1": 3, "2": 1}; !reflect.DeepEqual(attempts, want) {
		t.Errorf("lan attempts %v, want %v", attempts, want)
	}
	results, attempts, _ = shared(header(playerTokenHeader, nam))
	if want := map[string]sharedStageResult{"2": {Correct: 9, Total: 10, Passed: true}}; !reflect.DeepEqual(results, want) {
		t.Errorf("nam results %v, want %v", results, want)
	}
	if want := map[string]int{"2": 1}; !reflect.DeepEqual(attempts, want) {
		t.Errorf("nam attempts %v, want %v", attempts, want)
	}

	// A bad token, a token of another assignment and bad authorization tell nothing and are not errors.
	other := decode[assignmentView](t, c.teacher(http.MethodPost, "/api/assignments", createBody(nil)))
	for name, rec := range map[string]*httptest.ResponseRecorder{
		"a bad token":   c.send(http.MethodGet, c.shareURL(""), "", header(playerTokenHeader, "garbage"), header("Authorization", "Bearer garbage")),
		"another's one": c.send(http.MethodGet, "/api/share/"+other.Code, "", header(playerTokenHeader, lan)),
	} {
		wantStatus(t, rec, http.StatusOK)
		if got := decode[struct {
			Results  map[string]sharedStageResult
			Attempts map[string]int
		}](t, rec); len(got.Results) != 0 || len(got.Attempts) != 0 {
			t.Errorf("%s: %+v", name, got)
		}
	}
}

// A player from before the server dealt the runs has the attempts in Stages and nothing started: the next
// run counts on from there, for the replay limit and for the leaderboard.
func TestAPlayerFromBeforeRunsKeepsItsAttempts(t *testing.T) {
	c := newClassroom(t, map[string]any{"stageLock": "open", "maxAttempts": 3})
	id, token := c.join(t, "Lan")
	_, err := c.assignments.UpdatePlayer(context.Background(), c.a.ID, id, func(p *store.Player) error {
		p.Stages["1"] = store.StageResult{Correct: 4, Total: 5, Attempts: 2, Passed: true, BestAt: testClockStart}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	rec := c.send(http.MethodGet, c.shareURL(""), "", header(playerTokenHeader, token))
	if got := decode[struct{ Attempts map[string]int }](t, rec).Attempts; !reflect.DeepEqual(got, map[string]int{"1": 2}) {
		t.Fatalf("attempts %v", got)
	}
	if run := c.start(t, token, 1); run.Attempts != 3 {
		t.Fatalf("the next run is attempt %d, want 3", run.Attempts)
	}
	wantError(t, c.startRun(token, 1), http.StatusConflict, "Replay limit reached")
	if lan := c.detail(t).Players[0]; lan.Stages["1"].Attempts != 3 || lan.Attempts != 3 {
		t.Fatalf("lan %+v", lan)
	}
}

// ---- the grace after closing ----

func TestClosingByHandStopsStartsAtOnce(t *testing.T) {
	c := newClassroom(t, map[string]any{"timeMode": "unlimited"})
	_, lan := c.join(t, "Lan")
	run := c.start(t, lan, 1)
	wantStatus(t, c.patch(`{"closed":true}`), http.StatusOK)

	wantError(t, c.startRun(lan, 1), http.StatusGone, "Assignment closed")
	// Checks run in order: the code, the assignment being closed, then the player.
	wantError(t, c.send(http.MethodPost, c.shareURL("/runs"), `{"stage":1}`), http.StatusGone, "Assignment closed")
	wantError(t, c.send(http.MethodPost, "/api/share/ZZZZZZZZZZ/runs", `{"stage":1}`, header(playerTokenHeader, lan)), http.StatusNotFound, "Assignment not found")
	c.complete(t, lan, run, 5)

	c.clock.Advance(6 * time.Minute)
	wantError(t, c.nextQuestion(lan, run.RunID), http.StatusGone, "Assignment closed")
	wantError(t, c.send(http.MethodPost, c.shareURL("/runs/"+run.RunID+"/answers"), "nope"), http.StatusGone, "Assignment closed")

	// Reopened, a new run starts again.
	wantStatus(t, c.patch(`{"closed":false}`), http.StatusOK)
	wantStatus(t, c.startRun(lan, 1), http.StatusCreated)
}

// ---- the store failing, and another request getting there first ----

// racing runs `before` against the player just before the first UpdatePlayer, as another request of the
// same student would have, and then lets the handler's own update through.
type racing struct {
	store.Assignments
	before func(ctx context.Context, inner store.Assignments, assignmentID, playerID string)
	done   bool
}

func (r *racing) UpdatePlayer(ctx context.Context, assignmentID, playerID string, change func(p *store.Player) error) (*store.Player, error) {
	if !r.done {
		r.done = true
		r.before(ctx, r.Assignments, assignmentID, playerID)
	}
	return r.Assignments.UpdatePlayer(ctx, assignmentID, playerID, change)
}

func TestADuplicateAnswerThatLostTheRaceGetsTheFirstVerdict(t *testing.T) {
	c := newClassroom(t, nil)
	_, token := c.join(t, "Lan")
	run := c.start(t, token, 1)
	right := c.choice(t, 1, run.Question, true)

	// The same question is answered, wrongly, by a request that gets in between the read and the write.
	c.srv.Assignments = &racing{Assignments: c.assignments, before: func(ctx context.Context, inner store.Assignments, aid, pid string) {
		_, err := inner.UpdatePlayer(ctx, aid, pid, func(p *store.Player) error {
			answered := c.clock.Now()
			p.Run.Questions[0].AnsweredAt = &answered
			p.Run.Questions[0].Correct = false
			return nil
		})
		if err != nil {
			t.Error(err)
		}
	}}
	// The answer is judged as the first one was, not again: it was wrong then, and this choice is right.
	if v := c.answerOK(t, token, run.RunID, 0, right); v.Correct || v.TimedOut || v.CorrectIndex == nil {
		t.Fatalf("the duplicate was judged again: %+v", v)
	}
	answered := 0
	for _, q := range c.playerOf(t, token).Run.Questions {
		if q.AnsweredAt != nil {
			answered++
		}
	}
	if answered != 1 {
		t.Fatalf("%d questions answered", answered)
	}
}
func TestARunReplacedBetweenTheReadAndTheWriteIsNotFound(t *testing.T) {
	c := newClassroom(t, nil)
	_, token := c.join(t, "Lan")
	run := c.start(t, token, 1)

	c.srv.Assignments = &racing{Assignments: c.assignments, before: func(ctx context.Context, inner store.Assignments, aid, pid string) {
		_, err := inner.UpdatePlayer(ctx, aid, pid, func(p *store.Player) error {
			p.Run = &store.Run{ID: "another-run", Stage: "1", StartedAt: c.clock.Now(), Questions: []store.RunQuestion{{Item: 0}}}
			return nil
		})
		if err != nil {
			t.Error(err)
		}
	}}
	wantError(t, c.answer(token, run.RunID, 0, c.choice(t, 1, run.Question, true)), http.StatusNotFound, "Run not found")
}

func TestAFinishedRunMeetsNextAtTheWrite(t *testing.T) {
	c := newClassroom(t, nil)
	_, token := c.join(t, "Lan")
	run := c.start(t, token, 1)
	c.answerOK(t, token, run.RunID, 0, c.choice(t, 1, run.Question, true))

	// The student's next question was never served, and by the time it is the run is over (another tab
	// finished it): the read said "serve it", the write says the run is over.
	c.srv.Assignments = &racing{Assignments: c.assignments, before: func(ctx context.Context, inner store.Assignments, aid, pid string) {
		_, err := inner.UpdatePlayer(ctx, aid, pid, func(p *store.Player) error {
			finished := c.clock.Now()
			p.Run.FinishedAt = &finished
			return nil
		})
		if err != nil {
			t.Error(err)
		}
	}}
	wantError(t, c.nextQuestion(token, run.RunID), http.StatusConflict, "Run is over")
}

// updateFailing makes every UpdatePlayer fail with err.
type updateFailing struct {
	store.Assignments
	err error
}

func (u updateFailing) UpdatePlayer(context.Context, string, string, func(p *store.Player) error) (*store.Player, error) {
	return nil, u.err
}

func TestAnUpdateThatFailsIsAnInternalErrorOrAForbiddenPlayer(t *testing.T) {
	c := newClassroom(t, nil)
	_, token := c.join(t, "Lan")
	run := c.start(t, token, 1)
	c.answerOK(t, token, run.RunID, 0, c.choice(t, 1, run.Question, true))
	c.next(t, token, run.RunID) // question 1 is served now, so answering it is a write and asking again is not

	requests := map[string]func() *httptest.ResponseRecorder{
		"start":  func() *httptest.ResponseRecorder { return c.startRun(token, 1) },
		"answer": func() *httptest.ResponseRecorder { return c.answer(token, run.RunID, 1, 0) },
	}
	for _, err := range []error{errBroken, store.ErrConflict} {
		c.srv.Assignments = updateFailing{c.assignments, err}
		for name, request := range requests {
			if rec := request(); rec.Code != http.StatusInternalServerError || rec.Body.Len() != 0 {
				t.Errorf("%s with %v: %d %q", name, err, rec.Code, rec.Body)
			}
		}
		// Asking again for a question that was served writes nothing, so a failing store does not matter.
		wantStatus(t, c.nextQuestion(token, run.RunID), http.StatusOK)
	}
	// The teacher removing the student between the token check and the write is a 403, as everywhere.
	c.srv.Assignments = updateFailing{c.assignments, store.ErrNotFound}
	for _, request := range requests {
		wantError(t, request(), http.StatusForbidden, "Unknown player")
	}
}
func TestServingANextQuestionThatFailsToWriteIsAnInternalError(t *testing.T) {
	c := newClassroom(t, nil)
	_, token := c.join(t, "Lan")
	run := c.start(t, token, 1)
	c.answerOK(t, token, run.RunID, 0, c.choice(t, 1, run.Question, true))

	c.srv.Assignments = updateFailing{c.assignments, errBroken}
	if rec := c.nextQuestion(token, run.RunID); rec.Code != http.StatusInternalServerError || rec.Body.Len() != 0 {
		t.Fatalf("%d %q", rec.Code, rec.Body)
	}
	c.srv.Assignments = updateFailing{c.assignments, store.ErrNotFound}
	wantError(t, c.nextQuestion(token, run.RunID), http.StatusForbidden, "Unknown player")
	// Nothing was written, so asking again, with the store back, serves it as if for the first time.
	c.srv.Assignments = c.assignments
	if q := c.next(t, token, run.RunID); q.Index != 1 || *q.TimeLeftMs != 12000 {
		t.Fatalf("question %+v", q)
	}
}

// A run whose questions no longer match the quiz (a change of the parser between two deployments) is
// "Run not found", which lets the page offer to start the stage again.
func TestARunThatDoesNotMatchItsQuizIsNotFound(t *testing.T) {
	c := newClassroom(t, nil)
	id, token := c.join(t, "Lan")
	run := c.start(t, token, 1)
	_, err := c.assignments.UpdatePlayer(context.Background(), c.a.ID, id, func(p *store.Player) error {
		p.Run.Questions[0].Item = 99
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	wantError(t, c.nextQuestion(token, run.RunID), http.StatusNotFound, "Run not found")
	wantError(t, c.answer(token, run.RunID, 0, 0), http.StatusNotFound, "Run not found")
}

func TestShareRoutesOfRunsAnswer404ForAnUnknownCode(t *testing.T) {
	c := newClassroom(t, nil)
	_, token := c.join(t, "Lan")
	run := c.start(t, token, 1)
	for _, code := range []string{"ZZZZZZZZZZ", c.a.Code + "X", c.a.Code[:9]} {
		for _, rt := range []struct{ method, path, body string }{
			{http.MethodPost, "/api/share/" + code + "/runs", `{"stage":1}`},
			{http.MethodPost, "/api/share/" + code + "/runs/" + run.RunID + "/next", ""},
			{http.MethodPost, "/api/share/" + code + "/runs/" + run.RunID + "/answers", `{"index":0,"choice":0}`},
		} {
			rec := c.send(rt.method, rt.path, rt.body, header(playerTokenHeader, token))
			if rec.Code != http.StatusNotFound || rec.Body.String() != "Assignment not found" {
				t.Errorf("%s %s: %d %q", rt.method, rt.path, rec.Code, rec.Body)
			}
			if got := rec.Header().Get("Cache-Control"); got != "no-store" {
				t.Errorf("%s %s: the answer is cacheable: %q", rt.method, rt.path, got)
			}
		}
	}
	// The code is trimmed and upper-cased here too.
	rec := c.send(http.MethodPost, "/api/share/%20"+strings.ToLower(c.a.Code)+"%20/runs", `{"stage":1}`, header(playerTokenHeader, token))
	wantStatus(t, rec, http.StatusCreated)
}

// The route that took a finished score from the browser is gone: there is nothing left to post a
// made-up score to.
func TestTheResultsRouteIsGone(t *testing.T) {
	c := newClassroom(t, nil)
	_, token := c.join(t, "Lan")
	for _, method := range []string{http.MethodPost, http.MethodGet, http.MethodPut} {
		rec := c.send(method, c.shareURL("/results"), `{"runId":"run-0000001","stage":1,"correct":5,"total":5}`, header(playerTokenHeader, token))
		if rec.Code != http.StatusNotFound && rec.Code != http.StatusMethodNotAllowed {
			t.Errorf("%s /results: %d %q", method, rec.Code, rec.Body)
		}
	}
	if lan := c.detail(t).Players[0]; len(lan.Stages) != 0 {
		t.Fatalf("a score got in: %+v", lan)
	}
}

// ---- time limits come from the server's configuration ----

// limitsOf decodes a "timeLimits" object: stage to seconds, null for no limit.
func limitsOf(t *testing.T, raw any) map[string]*int {
	t.Helper()
	object, ok := raw.(map[string]any)
	if !ok {
		t.Fatalf("timeLimits is %v, want an object", raw)
	}
	out := map[string]*int{}
	for stage, v := range object {
		switch n := v.(type) {
		case nil:
			out[stage] = nil
		case float64:
			seconds := int(n)
			if float64(seconds) != n {
				t.Fatalf("stage %s: %v is not a whole number", stage, n)
			}
			out[stage] = &seconds
		default:
			t.Fatalf("stage %s: %v", stage, v)
		}
	}
	return out
}

// wantLimits checks the limits of every stage; a want of -1 is null (no limit).
func wantLimits(t *testing.T, what string, got map[string]*int, want map[string]int) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("%s: time limits %v, want %v", what, got, want)
	}
	for stage, seconds := range want {
		switch limit := got[stage]; {
		case seconds < 0 && limit != nil:
			t.Fatalf("%s: stage %s has %d, want none", what, stage, *limit)
		case seconds >= 0 && (limit == nil || *limit != seconds):
			t.Fatalf("%s: stage %s has %v, want %d", what, stage, limit, seconds)
		}
	}
}

// The share answer and every view of an assignment tell the page how long a question lasts, per stage of
// the assignment, with its time mode applied (null for unlimited), so the page needs no table of its own.
func TestTimeLimitsAreToldToThePageAndTheTeacher(t *testing.T) {
	csv := quizCSV(map[int]int{1: 5, 2: 5, 3: 3, 5: 3, 6: 3}) // no stage 4
	for _, tt := range []struct {
		mode string
		want map[string]int // -1 is null
	}{
		{"standard", map[string]int{"1": 12, "2": 12, "3": 15, "5": 20, "6": 45}},
		{"extra", map[string]int{"1": 18, "2": 18, "3": 23, "5": 30, "6": 68}},
		{"unlimited", map[string]int{"1": -1, "2": -1, "3": -1, "5": -1, "6": -1}},
	} {
		t.Run(tt.mode, func(t *testing.T) {
			c := newClassroomCSV(t, csv, map[string]any{"timeMode": tt.mode})
			raw := func(rec *httptest.ResponseRecorder) map[string]any {
				t.Helper()
				wantStatus(t, rec, http.StatusOK)
				return decode[map[string]any](t, rec)
			}
			// What a student is told, with and without a player.
			shared := raw(c.shareGet())
			wantLimits(t, "share", limitsOf(t, shared["timeLimits"]), tt.want)
			if tt.mode == "unlimited" {
				// The keys are there, with null: not a missing limit.
				for stage := range tt.want {
					if v, has := shared["timeLimits"].(map[string]any)[stage]; !has || v != nil {
						t.Fatalf("stage %s: %v, %v", stage, v, has)
					}
				}
			}
			_, token := c.join(t, "Lan")
			wantLimits(t, "share with a player", limitsOf(t, raw(c.send(http.MethodGet, c.shareURL(""), "", header(playerTokenHeader, token)))["timeLimits"]), tt.want)

			// The teacher's: the answer to creating (which the classroom kept), the list, the detail and a patch.
			wantLimits(t, "created", c.a.TimeLimits, tt.want)
			list := raw(c.teacher(http.MethodGet, "/api/assignments", ""))["assignments"].([]any)
			wantLimits(t, "list", limitsOf(t, list[0].(map[string]any)["timeLimits"]), tt.want)
			wantLimits(t, "detail", limitsOf(t, raw(c.teacher(http.MethodGet, "/api/assignments/"+c.a.ID, ""))["timeLimits"]), tt.want)
			wantLimits(t, "patch", limitsOf(t, raw(c.patch(`{"label":"x"}`))["timeLimits"]), tt.want)
		})
	}
}

// The limits are worked out from the configuration when they are asked for and are never stored, so a change
// of the configuration reaches assignments that already exist.
func TestTimeLimitsFollowTheConfiguration(t *testing.T) {
	c := newClassroom(t, map[string]any{"timeMode": "extra"})
	wantLimits(t, "default", c.a.TimeLimits, map[string]int{"1": 18, "2": 18})

	c.srv.StageSeconds = []int{10, 30, 15, 15, 20, 45}
	wantLimits(t, "share", limitsOf(t, decode[map[string]any](t, c.shareGet())["timeLimits"]), map[string]int{"1": 15, "2": 45})
	wantLimits(t, "detail", c.detail(t).TimeLimits, map[string]int{"1": 15, "2": 45})
}

// A Server given no table, or one that is not one value for each stage, plays by gesturequiz's defaults.
func TestWithoutConfiguredSecondsTheDefaultsApply(t *testing.T) {
	for name, seconds := range map[string][]int{"nil": nil, "empty": {}, "too few": {20, 20}, "too many": {20, 20, 20, 20, 20, 20, 20}} {
		c := newClassroom(t, nil)
		c.srv.StageSeconds = seconds
		wantLimits(t, name, limitsOf(t, decode[map[string]any](t, c.shareGet())["timeLimits"]), map[string]int{"1": 12, "2": 12})
		_, token := c.join(t, "Lan")
		if got := c.start(t, token, 1).Question.TimeLeftMs; got == nil || *got != 12000 {
			t.Errorf("%s: %v", name, got)
		}
	}
}

// A run on a Server with its own stage seconds deals the time left from them and judges a late answer by
// them, in every time mode.
func TestARunIsTimedByTheConfiguredSeconds(t *testing.T) {
	seconds := []int{20, 6, 15, 15, 20, 45} // stage 1 gets 20 s, stage 2 only 6
	for _, tt := range []struct {
		mode   string
		stage1 int64         // ms left at the start of stage 1
		stage2 int64         // and of stage 2
		onTime time.Duration // an answer this long after its question was dealt is on time...
	}{
		{"standard", 20000, 6000, 25 * time.Second},
		{"extra", 30000, 9000, 35 * time.Second},
		{"unlimited", 0, 0, 0},
	} {
		t.Run(tt.mode, func(t *testing.T) {
			c := newClassroom(t, map[string]any{"timeMode": tt.mode, "stageLock": "open"})
			c.srv.StageSeconds = seconds
			_, token := c.join(t, "Lan")

			run := c.start(t, token, 1)
			if tt.mode == "unlimited" {
				if run.Question.TimeLeftMs != nil {
					t.Fatalf("unlimited has a clock: %d", *run.Question.TimeLeftMs)
				}
				c.clock.Advance(1000 * time.Hour)
				if v := c.answerOK(t, token, run.RunID, 0, c.choice(t, 1, run.Question, true)); !v.Correct || v.TimedOut {
					t.Fatalf("an answer after 1000 hours: %+v", v)
				}
				return
			}
			if run.Question.TimeLeftMs == nil || *run.Question.TimeLeftMs != tt.stage1 {
				t.Fatalf("stage 1 starts with %v, want %d", run.Question.TimeLeftMs, tt.stage1)
			}
			if second := c.start(t, token, 2); second.Question.TimeLeftMs == nil || *second.Question.TimeLeftMs != tt.stage2 {
				t.Fatalf("stage 2 starts with %v, want %d", second.Question.TimeLeftMs, tt.stage2)
			}

			// The limit plus the grace of 5 s is the deadline: on time at it, late a millisecond after, by
			// the 20 s of stage 1 that was configured, where the built-in 12 s would have said otherwise.
			run = c.start(t, token, 1)
			c.clock.Advance(tt.onTime)
			if v := c.answerOK(t, token, run.RunID, 0, c.choice(t, 1, run.Question, true)); !v.Correct || v.TimedOut {
				t.Fatalf("an answer at the deadline: %+v", v)
			}
			q := c.next(t, token, run.RunID)
			c.clock.Advance(tt.onTime + time.Millisecond)
			if v := c.answerOK(t, token, run.RunID, 1, c.choice(t, 1, q, true)); v.Correct || !v.TimedOut {
				t.Fatalf("an answer past the deadline: %+v", v)
			}

			// A re-served question counts down from the configured limit too.
			again := c.start(t, token, 2)
			c.clock.Advance(2 * time.Second)
			if q = c.next(t, token, again.RunID); q.TimeLeftMs == nil || *q.TimeLeftMs != tt.stage2-2000 {
				t.Fatalf("stage 2 two seconds in: %v, want %d", q.TimeLeftMs, tt.stage2-2000)
			}
		})
	}
}
