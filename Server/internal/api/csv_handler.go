package api

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"quiz-csv-import-tool/server/internal/bank"
	"quiz-csv-import-tool/server/internal/csvgen"
	"quiz-csv-import-tool/server/internal/imagestore"
	"quiz-csv-import-tool/server/internal/radicals"
	"quiz-csv-import-tool/server/internal/store"
)

const (
	maxUploadBytes = 50 << 20
	// maxJobsPerUser is how many finished jobs a user keeps; older ones are pruned when a new one starts.
	maxJobsPerUser = 30
	maxTitleRunes  = 100
	// jobHeartbeatInterval is how often the handler working on a job records that it still is, and
	// abandonedAfter how long a running job may go without that before listJobs takes its process for dead
	// (a crash, a deploy, or a Vercel function cut off at its limit). It does not depend on LLMTimeout: a job
	// of the AI server has no deadline, yet is listed by the main server.
	jobHeartbeatInterval = 30 * time.Second
	abandonedAfter       = 3 * time.Minute
	// bankJobDelay is the least time a quiz built from the question bank stays running, processing included, before it is done.
	bankJobDelay = 5 * time.Second
)

// createJob handles POST /api/csv/jobs: a multipart upload of zero or more images, or of the public IDs of
// images the browser uploaded to the image store itself (signUploads), rate-limited per user. It validates the request, stores a running job, answers 202 with the job's id right away and
// keeps working in this same handler until the model has answered, then stores the result. The
// client follows the job through listJobs, so it need not stay connected. A creative job goes to AIServerProxy
// instead, when there is one, unless the question bank holds its whole quiz.
func (s *Server) createJob(w http.ResponseWriter, r *http.Request) {
	if s.answerFromBank(w, r) {
		return
	}
	if s.AIServerProxy != nil && isCreative(r.URL.Query()) {
		s.AIServerProxy.ServeHTTP(w, r)
		return
	}
	user, ok := s.jobOwner(w, r)
	if !ok {
		return
	}

	body, uploadErr := readImages(w, r)
	if uploadErr != nil {
		writeText(w, uploadErr.status, uploadErr.msg)
		return
	}
	images := body.images
	var uploaded []store.JobImage
	if len(body.publicIDs) > 0 {
		if images, uploaded, ok = s.uploadedImages(w, r, body.publicIDs); !ok {
			return
		}
	}

	creative := isCreative(r.URL.Query())
	// Creative mode can work from the lesson identifiers alone; the formatted mode has nothing to
	// read without images.
	if !creative && len(images) == 0 {
		writeText(w, http.StatusBadRequest, "Image is required.")
		return
	}
	var opts csvgen.Options
	var err error
	if creative {
		opts, err = csvgen.ParseCreativeOptions(r.URL.Query())
	} else {
		// The formatted mode has nothing else to choose: the language picks its prompt.
		opts.Language, err = csvgen.ParseLanguage(r.URL.Query())
	}
	if err != nil {
		writeText(w, http.StatusBadRequest, err.Error())
		return
	}

	job := newJob(jobTitle(r.URL.Query().Get("title"), creative), creative, len(images), opts)
	if uploaded != nil {
		storedAt := s.now().UTC().Truncate(time.Millisecond)
		job.Images, job.ImagesStoredAt = uploaded, &storedAt
		s.deleteOldImagesWhenDue(context.WithoutCancel(r.Context()))
	}
	if s.startJob(w, r, user.Username, job, "") {
		s.runJob(context.WithoutCancel(r.Context()), job, images, opts)
	}
}

// retryJob handles POST /api/csv/jobs/{id}/retry ("Tạo lại"): a failed job's request sent again as a new
// job, which replaces the failed one. The images come from the image store, so a job sent with images can be
// retried only while they are kept (imagesKeptFor). Rate-limited and answered like createJob, and a creative job
// goes to AIServerProxy like there.
func (s *Server) retryJob(w http.ResponseWriter, r *http.Request) {
	s.retry(w, r, false)
}

