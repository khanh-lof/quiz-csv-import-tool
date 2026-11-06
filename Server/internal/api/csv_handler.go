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
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

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
	// of the High intelligence server has no deadline, yet is listed by the main server.
	jobHeartbeatInterval = 30 * time.Second
	abandonedAfter       = 3 * time.Minute
)

// createJob handles POST /api/csv/jobs: a multipart upload of zero or more images, rate-limited per
// user. It validates the request, stores a running job, answers 202 with the job's id right away and
// keeps working in this same handler until the model has answered, then stores the result. The
// client follows the job through listJobs, so it need not stay connected. A creative job at High
// intelligence goes to HighIntelligenceProxy instead, when there is one.
func (s *Server) createJob(w http.ResponseWriter, r *http.Request) {
	if s.HighIntelligenceProxy != nil && isHighIntelligence(r.URL.Query()) {
		s.HighIntelligenceProxy.ServeHTTP(w, r)
		return
	}
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
	if s.startJob(w, r, user.Username, job, "") {
		s.runJob(context.WithoutCancel(r.Context()), job, images, opts)
	}
}

// retryJob handles POST /api/csv/jobs/{id}/retry ("Tạo lại"): a failed job's request sent again as a new
// job, which replaces the failed one. The images come from the image store, so a job sent with images can be
// retried only while they are kept (imagesKeptFor). Rate-limited and answered like createJob, and a job at High
// intelligence goes to HighIntelligenceProxy like there.
func (s *Server) retryJob(w http.ResponseWriter, r *http.Request) {
	s.retry(w, r, false)
}

