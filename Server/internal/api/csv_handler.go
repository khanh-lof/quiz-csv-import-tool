package api

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"quiz-csv-import-tool/server/internal/auth"
	"quiz-csv-import-tool/server/internal/csvgen"
	"quiz-csv-import-tool/server/internal/store"
)

const (
	maxUploadBytes = 50 << 20
	// maxJobsPerUser is how many finished jobs a user keeps; older ones are pruned when a new one starts.
	maxJobsPerUser = 30
	maxTitleRunes  = 100
	// abandonedGrace is how long past the LLM deadline a job may still be running before it counts as
	// abandoned (its process died), which leaves room for the final database write.
	abandonedGrace = time.Minute
	// abandonedWithoutTimeout applies when no LLM timeout is configured.
	abandonedWithoutTimeout = 15 * time.Minute
)

// createJob handles POST /api/csv/jobs: a multipart upload of zero or more images, rate-limited per
// user. It validates the request, stores a running job, answers 202 with the job's id right away and
// keeps working in this same handler until the model has answered, then stores the result. The
// client follows the job through listJobs, so it need not stay connected.
func (s *Server) createJob(w http.ResponseWriter, r *http.Request) {
	user, ok := s.jobOwner(w, r)
	if !ok {
		return
	}

	images, uploadErr := readImages(w, r)
	if uploadErr != nil {
		writeText(w, uploadErr.status, uploadErr.msg)
		return
	}

	creative := strings.EqualFold(strings.TrimSpace(r.URL.Query().Get("isCreative")), "true")
	// Creative mode can work from the lesson identifiers alone; the formatted mode has nothing to
	// read without images.
	if !creative && len(images) == 0 {
		writeText(w, http.StatusBadRequest, "Image is required.")
		return
	}
	var opts csvgen.Options
	if creative {
		var err error
		if opts, err = csvgen.ParseCreativeOptions(r.URL.Query()); err != nil {
			writeText(w, http.StatusBadRequest, err.Error())
			return
		}
	}

	job := newJob(jobTitle(r.URL.Query().Get("title"), creative), creative, len(images), opts)
	if s.startJob(w, r, user.Username, job, "") {
		s.runJob(r, job, images, opts)
	}
}