// retry is retryJob; onlyCreative refuses a formatted job, as the AI server does.
func (s *Server) retry(w http.ResponseWriter, r *http.Request, onlyCreative bool) {
	if !s.jobStoreReady(w, r) {
		return
	}
	user, ok := s.jobOwner(w, r)
	if !ok {
		return
	}
	failed, ok := s.ownedJob(w, r, user.Username, r.PathValue("id"))
	if !ok {
		return
	}
	if failed.Status != store.JobFailed {
		writeText(w, http.StatusConflict, "Job has not failed.")
		return
	}
	opts, ok := retryOptions(failed)
	if !ok {
		writeText(w, http.StatusConflict, "Job cannot be retried.")
		return
	}
	if onlyCreative && !failed.Creative {
		writeText(w, http.StatusBadRequest, notCreative)
		return
	}
	if failed.Creative && failed.ImageCount == 0 {
		if build := s.bankPlan(r.Context(), user.Username, opts); build != nil &&
			s.startBankJob(w, r, user.Username, newJob(failed.Title, true, 0, opts), build, failed.ID) {
			return
		}
	}
	if failed.Creative && s.AIServerProxy != nil {
		s.AIServerProxy.ServeHTTP(w, r)
		return
	}
	var images []csvgen.Image
	if failed.ImageCount > 0 {
		if _, kept := s.imagesKeptUntil(failed); !kept {
			writeText(w, http.StatusGone, "Images expired.")
			return
		}
		var err error
		images, err = s.ImageStore.Fetch(r.Context(), failed.Images)
		if errors.Is(err, imagestore.ErrGone) {
			writeText(w, http.StatusGone, "Images expired.")
			return
		}
		if err != nil {
			s.internalError(w, r, "fetching the job's images failed", err)
			return
		}
	}

	job := newJob(failed.Title, failed.Creative, len(images), opts)
	// The new job keeps the same images, as long as they are kept: they are not stored again.
	job.Images, job.ImagesStoredAt = failed.Images, failed.ImagesStoredAt
	if s.startJob(w, r, user.Username, job, failed.ID) {
		s.runJob(context.WithoutCancel(r.Context()), job, images, opts)
	}
}

// jobOwner loads the caller's user document, which the rate limit needs, or answers why it cannot: the token
// outlives a deleted user by up to its lifetime. The job routes wrap their handlers in authenticate and
// requireRole, so the caller's claims are always in the context.
func (s *Server) jobOwner(w http.ResponseWriter, r *http.Request) (*store.User, bool) {
	user, err := s.Users.FindByUsername(r.Context(), callerName(r))
	if errors.Is(err, store.ErrNotFound) {
		writeText(w, http.StatusNotFound, "User not found")
		return nil, false
	}
	if err != nil {
		s.internalError(w, r, "loading user failed", err)
		return nil, false
	}
	return user, true
}

// startJob counts the call against the user's rate limit, stores the job as running and answers 202 with its
// id, or answers why it cannot and returns false; the caller then runs the job with runJob. A retry names the
// failed job it replaces, which is deleted before the answer.
func (s *Server) startJob(w http.ResponseWriter, r *http.Request, username string, job *store.Job, replaces string) bool {
	if s.Generator == nil || s.Jobs == nil {
		s.internalError(w, r, "CSV generation is not configured", errors.New("OPENAI_API_KEY, OPENAI_BASE_URL and LLM_MODEL must be set"))
		return false
	}

	roundStart, allowed, err := s.Users.TryConsumeAICall(r.Context(), username, s.AICallsPerRound, s.RoundDuration)
	if err != nil {
		s.internalError(w, r, "updating AI call count failed", err)
		return false
	}
	if !allowed {
		writeText(w, http.StatusForbidden, "You have reached the limit for AI calls.")
		return false
	}

	job.ID, job.Username, job.Status, job.RoundStart = newID(), username, store.JobRunning, roundStart
	job.CreatedAt = time.Now().UTC().Truncate(time.Millisecond)
	if err := s.Jobs.Create(r.Context(), job); err != nil {
		s.refundAICall(r.Context(), username, roundStart)
		s.internalError(w, r, "creating job failed", err)
		return false
	}
	s.acceptJob(w, r, username, job, replaces)
	return true
}