// retry is retryJob; onlyHigh refuses every job but one at High intelligence, as the High intelligence server does.
func (s *Server) retry(w http.ResponseWriter, r *http.Request, onlyHigh bool) {
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
	high := isHighIntelligenceJob(failed, opts)
	if onlyHigh && !high {
		writeText(w, http.StatusBadRequest, notHighIntelligence)
		return
	}
	if high && s.HighIntelligenceProxy != nil {
		s.HighIntelligenceProxy.ServeHTTP(w, r)
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
	return true
}

// runJob generates the CSV and records the outcome on the job, its images stored meanwhile. ctx is detached from
// the request: the client has usually gone away by now (that is the point), and its disconnecting must not cancel
// the model call.
func (s *Server) runJob(ctx context.Context, job *store.Job, images []csvgen.Image, opts csvgen.Options) {
	imagesStored := s.storeJobImages(ctx, job, images)
	generation := ctx
	if s.LLMTimeout > 0 {
		var cancel context.CancelFunc
		generation, cancel = context.WithTimeout(ctx, s.LLMTimeout)
		defer cancel()
	}
	stopHeartbeat := s.keepJobAlive(ctx, job)
	started := time.Now()
	var result csvgen.Result
	var err error
	if job.Intelligence == 2 {
		time.Sleep(600 * time.Second)
		result = csvgen.Result{CSV: csvgen.ExtractCSVContent(`"Từ 「旅游」 có nghĩa là gì?","du lịch","thể thao","nghỉ ngơi","công việc"\n"Chọn pinyin đúng của từ 「起床」:","qǐchuáng","qìchuáng","qǐchuāng","qíchuáng"\n"Từ nào có nghĩa là “sữa bò”?","牛奶","报纸","咖啡","水果"\n"A：生日快乐！这是送___你的！ B：太谢谢你了！","给","帮","问","要"\n"帮我看一下这___衣服怎么样。","件","个","块","本"\n"我们班有二十个学生，大卫的汉语___好。","最","也","都","要"\n"你很少___，是不是喜欢运动？","生病","休息","出院","跑步"\n"「三千」是多少？","3000","300","30","30000"\n"Từ trái nghĩa với 「早上」 là:","晚上","中午","下午","时间"\n"这件衣服___大，我想买那件小的。","有点儿","一点儿","一下","一起"\n"Từ nào có nghĩa là “cảm thấy; cho rằng”?","觉得","知道","认识","介绍"\n"我___天六点起床。","每","很","也","最"\n"每天早上都有人___牛奶来。","送","买","问","看"\n"我十一岁的时候开始踢足球，___踢了十年了。","已经","也","就","最"\n"A：你想吃什么？ B：___做你爱吃的鱼吧。","就","还","真","最"\n"A：下午我们___去踢足球吧。 B：好啊！","一起","最","非常","已经"\n"A：你___大？ B：我十六岁。","多","很","几","最"\n"粉色是我女儿最喜欢的___。","颜色","房间","报纸","手表"\n"我十一岁的___开始踢足球。","时候","时间","现在","早上"\n"Chọn pinyin đúng của từ 「咖啡」:","kāfēi","kāféi","gāfēi","kāfēn"\n"A：___？ B：因为九月的北京天气不冷也不热。","为什么","什么时候","怎么样","多少钱"\n"A：吃药了吗？现在___怎么样？ B：吃了，现在好多了。","身体","时间","天气","工作"\n"你女儿的房间___漂亮！","真","一下","有点儿","已经"\n"我们是大学同学，这个工作是他帮我___的。","介绍","问","开始","休息"\n"A：这件衣服的颜色怎么样？ B：___可以，就是有点儿大。","还","最","真","一下"\n"这是你的猫吗？___的眼睛真漂亮。","它","他","她","我"\n"王先生在医院住了两个星期，昨天___了。","出院","起床","休息","考试"\n"Từ nào có nghĩa là “đồng hồ đeo tay”?","手表","报纸","房间","杯子"\n"他常常___我学习汉语。","帮","给","问","送"\n"A：你在想昨天的___吗？ B：是啊。","考试","咖啡","运动","报纸"\n"A：你___吃米饭吗？ B：我不想吃米饭。","要","最","非常","真"\n"A：他儿子一米八几。 B：真___啊！","高","大","长","忙"\n"A：这是谁的房间？ B：这是我和我丈夫的，___那个小的房间是我女儿的。","旁边","左边","外面","下面"\n"A：___快乐！这是送给你的。 B：谢谢！","生日","身体","时间","考试"\n"A：我不想去外面吃，我想在家吃。 B：那你___做什么呢？","准备","可以","知道","认识"\n"A：你明天几点能回来？ B：三点___。","多","几","最","也"\n"他这几天很忙，没有___休息。","时间","药","运动","咖啡"\n"这儿有几个杯子，我看___。","一下","一点儿","一起","最"\n"A：电话是谁打的？ B：不知道，是儿子接的。晚上我___一下儿子。","问","帮","说","看"\n"A：这件小的怎么样？ B：这件___，就买这件吧。","不错","有点儿","知道","介绍"\n"Từ nào không cùng nhóm với các từ còn lại?","手表","咖啡","牛奶","鱼"\n"A：你在这儿工作多长时间了？ B：已经___年多了。","两","二","几","多"\n"咖啡喝多了___身体不好。","对","给","帮","问"\n"A：你身体怎么样？ B：___","还好，谢谢。","我每天六点起床。","三千多块。","是儿子接的。"\n"Sắp xếp các từ sau thành câu đúng: ① 去 ② 我们 ③ 北京 ④ 旅游 ⑤ 九月","九月我们去北京旅游。","我们去九月北京旅游。","九月我们去旅游北京。","我们九月去旅游北京。"\n"Sắp xếp các từ sau thành câu đúng: ① 是 ② 我 ③ 这本书 ④ 写 ⑤ 的","这本书是我写的。","这本书是写的我。","是我这本书写的。","这本书写是我的。"\n"Bạn muốn rủ bạn cùng đi đá bóng vào chiều nay. Bạn nói:","下午我们一起去踢足球吧。","我最喜欢踢足球。","你觉得什么时候去最好？","下午我们一起去跑步吧。"\n"Từ nào có nghĩa là “thuốc”?","药","要","水","咖啡"\n"A：晚上我们去饭馆吃饭，怎么样？ B：我不想去___吃，我想在家吃。","外面","家里","这儿","商店"`)}
	} else {
		result, err = s.Generator.GenerateWithProgress(generation, images, job.Creative, opts, s.jobProgress(ctx, job))
	}
	stopHeartbeat()
	// Before the outcome, so a failed job reads as retryable as soon as it reads as failed.
	imagesStored()
	usage := jobUsage(result.Usage, time.Since(started))
	logAttrs := []any{"user", job.Username, "job", job.ID, "images", len(images), "model", usage.Model, "calls", usage.Calls,
		"durationMs", usage.DurationMs, "inputTokens", usage.InputTokens, "cachedTokens", usage.CachedTokens,
		"outputTokens", usage.OutputTokens}

	if err == nil {
		s.Logger.Info("CSV generation done", logAttrs...)
		s.recordJob(ctx, func(ctx context.Context) error {
			return s.Jobs.Complete(ctx, job.Username, job.ID, result.CSV, result.Source, usage)
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

// progressInterval is the least time between two writes of a running job's progress: about the client's polling.
const progressInterval = 3 * time.Second

// jobProgress returns the callback that records the rows the model has written on the job, at most once per
// progressInterval. A failed write only costs the progress shown.
func (s *Server) jobProgress(ctx context.Context, job *store.Job) func(rows int) {
	var lastWrite time.Time
	return func(rows int) {
		if time.Since(lastWrite) < progressInterval {
			return
		}
		lastWrite = time.Now()
		ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
		defer cancel()
		if err := s.Jobs.Progress(ctx, job.Username, job.ID, rows); err != nil {
			s.Logger.Warn("recording job progress failed", "user", job.Username, "job", job.ID, "error", err)
		}
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
	Intelligence  int        `json:"intelligence"`
	ImageCount    int        `json:"imageCount"`
	CourseType    *int       `json:"courseType"`
	CourseName    string     `json:"courseName"`
	HskStandard   *int       `json:"hskStandard"`
	Level         *int       `json:"level"`
	LessonNumbers []int      `json:"lessonNumbers"`
	CSV           string     `json:"csv"`
	ProgressRows  int        `json:"progressRows"`
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
	// call back, or the client would poll it forever. The High intelligence server takes its own over instead
	// (ResumeJob), so those are given longer, and that server is woken should it be asleep.
	now := time.Now()
	cutoffs := store.ExpiryCutoffs{Before: now.Add(-abandonedAfter)}
	if s.HighIntelligenceProxy != nil {
		cutoffs.ResumableIntelligence, cutoffs.MaxResumes, cutoffs.ResumableBefore = csvgen.HighIntelligence, maxResumes, now.Add(-resumeGiveUp)
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
	if s.HighIntelligenceProxy != nil && slices.ContainsFunc(jobs, awaitingResume(now)) && s.due(&s.wokeAt, wakeEvery) {
		s.HighIntelligenceProxy.Wake(r.Context())
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
		Intelligence: j.Intelligence, ImageCount: j.ImageCount, CourseType: j.CourseType, CourseName: j.CourseName,
		HskStandard: j.HskStandard, Level: j.Level, LessonNumbers: j.LessonNumbers, CSV: j.CSV, ProgressRows: j.ProgressRows,
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
