package api

import (
	"encoding/json"
	"errors"
	mrand "math/rand/v2"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"

	"quiz-csv-import-tool/server/internal/gesturequiz"
	"quiz-csv-import-tool/server/internal/store"
)

// answerGrace is added to every question's time limit before an answer counts as late: it covers the
// network, and a face game's calibration, which the browser's clock may run through. The student's own
// page stops a little before the limit, so the grace only ever decides an answer that came in late.
const answerGrace = 5 * time.Second

// What a closure given to UpdatePlayer can report. The store hands an error back unchanged and writes
// nothing, so the handler can tell these apart from a store that failed.
var (
	errStageLocked     = errors.New("stage locked")
	errReplayLimit     = errors.New("replay limit reached")
	errRunGone         = errors.New("run not found")
	errRunOver         = errors.New("run is over")
	errInvalidAnswer   = errors.New("invalid answer")
	errAlreadyAnswered = errors.New("question already answered")
)

// sharedQuestion is a question as a student is dealt it: the text and how to answer, never the answer or
// its explanation, which come back only with the verdict. Index is the question's place in this run.
// Options is empty for the sentence stage, and Chunks is null for every other stage. TimeLeftMs is null
// when the time mode has no limit; GraceMs is how long after the limit an answer still counts.
type sharedQuestion struct {
	Index      int      `json:"index"`
	Question   string   `json:"question"`
	Options    []string `json:"options"`
	Chunks     []string `json:"chunks"`
	TimeLeftMs *int64   `json:"timeLeftMs"`
	GraceMs    int64    `json:"graceMs"`
}

// runResult is what a finished run scored, and whether that passes the stage.
type runResult struct {
	Correct int  `json:"correct"`
	Total   int  `json:"total"`
	Passed  bool `json:"passed"`
}

// verdict is the server's judgement of one answer, with the right answer and its explanation. Exactly one
// of CorrectIndex (the option stages) and CorrectOrder (the sentence stage) is set. Result is set on the
// last question of a run, which finishes it.
type verdict struct {
	Correct      bool       `json:"correct"`
	TimedOut     bool       `json:"timedOut"`
	CorrectIndex *int       `json:"correctIndex,omitempty"`
	CorrectOrder []string   `json:"correctOrder,omitempty"`
	Answer       string     `json:"answer"`
	Explanation  string     `json:"explanation"`
	Result       *runResult `json:"result"`
}

// startRun handles POST /api/share/{code}/runs: a student starts a run of one stage. The server parses the
// assignment's quiz, shuffles the questions and the options, keeps the run on the player and deals the first
// question. The run counts toward the replay limit from this moment, finished or not, and replaces any
// run the player had, so a second tab cannot play a stage beside the first.
//
// The order of checks decides the status when several things are wrong: the code (404), the assignment
// being open (410, with no grace for starting), the player's token (403), the body (400 for bad JSON and
// for a stage the quiz does not have), then, on fresh data inside the update, the stage lock (409 "Stage
// locked") and the replay limit (409 "Replay limit reached").
func (s *Server) startRun(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	a, ok := s.sharedAssignment(w, r)
	if !ok {
		return
	}
	now := s.now()
	if !a.OpenAt(now) {
		writeText(w, http.StatusGone, "Assignment closed")
		return
	}
	player, ok := s.requestPlayer(w, r, a)
	if !ok {
		return
	}

	var req struct {
		Stage int `json:"stage"`
	}
	if !s.readJSON(w, r, &req) {
		return
	}
	stage := strconv.Itoa(req.Stage)
	quiz := gesturequiz.Parse(a.CSV)
	if _, has := a.StageCounts[stage]; !has || quiz.Count(req.Stage) == 0 {
		writeText(w, http.StatusBadRequest, "Invalid stage.")
		return
	}

	// The run is dealt once, outside the update, because the closure may run again on a conflict.
	run := dealRun(quiz, req.Stage, now)
	attempts := 0
	_, err := s.Assignments.UpdatePlayer(r.Context(), a.ID, player.ID, func(p *store.Player) error {
		if stageLockOf(a) == stageLockSequential && !lowerStagesPassed(a, p, req.Stage) {
			return errStageLocked
		}
		// What a stage has used up is the larger of the runs started and the runs a player from before the
		// server dealt them finished.
		used := max(p.Started[stage], p.Stages[stage].Attempts)
		if a.MaxAttempts != nil && used >= *a.MaxAttempts {
			return errReplayLimit
		}
		attempts = used + 1
		p.Started[stage] = attempts
		p.Run = run
		p.LastPlayedAt = &now
		return nil
	})
	switch {
	case errors.Is(err, errStageLocked):
		writeText(w, http.StatusConflict, "Stage locked")
		return
	case errors.Is(err, errReplayLimit):
		writeText(w, http.StatusConflict, "Replay limit reached")
		return
	case errors.Is(err, store.ErrNotFound):
		// The teacher removed the student between the token check and now.
		writeText(w, http.StatusForbidden, "Unknown player")
		return
	case err != nil:
		s.internalError(w, r, "starting a run failed", err)
		return
	}

	question, _ := s.questionOf(a, run, quiz, 0, now)
	writeJSON(w, http.StatusCreated, map[string]any{
		"runId":    run.ID,
		"stage":    req.Stage,
		"total":    len(run.Questions),
		"attempts": attempts,
		"question": question,
	})
}