// retryJob handles POST /api/csv/jobs/{id}/retry ("Tạo lại"): a failed job's request sent again as a new
// job, which replaces the failed one. The images come from retryImages, so a job sent with images can be
// retried only while they are kept. Rate-limited and answered like createJob.
func (s *Server) retryJob(w http.ResponseWriter, r *http.Request) {
	if s.Jobs == nil {
		s.internalError(w, r, "jobs are not configured", errors.New("no job store"))
		return
	}
	user, ok := s.jobOwner(w, r)
	if !ok {
		return
	}
	failed, err := s.Jobs.Get(r.Context(), user.Username, r.PathValue("id"))
	if errors.Is(err, store.ErrNotFound) {
		writeText(w, http.StatusNotFound, "Job not found")
		return
	}
	if err != nil {
		s.internalError(w, r, "loading job failed", err)
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
	var images []csvgen.Image
	if failed.ImageCount > 0 {
		if images, _, ok = s.retryImages.get(failed.ID, user.Username, s.now()); !ok {
			writeText(w, http.StatusGone, "Images expired.")
			return
		}
	}

	job := newJob(failed.Title, failed.Creative, len(images), opts)
	if s.startJob(w, r, user.Username, job, failed.ID) {
		s.runJob(r, job, images, opts)
	}
}

// jobOwner loads the caller's user document, which the rate limit needs, or answers why it cannot: the token
// outlives a deleted user by up to its lifetime. The job routes wrap their handlers in authenticate and
// requireRole, so the caller's claims are always in the context.
func (s *Server) jobOwner(w http.ResponseWriter, r *http.Request) (*store.User, bool) {
	claims, _ := auth.FromContext(r.Context())
	user, err := s.Users.FindByUsername(r.Context(), claims.Username())
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

// newJob describes a job to start. A creative job keeps its lesson, so the history can be filtered by it,
// and everything else retryOptions needs to ask for the same quiz again.
func newJob(title string, creative bool, imageCount int, opts csvgen.Options) *store.Job {
	job := &store.Job{Title: title, Creative: creative, ImageCount: imageCount}
	if !creative {
		return job
	}
	exportType := int(opts.ExportType)
	courseType := int(opts.CourseType)
	job.ExportType, job.Intelligence, job.CourseType = &exportType, opts.Intelligence, &courseType
	job.Level, job.LessonNumbers = opts.Level, opts.LessonNumbers
	if opts.CourseType == csvgen.Hsk {
		hskStandard := int(opts.HskStandard)
		job.HskStandard = &hskStandard
	}
	if opts.CourseType == csvgen.Other {
		job.CourseName = opts.CourseName
	}
	if opts.ExportType == csvgen.GestureQuiz {
		questionsPerStage := opts.GestureQuizQuestions()
		job.GestureStages, job.QuestionsPerStage = opts.GestureQuizStages(), &questionsPerStage
	}
	return job
}

// retryOptions rebuilds the options a job was generated with from what the job keeps. False for a creative
// job from before the lesson, or a Game's choice of games, was kept: sending it again would ask for another quiz.
func retryOptions(job *store.Job) (csvgen.Options, bool) {
	if !job.Creative {
		return csvgen.Options{}, true
	}
	if job.ExportType == nil || job.CourseType == nil || len(job.LessonNumbers) == 0 {
		return csvgen.Options{}, false
	}
	opts := csvgen.Options{
		ExportType: csvgen.ExportType(*job.ExportType), CourseType: csvgen.CourseType(*job.CourseType),
		CourseName: job.CourseName, Level: job.Level, LessonNumbers: job.LessonNumbers, Intelligence: job.Intelligence,
	}
	if opts.CourseType == csvgen.Hsk {
		opts.HskStandard = csvgen.Hsk2
		if job.HskStandard != nil {
			opts.HskStandard = csvgen.HskStandard(*job.HskStandard)
		}
	}
	if opts.ExportType == csvgen.GestureQuiz {
		if job.GestureStages == nil || job.QuestionsPerStage == nil {
			return csvgen.Options{}, false
		}
		opts.GestureStages, opts.QuestionsPerStage = job.GestureStages, *job.QuestionsPerStage
	}
	return opts, true
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

	job.ID, job.Username, job.Status, job.RoundStart = newJobID(), username, store.JobRunning, roundStart
	job.CreatedAt = time.Now().UTC().Truncate(time.Millisecond)
	if err := s.Jobs.Create(r.Context(), job); err != nil {
		s.refundAICall(r, username, roundStart)
		s.internalError(w, r, "creating job failed", err)
		return false
	}
	// Housekeeping must not fail the request: the job exists and will run. At worst a failed job that was
	// retried stays in the history beside its replacement.
	if replaces != "" {
		if err := s.Jobs.Delete(r.Context(), username, replaces); err != nil && !errors.Is(err, store.ErrNotFound) {
			s.Logger.Warn("deleting the retried job failed", "user", username, "job", replaces, "error", err)
		}
		s.retryImages.drop(replaces)
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
	return true
}

// runJob generates the CSV and records the outcome on the job. It runs detached from the request: the
// client has usually gone away by now (that is the point), and its disconnecting must not cancel the
// model call.
func (s *Server) runJob(r *http.Request, job *store.Job, images []csvgen.Image, opts csvgen.Options) {
	ctx := context.WithoutCancel(r.Context())
	if s.LLMTimeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, s.LLMTimeout)
		defer cancel()
	}
	csv, err := s.Generator.Generate(ctx, images, job.Creative, opts)

	switch {
	case err == nil:
		s.recordJob(r, func(ctx context.Context) error { return s.Jobs.Complete(ctx, job.Username, job.ID, csv) }, job)
		return
	case errors.Is(ctx.Err(), context.DeadlineExceeded):
		s.Logger.Warn("CSV generation timed out", "user", job.Username, "images", len(images), "timeout", s.LLMTimeout)
		s.recordJob(r, func(ctx context.Context) error {
			return s.Jobs.Fail(ctx, job.Username, job.ID, http.StatusGatewayTimeout, "AI generation timed out.")
		}, job)
	default:
		s.Logger.Error("CSV generation failed", "user", job.Username, "error", err)
		s.recordJob(r, func(ctx context.Context) error {
			return s.Jobs.Fail(ctx, job.Username, job.ID, http.StatusBadGateway, "AI generation failed.")
		}, job)
	}
	// A failed generation produced nothing, so it gives the call back: the user resubmits and must not
	// run into the rate limit doing so. Its images are kept for a while, so "Tạo lại" need not upload them.
	s.refundAICall(r, job.Username, job.RoundStart)
	if len(images) > 0 {
		now := s.now()
		s.retryImages.keep(job.ID, job.Username, images, now, now.Add(retryImagesTTL))
	}
}

// recordJob writes a job's outcome with its own deadline, since the generation's may be used up.
func (s *Server) recordJob(r *http.Request, write func(context.Context) error, job *store.Job) {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 10*time.Second)
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
	ExportType    *int       `json:"exportType"`
	Intelligence  int        `json:"intelligence"`
	ImageCount    int        `json:"imageCount"`
	CourseType    *int       `json:"courseType"`
	CourseName    string     `json:"courseName"`
	HskStandard   *int       `json:"hskStandard"`
	Level         *int       `json:"level"`
	LessonNumbers []int      `json:"lessonNumbers"`
	CSV           string     `json:"csv"`
	ErrorStatus   int        `json:"errorStatus"`
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
	claims, _ := auth.FromContext(r.Context())
	username := claims.Username()
	if s.Jobs == nil {
		s.internalError(w, r, "jobs are not configured", errors.New("no job store"))
		return
	}

	// A job still running long after its deadline lost the process that was working on it; fail it
	// and give the call back, or the client would poll it forever.
	patience := abandonedWithoutTimeout
	if s.LLMTimeout > 0 {
		patience = s.LLMTimeout + abandonedGrace
	}
	expired, err := s.Jobs.ExpireRunning(r.Context(), username, time.Now().Add(-patience), "AI generation was interrupted.")
	if err != nil {
		s.Logger.Warn("expiring abandoned jobs failed", "user", username, "error", err)
	}
	for _, job := range expired {
		s.Logger.Warn("job abandoned", "user", username, "job", job.ID)
		s.refundAICall(r, username, job.RoundStart)
	}

	jobs, err := s.Jobs.List(r.Context(), username, maxJobsPerUser)
	if err != nil {
		s.internalError(w, r, "listing jobs failed", err)
		return
	}
	views := make([]jobView, len(jobs))
	for i, j := range jobs {
		retryable, retryUntil := s.retryState(&j)
		views[i] = jobView{
			ID: j.ID, Status: string(j.Status), Title: j.Title, Creative: j.Creative, ExportType: j.ExportType,
			Intelligence: j.Intelligence, ImageCount: j.ImageCount, CourseType: j.CourseType, CourseName: j.CourseName,
			HskStandard: j.HskStandard, Level: j.Level, LessonNumbers: j.LessonNumbers, CSV: j.CSV,
			ErrorStatus: j.ErrorStatus, ErrorMessage: j.ErrorMessage, CreatedAt: j.CreatedAt, FinishedAt: j.FinishedAt,
			Retryable: retryable, RetryUntil: retryUntil,
		}
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(map[string]any{"jobs": views})
}

// deleteJob handles DELETE /api/csv/jobs/{id}.
func (s *Server) deleteJob(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.FromContext(r.Context())
	if s.Jobs == nil {
		s.internalError(w, r, "jobs are not configured", errors.New("no job store"))
		return
	}
	err := s.Jobs.Delete(r.Context(), claims.Username(), r.PathValue("id"))
	if errors.Is(err, store.ErrNotFound) {
		writeText(w, http.StatusNotFound, "Job not found")
		return
	}
	if err != nil {
		s.internalError(w, r, "deleting job failed", err)
		return
	}
	s.retryImages.drop(r.PathValue("id"))
	w.WriteHeader(http.StatusNoContent)
}

// retryState says whether retryJob would take a job, and until when for one whose images are kept only for a while.
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
	if _, until, ok := s.retryImages.get(job.ID, job.Username, s.now()); ok {
		until = until.UTC()
		return true, &until
	}
	return false, nil
}