// acceptJob answers 202 with the id of a job just stored, after the housekeeping: the failed job a retry replaces
// is deleted and the user's oldest jobs pruned.
func (s *Server) acceptJob(w http.ResponseWriter, r *http.Request, username string, job *store.Job, replaces string) {
	// Housekeeping must not fail the request: the job exists and will run. At worst a failed job that was
	// retried stays in the history beside its replacement.
	if replaces != "" {
		if err := s.Jobs.Delete(r.Context(), username, replaces); err != nil && !errors.Is(err, store.ErrNotFound) {
			s.Logger.Warn("deleting the retried job failed", "user", username, "job", replaces, "error", err)
		}
	}
	if err := s.Jobs.Prune(r.Context(), username, maxJobsPerUser); err != nil {
		s.Logger.Warn("pruning old jobs failed", "user", username, "error", err)
	}

	ack, _ := json.Marshal(map[string]string{"id": job.ID})
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Content-Length", strconv.Itoa(len(ack)))
	// The handler goes on running after this answer, and a client that reused this connection for its
	// next request would wait behind it, so the connection is not offered for reuse.
	w.Header().Set("Connection", "close")
	w.WriteHeader(http.StatusAccepted)
	_, _ = w.Write(ack)
	// Best effort: where the answer cannot be flushed early the client simply waits for the result.
	_ = http.NewResponseController(w).Flush()
}

// answerFromBank answers a createJob request whose whole quiz the question bank holds, with a job that is done at
// once, takes no AI call and asks no model, on whichever server it reached; it returns false, the
// body untouched, for any other request, which then goes its usual way (where the bank may still supply part of
// the quiz, see bank.Generator). A quiz asked with images is the model's: the images show what to focus on.
func (s *Server) answerFromBank(w http.ResponseWriter, r *http.Request) bool {
	if s.Bank == nil || !isCreative(r.URL.Query()) {
		return false
	}
	opts, err := csvgen.ParseCreativeOptions(r.URL.Query())
	if err != nil {
		return false
	}
	build := s.bankPlan(r.Context(), callerName(r), opts)
	if build == nil {
		return false
	}
	// The body is read here only to know that it holds no image, and put back for the usual way.
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxUploadBytes))
	r.Body = io.NopCloser(bytes.NewReader(raw))
	if err != nil {
		return false
	}
	body, uploadErr := readImages(w, r)
	r.Body = io.NopCloser(bytes.NewReader(raw))
	if uploadErr != nil || len(body.images) > 0 || len(body.publicIDs) > 0 {
		return false
	}
	user, ok := s.jobOwner(w, r)
	if !ok {
		return true
	}
	return s.startBankJob(w, r, user.Username, newJob(jobTitle(r.URL.Query().Get("title"), true), true, 0, opts), build, "")
}

// bankPlan is the plan of the quiz of opts when the question bank holds all of it, nil otherwise (or when the bank
// cannot be read: the model then writes the quiz).
func (s *Server) bankPlan(ctx context.Context, username string, opts csvgen.Options) *bank.Build {
	if s.Bank == nil || s.Jobs == nil {
		return nil
	}
	build, ok, err := s.Bank.Prepare(ctx, opts)
	if err != nil {
		s.Logger.Warn("question bank unavailable", "user", username, "error", err)
		return nil
	}
	if !ok || !build.Plan.Complete() {
		return nil
	}
	return build
}