// nextQuestion handles POST /api/share/{code}/runs/{runId}/next: the question the player is on. The first
// time it is asked for, the question's clock starts; asked again (a lost reply, a reload) it is sent as
// it stands, with the time that is left, so asking never buys time. Like answering, it is taken for the
// result grace after the assignment closes, so a student in the middle of a stage does not lose it.
func (s *Server) nextQuestion(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	a, ok := s.sharedAssignment(w, r)
	if !ok {
		return
	}
	now := s.now()
	if !a.AcceptsResultsAt(now) {
		writeText(w, http.StatusGone, "Assignment closed")
		return
	}
	player, ok := s.requestPlayer(w, r, a)
	if !ok {
		return
	}
	runID := r.PathValue("runId")
	if player.Run == nil || player.Run.ID != runID {
		writeText(w, http.StatusNotFound, "Run not found")
		return
	}
	if player.Run.FinishedAt != nil {
		writeText(w, http.StatusConflict, "Run is over")
		return
	}
	quiz := gesturequiz.Parse(a.CSV)

	run := player.Run
	if current := firstOpen(run); current >= 0 && run.Questions[current].ServedAt == nil {
		// Serving is a write: the clock starts now, and two requests asking at once must not both set it.
		updated, err := s.Assignments.UpdatePlayer(r.Context(), a.ID, player.ID, func(p *store.Player) error {
			if p.Run == nil || p.Run.ID != runID {
				return errRunGone
			}
			if p.Run.FinishedAt != nil {
				return errRunOver
			}
			if i := firstOpen(p.Run); i >= 0 && p.Run.Questions[i].ServedAt == nil {
				served := now
				p.Run.Questions[i].ServedAt = &served
			}
			return nil
		})
		if s.runUpdateFailed(w, r, err) {
			return
		}
		run = updated.Run
	}

	current := firstOpen(run)
	if current < 0 {
		writeText(w, http.StatusConflict, "Run is over")
		return
	}
	question, ok := s.questionOf(a, run, quiz, current, now)
	if !ok {
		s.runOutOfStep(w, r, run)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"question": question})
}