func newJobID() string {
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
		return "Từ ảnh bài học"
	}
	if utf8.RuneCountInString(title) > maxTitleRunes {
		title = string([]rune(title)[:maxTitleRunes])
	}
	return title
}

func (s *Server) refundAICall(r *http.Request, username string, roundStart time.Time) {
	// Detached from the request: the refund must happen even if the client has gone away.
	ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 5*time.Second)
	defer cancel()
	if err := s.Users.RefundAICall(ctx, username, roundStart); err != nil {
		s.Logger.Warn("refunding AI call failed", "user", username, "error", err)
	}
}

// readImages collects every file part of the multipart body. A body with no file at all is fine:
// creative mode can run without images.
func readImages(w http.ResponseWriter, r *http.Request) ([]csvgen.Image, *requestError) {
	contentType := r.Header.Get("Content-Type")
	if contentType == "" {
		return nil, &requestError{http.StatusBadRequest, "Missing Content-Type header"}
	}
	if !strings.Contains(strings.ToLower(contentType), "multipart/form-data") {
		return nil, &requestError{http.StatusBadRequest, "Expected multipart/form-data"}
	}
	_, params, err := mime.ParseMediaType(contentType)
	if err != nil || params["boundary"] == "" {
		return nil, &requestError{http.StatusBadRequest, "Missing multipart boundary"}
	}

	reader := multipart.NewReader(http.MaxBytesReader(w, r.Body, maxUploadBytes), params["boundary"])
	var images []csvgen.Image
	for {
		part, err := reader.NextPart()
		// Only a bare io.EOF marks the closing delimiter; a wrapped EOF means the body was truncated
		// (even an empty multipart body must end with its closing delimiter).
		if err == io.EOF {
			return images, nil
		}
		if err != nil {
			return nil, uploadError(err)
		}

		disposition, dispParams, _ := mime.ParseMediaType(part.Header.Get("Content-Disposition"))
		if disposition != "form-data" || dispParams["filename"] == "" {
			_ = part.Close()
			continue
		}
		data, err := io.ReadAll(part)
		if err != nil {
			return nil, uploadError(err)
		}
		partType := part.Header.Get("Content-Type")
		if partType == "" {
			partType = "application/octet-stream"
		}
		images = append(images, csvgen.Image{ContentType: partType, Data: data})
	}
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