// startBankJob writes the quiz of a complete bank plan, counting no AI call, stores it as a running job and answers
// 202 with its id like startJob, then marks it done once bankJobDelay has passed since the start, processing included: the client announces a job only when it
// sees it go from running to done, which a job stored as done at once never does. It returns false, having
// answered nothing, when the quiz cannot be written; the request then goes its usual way.
func (s *Server) startBankJob(w http.ResponseWriter, r *http.Request, username string, job *store.Job, build *bank.Build, replaces string) bool {
	started := time.Now()
	result, err := s.Bank.Finish(r.Context(), build, len(build.Plan.Picks))
	if err != nil {
		s.Logger.Warn("writing a quiz from the question bank failed", "user", username, "error", err)
		return false
	}
	job.ID, job.Username, job.Status = newID(), username, store.JobRunning
	job.CreatedAt = time.Now().UTC().Truncate(time.Millisecond)
	if err := s.Jobs.Create(r.Context(), job); err != nil {
		s.internalError(w, r, "creating job failed", err)
		return true
	}
	s.Logger.Info("quiz built from the question bank", "user", username, "job", job.ID, "questions", len(result.BankQuestions))
	s.acceptJob(w, r, username, job, replaces)

	delay := s.bankJobDelay
	if delay <= 0 {
		delay = bankJobDelay
	}
	if remaining := delay - time.Since(started); remaining > 0 {
		time.Sleep(remaining)
	}
	s.recordJob(context.WithoutCancel(r.Context()), func(ctx context.Context) error {
		return s.Jobs.Complete(ctx, username, job.ID, store.JobResult{
			CSV: result.CSV, BankQuestions: result.BankQuestions, FromBank: result.FromBank,
		})
	}, job)
	return true
}

// runJob generates the CSV and records the outcome on the job. ctx is detached from
// the request: the client has usually gone away by now (that is the point), and its disconnecting must not cancel
// the model call.
func (s *Server) runJob(ctx context.Context, job *store.Job, images []csvgen.Image, opts csvgen.Options) {
	// The questions the model writes for the question bank name the job.
	ctx = bank.WithJob(ctx, job.ID)
	generation := ctx
	if s.LLMTimeout > 0 {
		var cancel context.CancelFunc
		generation, cancel = context.WithTimeout(ctx, s.LLMTimeout)
		defer cancel()
	}
	stopHeartbeat := s.keepJobAlive(ctx, job)
	started := time.Now()
	result, err := s.Generator.Generate(generation, images, job.Creative, opts)
	stopHeartbeat()
	usage := jobUsage(result.Usage, time.Since(started))
	logAttrs := []any{"user", job.Username, "job", job.ID, "images", len(images), "model", usage.Model, "calls", usage.Calls,
		"durationMs", usage.DurationMs, "inputTokens", usage.InputTokens, "cachedTokens", usage.CachedTokens,
		"outputTokens", usage.OutputTokens}

	if err == nil {
		s.Logger.Info("CSV generation done", logAttrs...)
		s.recordJob(ctx, func(ctx context.Context) error {
			return s.Jobs.Complete(ctx, job.Username, job.ID, store.JobResult{
				CSV: result.CSV, Source: result.Source, Usage: &usage, BankQuestions: result.BankQuestions, FromBank: result.FromBank,
			})
		}, job)
		return
	}
	failure := generationFailure(generation, err)
	s.Logger.Warn("CSV generation failed", append(logAttrs, "code", failure.Code, "error", err)...)
	s.recordJob(ctx, func(ctx context.Context) error {
		return s.Jobs.Fail(ctx, job.Username, job.ID, failure, usage)
	}, job)
	// A failed generation produced nothing, so it gives the call back: the user resubmits and must not
	// run into the rate limit doing so.
	s.refundAICall(ctx, job.Username, job.RoundStart)
}

// Failure codes of the handler's own, beside csvgen's Failure* codes and store.ExpiredJobCode.
const (
	failureTimeout       = "timeout"
	failureNothingToPlay = "nothing_to_play"
)