// answerQuestion handles POST /api/share/{code}/runs/{runId}/answers: the player answers the question they
// were dealt, with the index of an option, the pieces of the sentence in the order picked, or null when
// their time ran out. The server judges it, by its own clock and its own copy of the quiz, and reveals the
// right answer and the explanation in the reply. The last answer finishes the run and records its score.
//
// An answer for a question already answered is a resend, after a lost reply: it gets the stored verdict
// and changes nothing, so resending is safe and never counts a question twice. Anything else but the
// question in play is a 400, as is a body that is not an integer index and a choice of a kind that is
// none of the three. Nothing is rejected for being late: a late answer is judged a timeout.
func (s *Server) answerQuestion(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	a, ok := s.sharedAssignment(w, r)
	if !ok {
		return
	}
	now := s.now()
	if !a.AcceptsResultsAt(now) {
		writeText(w, http.StatusGone, "Assignment closed")
		return
	}
	player, ok := s.requestPlayer(w, r, a)
	if !ok {
		return
	}
	runID := r.PathValue("runId")
	if player.Run == nil || player.Run.ID != runID {
		writeText(w, http.StatusNotFound, "Run not found")
		return
	}

	// Both are read raw, so that a missing key, a null and a value of the wrong type can be told apart.
	var req struct {
		Index  json.RawMessage `json:"index"`
		Choice json.RawMessage `json:"choice"`
	}
	if !s.readJSON(w, r, &req) {
		return
	}
	index, indexOK := parseInteger(req.Index)
	choice, choiceOK := parseChoice(req.Choice)
	if !indexOK || !choiceOK {
		writeText(w, http.StatusBadRequest, "Invalid answer.")
		return
	}
	quiz := gesturequiz.Parse(a.CSV)

	// A question that was already answered is answered again with its verdict, whatever the choice now is.
	// This is decided from what was read, because an answer, once given, never goes away.
	if index >= 0 && index < len(player.Run.Questions) && player.Run.Questions[index].AnsweredAt != nil {
		s.writeVerdict(w, r, a, player.Run, quiz, index)
		return
	}

	current := firstOpen(player.Run)
	if current < 0 || index != current || player.Run.Questions[current].ServedAt == nil {
		writeText(w, http.StatusBadRequest, "Invalid answer.")
		return
	}

	// Judging happens on fresh data: a duplicate of this request (a double tap, a retry that overtook its
	// original) can have answered the question since it was read, and must not be judged twice.
	var settled *store.Run
	updated, err := s.Assignments.UpdatePlayer(r.Context(), a.ID, player.ID, func(p *store.Player) error {
		if p.Run == nil || p.Run.ID != runID {
			return errRunGone
		}
		if index < 0 || index >= len(p.Run.Questions) {
			return errInvalidAnswer
		}
		if p.Run.Questions[index].AnsweredAt != nil {
			settled = p.Run
			return errAlreadyAnswered
		}
		if firstOpen(p.Run) != index || p.Run.Questions[index].ServedAt == nil {
			return errInvalidAnswer
		}
		return s.judgeAnswer(a, quiz, p, index, choice, now)
	})
	if errors.Is(err, errAlreadyAnswered) {
		s.writeVerdict(w, r, a, settled, quiz, index)
		return
	}
	if errors.Is(err, errInvalidAnswer) {
		writeText(w, http.StatusBadRequest, "Invalid answer.")
		return
	}
	if s.runUpdateFailed(w, r, err) {
		return
	}
	s.writeVerdict(w, r, a, updated.Run, quiz, index)
}

// judgeAnswer records the verdict on question index of the player's run and, when that was the last
// question, finishes the run: the correct answers are counted, the stage is passed or not by the
// assignment's pass percent, and the score is merged into the player's results, all in the same write.
// A choice is wrong when it is null, when it came after the question's limit and the grace, or when it
// is not the answer; a choice of the wrong kind (an index for the sentence stage, pieces for an option
// stage) is simply wrong.
func (s *Server) judgeAnswer(a *store.Assignment, quiz *gesturequiz.Quiz, p *store.Player, index int, choice answerChoice, now time.Time) error {
	run := p.Run
	stage, _ := strconv.Atoi(run.Stage)
	question := &run.Questions[index]
	source, ok := sourceOf(quiz, stage, *question)
	if !ok {
		return errRunGone
	}

	timedOut := choice.kind == choiceNone
	if limit, limited := s.timeLimit(stage, a.TimeMode); limited && now.After(question.ServedAt.Add(limit+answerGrace)) {
		timedOut = true
	}
	answeredAt := now
	question.AnsweredAt = &answeredAt
	question.TimedOut = timedOut
	question.Correct = !timedOut && isRightChoice(source, *question, choice)

	if index < len(run.Questions)-1 {
		return nil
	}
	result := resultOf(a, run)
	store.MergeRun(p, run.Stage, result.Correct, result.Total, result.Passed, now)
	finished := now
	run.FinishedAt = &finished
	p.LastPlayedAt = &finished
	return nil
}