// generationFailure is how a job whose generation returned err failed, ctx being the generation's.
func generationFailure(ctx context.Context, err error) store.JobFailure {
	switch {
	case errors.Is(err, radicals.ErrNothingToPlay):
		// Not the model's fault, nor the network's: the lessons had too few words that can lose a component.
		return store.JobFailure{Status: http.StatusUnprocessableEntity, Code: failureNothingToPlay, Message: err.Error()}
	case errors.Is(ctx.Err(), context.DeadlineExceeded):
		return store.JobFailure{Status: http.StatusGatewayTimeout, Code: failureTimeout, Message: "AI generation timed out."}
	}
	return store.JobFailure{Status: http.StatusBadGateway, Code: csvgen.FailureCode(err), Message: "AI generation failed."}
}

// keepJobAlive records the job's heartbeat every heartbeat interval until the returned stop is called, so
// listJobs can tell a job whose process died from one that just takes long. A failed write only risks the
// job being taken for abandoned once abandonedAfter has passed without one.
func (s *Server) keepJobAlive(ctx context.Context, job *store.Job) (stop func()) {
	every := s.heartbeatEvery
	if every <= 0 {
		every = jobHeartbeatInterval
	}
	done, finished := make(chan struct{}), make(chan struct{})
	go func() {
		defer close(finished)
		ticker := time.NewTicker(every)
		defer ticker.Stop()
		for {
			select {
			case <-done:
				return
			case <-ticker.C:
				ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
				if err := s.Jobs.Heartbeat(ctx, job.Username, job.ID); err != nil {
					s.Logger.Warn("recording job heartbeat failed", "user", job.Username, "job", job.ID, "error", err)
				}
				cancel()
			}
		}
	}()
	return func() {
		close(done)
		<-finished
	}
}

func jobUsage(usage csvgen.Usage, took time.Duration) store.JobUsage {
	return store.JobUsage{
		Model: usage.Model, Calls: usage.Calls, InputTokens: usage.InputTokens, CachedTokens: usage.CachedTokens,
		OutputTokens: usage.OutputTokens, DurationMs: took.Milliseconds(),
	}
}

// recordJob writes a job's outcome with its own deadline, since the generation's may be used up.
func (s *Server) recordJob(ctx context.Context, write func(context.Context) error, job *store.Job) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if err := write(ctx); err != nil {
		// The job stays running until listJobs expires it as abandoned.
		s.Logger.Error("recording job outcome failed", "user", job.Username, "job", job.ID, "error", err)
	}
}

// jobView is a job as the client sees it. The CSV is empty until the job is done.
type jobView struct {
	ID            string     `json:"id"`
	Status        string     `json:"status"`
	Title         string     `json:"title"`
	Creative      bool       `json:"creative"`
	Language      int        `json:"language"`
	ExportType    *int       `json:"exportType"`
	ImageCount    int        `json:"imageCount"`
	CourseType    *int       `json:"courseType"`
	CourseName    string     `json:"courseName"`
	HskStandard   *int       `json:"hskStandard"`
	Level         *int       `json:"level"`
	LessonNumbers []int      `json:"lessonNumbers"`
	CSV           string     `json:"csv"`
	ErrorStatus   int        `json:"errorStatus"`
	ErrorCode     string     `json:"errorCode"`
	ErrorMessage  string     `json:"errorMessage"`
	CreatedAt     time.Time  `json:"createdAt"`
	FinishedAt    *time.Time `json:"finishedAt"`
	// Retryable says whether retryJob would take the job; RetryUntil is when its images stop being kept,
	// null for a job without images or that cannot be retried.
	Retryable  bool       `json:"retryable"`
	RetryUntil *time.Time `json:"retryUntil"`
}