// writeVerdict answers with the verdict of question index of a run, which must be answered. The verdict
// is rebuilt from the run and the quiz, so a resend gets exactly what the first reply held.
func (s *Server) writeVerdict(w http.ResponseWriter, r *http.Request, a *store.Assignment, run *store.Run, quiz *gesturequiz.Quiz, index int) {
	stage, _ := strconv.Atoi(run.Stage)
	question := run.Questions[index]
	source, ok := sourceOf(quiz, stage, question)
	if !ok {
		s.runOutOfStep(w, r, run)
		return
	}
	v := verdict{
		Correct:     question.Correct,
		TimedOut:    question.TimedOut,
		Answer:      source.Correct,
		Explanation: source.Explanation,
	}
	if stage == gesturequiz.WordOrderStage {
		v.CorrectOrder = source.Chunks
	} else {
		at := slices.Index(question.Options, source.Correct)
		if at < 0 {
			s.runOutOfStep(w, r, run)
			return
		}
		v.CorrectIndex = &at
	}
	if index == len(run.Questions)-1 && run.FinishedAt != nil {
		result := resultOf(a, run)
		v.Result = &result
	}
	writeJSON(w, http.StatusOK, v)
}

// runOutOfStep answers for a run whose questions no longer match the quiz it was dealt from, which only a
// change of the parser between deployments could cause. The student's way out is to start the stage again,
// which the same "Run not found" tells their page to offer.
func (s *Server) runOutOfStep(w http.ResponseWriter, r *http.Request, run *store.Run) {
	s.Logger.Warn("a run does not match its quiz", "path", r.URL.Path, "run", run.ID)
	writeText(w, http.StatusNotFound, "Run not found")
}

// runUpdateFailed answers for an error of an UpdatePlayer that changes a run, and reports whether it was
// one; nil is not.
func (s *Server) runUpdateFailed(w http.ResponseWriter, r *http.Request, err error) bool {
	switch {
	case err == nil:
		return false
	case errors.Is(err, errRunGone):
		writeText(w, http.StatusNotFound, "Run not found")
	case errors.Is(err, errRunOver):
		writeText(w, http.StatusConflict, "Run is over")
	case errors.Is(err, store.ErrNotFound):
		// The teacher removed the student between the token check and now.
		writeText(w, http.StatusForbidden, "Unknown player")
	default:
		s.internalError(w, r, "updating a run failed", err)
	}
	return true
}

// requestPlayer is the student behind the X-Player-Token header, or a 403 "Unknown player" for a missing
// token or one that no player of this assignment holds.
func (s *Server) requestPlayer(w http.ResponseWriter, r *http.Request, a *store.Assignment) (*store.Player, bool) {
	token := r.Header.Get(playerTokenHeader)
	if token == "" {
		writeText(w, http.StatusForbidden, "Unknown player")
		return nil, false
	}
	player, err := s.Assignments.PlayerByToken(r.Context(), a.ID, hashPlayerToken(token))
	if errors.Is(err, store.ErrNotFound) {
		writeText(w, http.StatusForbidden, "Unknown player")
		return nil, false
	}
	if err != nil {
		s.internalError(w, r, "looking up player failed", err)
		return nil, false
	}
	return player, true
}