// listJobs handles GET /api/csv/jobs: the caller's newest jobs, which the client polls while any is running.
func (s *Server) listJobs(w http.ResponseWriter, r *http.Request) {
	username := callerName(r)
	if !s.jobStoreReady(w, r) {
		return
	}

	// A running job whose heartbeat stopped lost the process that was working on it; fail it and give the
	// call back, or the client would poll it forever. The AI server takes its own, the creative ones, over instead
	// (ResumeJob), so those are given longer, and that server is woken should it be asleep.
	now := time.Now()
	cutoffs := store.ExpiryCutoffs{Before: now.Add(-abandonedAfter)}
	if s.AIServerProxy != nil {
		cutoffs.Resumable, cutoffs.MaxResumes, cutoffs.ResumableBefore = true, maxResumes, now.Add(-resumeGiveUp)
	}
	expired, err := s.Jobs.ExpireRunning(r.Context(), username, cutoffs, interruptedMessage)
	if err != nil {
		s.Logger.Warn("expiring abandoned jobs failed", "user", username, "error", err)
	}
	for _, job := range expired {
		s.Logger.Warn("job abandoned", "user", username, "job", job.ID)
		s.refundAICall(r.Context(), username, job.RoundStart)
	}

	jobs, err := s.Jobs.List(r.Context(), username, maxJobsPerUser)
	if err != nil {
		s.internalError(w, r, "listing jobs failed", err)
		return
	}
	if s.AIServerProxy != nil && slices.ContainsFunc(jobs, awaitingResume(now)) && s.due(&s.wokeAt, wakeEvery) {
		s.AIServerProxy.Wake(r.Context())
	}
	views := make([]jobView, len(jobs))
	for i := range jobs {
		views[i] = s.newJobView(&jobs[i])
	}
	noStore(w)
	writeJSON(w, http.StatusOK, map[string]any{"jobs": views})
}

func (s *Server) newJobView(j *store.Job) jobView {
	retryable, retryUntil := s.retryState(j)
	return jobView{
		ID: j.ID, Status: string(j.Status), Title: j.Title, Creative: j.Creative, Language: j.Language, ExportType: j.ExportType,
		ImageCount: j.ImageCount, CourseType: j.CourseType, CourseName: j.CourseName,
		HskStandard: j.HskStandard, Level: j.Level, LessonNumbers: j.LessonNumbers, CSV: j.CSV,
		ErrorStatus: j.ErrorStatus, ErrorCode: j.ErrorCode, ErrorMessage: j.ErrorMessage, CreatedAt: j.CreatedAt, FinishedAt: j.FinishedAt,
		Retryable: retryable, RetryUntil: retryUntil,
	}
}