// lowerStagesPassed reports whether the player has passed every stage of the assignment before this one,
// which is what the sequential stage lock asks of a stage.
func lowerStagesPassed(a *store.Assignment, p *store.Player, stage int) bool {
	for key := range a.StageCounts {
		if lower, err := strconv.Atoi(key); err == nil && lower < stage && !p.Stages[key].Passed {
			return false
		}
	}
	return true
}

// dealRun builds a run of the stage: the questions in a random order, each with the answers as it will be
// shown (stage 1 always "Đúng" then "Sai", the option stages shuffled, the sentence stage with its pieces
// mixed to an order that is not the answer), the first of them already served at now.
func dealRun(quiz *gesturequiz.Quiz, stage int, now time.Time) *store.Run {
	questions := quiz.Stages[stage]
	order := mrand.Perm(len(questions))
	run := &store.Run{
		ID:        newJobID(),
		Stage:     strconv.Itoa(stage),
		StartedAt: now,
		Questions: make([]store.RunQuestion, len(order)),
	}
	for i, item := range order {
		question := questions[item]
		dealt := store.RunQuestion{Item: item}
		switch stage {
		case gesturequiz.TrueFalseStage:
			dealt.Options = []string{gesturequiz.TrueAnswer, gesturequiz.FalseAnswer}
		case gesturequiz.WordOrderStage:
			dealt.Chunks = gesturequiz.ShuffleChunks(question.Chunks)
		default:
			dealt.Options = append([]string{question.Correct}, question.Wrong...)
			mrand.Shuffle(len(dealt.Options), func(i, j int) {
				dealt.Options[i], dealt.Options[j] = dealt.Options[j], dealt.Options[i]
			})
		}
		run.Questions[i] = dealt
	}
	first := now
	run.Questions[0].ServedAt = &first
	return run
}

// firstOpen is the index of the first question of the run that has not been answered, the one in play, or
// -1 when all of them are.
func firstOpen(run *store.Run) int {
	return slices.IndexFunc(run.Questions, func(q store.RunQuestion) bool { return q.AnsweredAt == nil })
}

// sourceOf finds the quiz's own question behind a dealt one.
func sourceOf(quiz *gesturequiz.Quiz, stage int, dealt store.RunQuestion) (gesturequiz.Question, bool) {
	questions := quiz.Stages[stage]
	if dealt.Item < 0 || dealt.Item >= len(questions) {
		return gesturequiz.Question{}, false
	}
	return questions[dealt.Item], true
}

// stageSeconds is how many seconds a question of the stage lasts in the standard time mode: the server's
// configuration, or gesturequiz's defaults when it has none (or not one value for each stage).
func (s *Server) stageSeconds(stage int) (int, bool) {
	if stage < gesturequiz.FirstStage || stage > gesturequiz.LastStage {
		return 0, false
	}
	if len(s.StageSeconds) == gesturequiz.LastStage {
		return s.StageSeconds[stage-1], true
	}
	return gesturequiz.DefaultSeconds[stage-1], true
}

// timeLimit is how long a question of the stage lasts in the time mode, and false when it has no limit. Every
// run handler asks here, so the limits are the server's configuration and nothing else.
func (s *Server) timeLimit(stage int, mode string) (time.Duration, bool) {
	seconds, ok := s.stageSeconds(stage)
	if !ok {
		return 0, false
	}
	return gesturequiz.TimeLimit(seconds, mode)
}

// timeLimits is what the students' page and the teacher's views are told about time: for each stage of the
// assignment the seconds a question lasts, the assignment's time mode already applied, and null for the
// unlimited mode. The page runs no table of its own: it shows what it is given here, from the current
// configuration, while the server judges answers by the same numbers.
func (s *Server) timeLimits(a *store.Assignment) map[string]*int {
	limits := make(map[string]*int, len(a.StageCounts))
	for key := range a.StageCounts {
		stage, err := strconv.Atoi(key)
		if err != nil {
			continue
		}
		var limit *int
		if seconds, ok := s.stageSeconds(stage); ok {
			if n, limited := gesturequiz.LimitSeconds(seconds, a.TimeMode); limited {
				limit = &n
			}
		}
		limits[key] = limit
	}
	return limits
}