// deleteJob handles DELETE /api/csv/jobs/{id}.
func (s *Server) deleteJob(w http.ResponseWriter, r *http.Request) {
	if !s.jobStoreReady(w, r) {
		return
	}
	err := s.Jobs.Delete(r.Context(), callerName(r), r.PathValue("id"))
	if errors.Is(err, store.ErrNotFound) {
		writeText(w, http.StatusNotFound, "Job not found")
		return
	}
	if err != nil {
		s.internalError(w, r, "deleting job failed", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// jobPage handles GET /api/csv/jobs/{id}/page: the "Ghép bộ thủ" page of a finished Radicals job, drawn from
// the exercise the job keeps. The client plays it in a frame and offers it as a download.
func (s *Server) jobPage(w http.ResponseWriter, r *http.Request) {
	job, ok := s.radicalsJob(w, r)
	if !ok {
		return
	}
	var exercise radicals.Exercise
	if err := json.Unmarshal([]byte(job.CSV), &exercise); err != nil {
		s.internalError(w, r, "reading the exercise failed", err)
		return
	}
	page, err := radicals.RenderHTML(&exercise)
	if err != nil {
		s.internalError(w, r, "drawing the exercise failed", err)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	noStore(w)
	_, _ = io.WriteString(w, page)
}

// retryState says whether retryJob would take a job, and until when for one whose images are kept only for a while
// (imagesKeptFor).
func (s *Server) retryState(job *store.Job) (bool, *time.Time) {
	if job.Status != store.JobFailed {
		return false, nil
	}
	if _, ok := retryOptions(job); !ok {
		return false, nil
	}
	if job.ImageCount == 0 {
		return true, nil
	}
	if until, kept := s.imagesKeptUntil(job); kept {
		return true, &until
	}
	return false, nil
}

func newID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// jobTitle is the client's name for the job, trimmed and capped; a default stands in for none.
func jobTitle(raw string, creative bool) string {
	title := strings.TrimSpace(raw)
	if title == "" {
		if creative {
			return "AI tự nghĩ câu hỏi"
		}
		return "Hỏi chữ Hán"
	}
	if utf8.RuneCountInString(title) > maxTitleRunes {
		title = string([]rune(title)[:maxTitleRunes])
	}
	return title
}

func (s *Server) refundAICall(ctx context.Context, username string, roundStart time.Time) {
	// Detached from the request: the refund must happen even if the client has gone away.
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	if err := s.Users.RefundAICall(ctx, username, roundStart); err != nil {
		s.Logger.Warn("refunding AI call failed", "user", username, "error", err)
	}
}

// imagesBody is what a job request sends of its images: the images, or the public IDs they were uploaded under.
type imagesBody struct {
	images    []csvgen.Image
	publicIDs []string
}

// uploadedImageField names the multipart fields holding a public ID of an uploaded image.
const uploadedImageField = "imageId"

// readImages collects every file part of the multipart body, and every uploadedImageField, but not both. A body
// with no image at all is fine: creative mode can run without images.
func readImages(w http.ResponseWriter, r *http.Request) (imagesBody, *requestError) {
	contentType := r.Header.Get("Content-Type")
	if contentType == "" {
		return imagesBody{}, &requestError{http.StatusBadRequest, "Missing Content-Type header"}
	}
	if !strings.Contains(strings.ToLower(contentType), "multipart/form-data") {
		return imagesBody{}, &requestError{http.StatusBadRequest, "Expected multipart/form-data"}
	}
	_, params, err := mime.ParseMediaType(contentType)
	if err != nil || params["boundary"] == "" {
		return imagesBody{}, &requestError{http.StatusBadRequest, "Missing multipart boundary"}
	}

	reader := multipart.NewReader(http.MaxBytesReader(w, r.Body, maxUploadBytes), params["boundary"])
	var body imagesBody
	for {
		part, err := reader.NextPart()
		// Only a bare io.EOF marks the closing delimiter; a wrapped EOF means the body was truncated
		// (even an empty multipart body must end with its closing delimiter).
		if err == io.EOF {
			if len(body.images) > 0 && len(body.publicIDs) > 0 {
				return imagesBody{}, &requestError{http.StatusBadRequest, "Send images or uploaded images, not both."}
			}
			return body, nil
		}
		if err != nil {
			return imagesBody{}, uploadError(err)
		}

		disposition, dispParams, _ := mime.ParseMediaType(part.Header.Get("Content-Disposition"))
		if disposition != "form-data" {
			_ = part.Close()
			continue
		}
		if dispParams["filename"] == "" {
			if dispParams["name"] == uploadedImageField {
				publicID, err := io.ReadAll(io.LimitReader(part, 256))
				if err != nil {
					return imagesBody{}, uploadError(err)
				}
				body.publicIDs = append(body.publicIDs, string(publicID))
			}
			_ = part.Close()
			continue
		}
		data, err := io.ReadAll(part)
		if err != nil {
			return imagesBody{}, uploadError(err)
		}
		imageType, ok := detectImageType(data)
		if !ok {
			return imagesBody{}, &requestError{http.StatusBadRequest, "Unsupported image type."}
		}
		body.images = append(body.images, csvgen.Image{ContentType: imageType, Data: data})
	}
}

// detectImageType sniffs the bytes rather than trusting the part's Content-Type header, since the type
// is written into the data: URL sent to the model.
func detectImageType(data []byte) (string, bool) {
	detected := http.DetectContentType(data)
	switch detected {
	case "image/png", "image/jpeg", "image/webp", "image/gif":
		return detected, true
	}
	return "", false
}

// requestError is a client error to answer with as plain text.
type requestError struct {
	status int
	msg    string
}

func uploadError(err error) *requestError {
	var tooLarge *http.MaxBytesError
	if errors.As(err, &tooLarge) {
		return &requestError{http.StatusRequestEntityTooLarge, "Upload is too large."}
	}
	return &requestError{http.StatusBadRequest, "Malformed multipart body."}
}