// questionOf is question i of the run as the student is dealt it at now, which must have been served: the
// time left is the limit less what has passed since it was, never below nothing and never above the limit.
func (s *Server) questionOf(a *store.Assignment, run *store.Run, quiz *gesturequiz.Quiz, i int, now time.Time) (sharedQuestion, bool) {
	stage, _ := strconv.Atoi(run.Stage)
	dealt := run.Questions[i]
	source, ok := sourceOf(quiz, stage, dealt)
	if !ok {
		return sharedQuestion{}, false
	}
	view := sharedQuestion{
		Index:    i,
		Question: source.Question,
		Options:  dealt.Options,
		Chunks:   dealt.Chunks,
		GraceMs:  answerGrace.Milliseconds(),
	}
	if view.Options == nil {
		view.Options = []string{}
	}
	if limit, limited := s.timeLimit(stage, a.TimeMode); limited && dealt.ServedAt != nil {
		left := min(max(limit-now.Sub(*dealt.ServedAt), 0), limit).Milliseconds()
		view.TimeLeftMs = &left
	}
	return view, true
}

// resultOf is what a finished run scored: its right answers, out of all its questions, and whether that
// reaches the assignment's pass mark for the stage.
func resultOf(a *store.Assignment, run *store.Run) runResult {
	correct := 0
	for _, q := range run.Questions {
		if q.Correct {
			correct++
		}
	}
	total := len(run.Questions)
	return runResult{Correct: correct, Total: total, Passed: correct >= passMark(total, passPercentOf(a, run.Stage))}
}

// The kinds of choice an answer can carry.
const (
	choiceNone   = iota // null: the student's time ran out
	choiceNumber        // the index of an option
	choiceChunks        // the pieces of the sentence, in the order picked
)

// answerChoice is the choice of an answer, once its JSON type is known.
type answerChoice struct {
	kind   int
	number int
	chunks []string
}

// parseChoice reads the "choice" of an answer: null, a whole number, or an array of strings. A missing
// key and anything else (a string, a boolean, an object, a fraction, an array holding a non-string) is not
// a choice at all, which is not the same as a choice that is wrong.
func parseChoice(raw json.RawMessage) (answerChoice, bool) {
	text := strings.TrimSpace(string(raw))
	switch {
	case text == "":
		return answerChoice{}, false
	case text == "null":
		return answerChoice{kind: choiceNone}, true
	case text[0] == '[':
		var items []any
		if json.Unmarshal(raw, &items) != nil {
			return answerChoice{}, false
		}
		chunks := make([]string, len(items))
		for i, item := range items {
			piece, ok := item.(string)
			if !ok {
				return answerChoice{}, false
			}
			chunks[i] = piece
		}
		return answerChoice{kind: choiceChunks, chunks: chunks}, true
	}
	number, ok := parseInteger(raw)
	return answerChoice{kind: choiceNumber, number: number}, ok
}

// parseInteger reads a JSON number that is written as a plain integer: no fraction, no exponent, not null,
// not missing.
func parseInteger(raw json.RawMessage) (int, bool) {
	n, err := strconv.Atoi(strings.TrimSpace(string(raw)))
	return n, err == nil
}

// isRightChoice reports whether the choice is the answer to the question as it was dealt. For the option
// stages the number has to be the position of the right answer among the options shown; for the sentence
// stage the pieces have to be the sentence's own, in order, compared as text, so a sentence with a repeated
// word accepts either copy.
func isRightChoice(source gesturequiz.Question, dealt store.RunQuestion, choice answerChoice) bool {
	switch choice.kind {
	case choiceNumber:
		return len(source.Chunks) == 0 && choice.number >= 0 && choice.number < len(dealt.Options) &&
			dealt.Options[choice.number] == source.Correct
	case choiceChunks:
		return len(source.Chunks) > 0 && slices.Equal(choice.chunks, source.Chunks)
	}
	return false
}
