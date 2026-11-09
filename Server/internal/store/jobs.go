package store

import (
	"context"
	"time"
)

// JobStatus is where an AI generation job stands.
type JobStatus string

const (
	JobRunning JobStatus = "running"
	JobDone    JobStatus = "done"
	JobFailed  JobStatus = "failed"
)

// Job is one AI generation: what was asked and, once finished, the model's answer. Images are not
// kept, only how many there were. The CSV is stored as the model returned it; the client cleans it.
type Job struct {
	ID       string    `bson:"_id"`
	Username string    `bson:"username"`
	Status   JobStatus `bson:"status"`
	// Title names the lesson for the user, e.g. "HSK3-Bai5"; chosen by the client.
	Title    string `bson:"title"`
	Creative bool   `bson:"creative"`
	// Language is the csvgen.Language ordinal the job was asked in, for both modes; absent, Chinese, on the jobs
	// from before English and on every Chinese job.
	Language int `bson:"language,omitempty"`
	// ExportType is the csvgen.ExportType ordinal; only creative jobs have one.
	ExportType   *int `bson:"exportType,omitempty"`
	Intelligence int  `bson:"intelligence"`
	ImageCount   int  `bson:"imageCount"`

	// The lesson a creative job was asked for, kept so the client can filter by it. CourseType is the
	// csvgen.CourseType ordinal and HskStandard the standard itself (2 or 3, HSK only); Level and
	// LessonNumbers are absent when not given. Jobs from before these were stored have none of them.
	CourseType  *int   `bson:"courseType,omitempty"`
	CourseName  string `bson:"courseName,omitempty"`
	HskStandard *int   `bson:"hskStandard,omitempty"`
	Level       *int   `bson:"level,omitempty"`
	// LessonNumbers are the lessons the quiz covers together, ascending.
	LessonNumbers []int `bson:"lessonNumbers,omitempty"`
	// The games a GestureQuiz job was asked for and the questions each gets, kept so the client can submit
	// the same request again. Absent on the other platforms and on jobs from before these were stored.
	GestureStages     []int `bson:"gestureStages,omitempty"`
	QuestionsPerStage *int  `bson:"questionsPerStage,omitempty"`

	// ProgressRows is how many rows of the CSV the model had written when last told, while the job runs; it is
	// left as it was when the job finishes.
	ProgressRows int `bson:"progressRows,omitempty"`
	// CSV is the model's answer; for a Radicals job it is the exercise's JSON (radicals.Exercise).
	CSV string `bson:"csv"`
	// Source is, for a Radicals job, what csvgen builds the exercise from (JSON), kept so the teacher's corrections
	// can rebuild it without the model. Empty on the other platforms. List leaves it out.
	Source string `bson:"source,omitempty"`
	// ErrorStatus is the HTTP status the failure used to be answered with (502, 504), zero otherwise.
	ErrorStatus int `bson:"errorStatus"`
	// ErrorCode says why the job failed (see JobFailure.Code); absent on jobs from before it was stored.
	ErrorCode    string `bson:"errorCode,omitempty"`
	ErrorMessage string `bson:"errorMessage"`
	// Usage is what the generation cost, for the admin; absent on jobs from before it was stored, on jobs
	// that ExpireRunning failed and on jobs the question bank answered without the model.
	Usage *JobUsage `bson:"usage,omitempty"`
	// BankQuestions are the ids of the question bank's questions the quiz is made of, in its order, and FromBank
	// how many of them were in the bank before the job (the rest the model wrote for it). Absent on jobs the bank
	// had no part in.
	BankQuestions []string `bson:"bankQuestions,omitempty"`
	FromBank      int      `bson:"fromBank,omitempty"`

	// RoundStart is the rate-limit round the job was counted in, so an abandoned job can be refunded.
	RoundStart time.Time `bson:"roundStart"`
	CreatedAt  time.Time `bson:"createdAt"`
	// HeartbeatAt is when the process working on a running job last said it still is; nil until it first does.
	HeartbeatAt *time.Time `bson:"heartbeatAt,omitempty"`
	FinishedAt  *time.Time `bson:"finishedAt,omitempty"`

	// Images are where the job's images are kept (the image store), in the order they were sent, so the job can
	// be sent to the model again; ImagesStoredAt is when they were stored. A retry's job takes them over. Absent
	// on jobs without images, until they are stored, when storing them failed, and on jobs from before.
	Images         []JobImage `bson:"images,omitempty"`
	ImagesStoredAt *time.Time `bson:"imagesStoredAt,omitempty"`
	// Resumes is how many times a server took the running job over after the process working on it died.
	Resumes int `bson:"resumes,omitempty"`
}

// JobImage is one kept image of a job: its URL, its ID in the image store and its media type.
type JobImage struct {
	URL         string `bson:"url"`
	PublicID    string `bson:"publicId"`
	ContentType string `bson:"contentType"`
}

// ExpiryCutoffs say when ExpireRunning takes a running job for abandoned: when its last sign of life (the
// heartbeat, or before the first one its creation) is before Before. A creative job at ResumableIntelligence
// (zero: none) that has been resumed fewer than MaxResumes times waits until ResumableBefore instead, since a
// server may still take it over (ClaimInterrupted).
type ExpiryCutoffs struct {
	Before                time.Time
	ResumableIntelligence int
	MaxResumes            int
	ResumableBefore       time.Time
}

// resumable says whether job is one that cutoffs give the longer wait.
func (c ExpiryCutoffs) resumable(job Job) bool {
	return c.ResumableIntelligence != 0 && job.Creative && job.Intelligence == c.ResumableIntelligence && job.Resumes < c.MaxResumes
}

// JobFailure is how a job failed. Code is the stable reason the client words the failure by: one of csvgen's
// Failure* codes, "nothing_to_play", or ExpiredJobCode ("timeout" on jobs from when a generation had a deadline).
type JobFailure struct {
	Status  int
	Code    string
	Message string
}

// JobResult is what a finished job stores: the answer (see Job.CSV), the source of a Radicals one, the cost, and the
// question bank's part in it. A nil Usage means no model was called.
type JobResult struct {
	CSV           string
	Source        string
	Usage         *JobUsage
	BankQuestions []string
	FromBank      int
}

// JobUsage is the model a generation asked and, over all its attempts, the calls made and the tokens billed.
type JobUsage struct {
	Model        string `bson:"model"`
	Calls        int    `bson:"calls"`
	InputTokens  int    `bson:"inputTokens"`
	CachedTokens int    `bson:"cachedTokens"`
	OutputTokens int    `bson:"outputTokens"`
	DurationMs   int64  `bson:"durationMs"`
}

// Jobs is implemented by MongoJobs (production) and MemoryJobs (tests). Every method but ClaimInterrupted is
// scoped to one user, so a user can never read or change another's jobs.
type Jobs interface {
	Create(ctx context.Context, job *Job) error
	// Complete stores the result of a running job. Finished jobs are left alone.
	Complete(ctx context.Context, username, id string, result JobResult) error
	// Revise replaces the answer and the source of a done job; ErrNotFound when the user has no done job by that id.
	Revise(ctx context.Context, username, id, csv, source string) error
	// Progress records how many rows a running job has written so far. Finished jobs are left alone.
	Progress(ctx context.Context, username, id string, rows int) error
	// Heartbeat records that a running job is still being worked on. Finished jobs are left alone.
	Heartbeat(ctx context.Context, username, id string) error
	// Fail marks a running job as failed. Finished jobs are left alone.
	Fail(ctx context.Context, username, id string, failure JobFailure, usage JobUsage) error
	// Get returns one job; ErrNotFound when the user has no such job, which includes another user's.
	Get(ctx context.Context, username, id string) (*Job, error)
	// List returns the user's newest jobs first, at most limit of them, without their Source.
	List(ctx context.Context, username string, limit int) ([]Job, error)
	// Delete removes one job; ErrNotFound when the user has no such job.
	Delete(ctx context.Context, username, id string) error
	// SetImages records where a job's images are kept, whatever its status; a missing job is no error.
	SetImages(ctx context.Context, username, id string, images []JobImage, storedAt time.Time) error
	// ExpireRunning fails, with ExpiredJobStatus, the user's running jobs that cutoffs take for abandoned,
	// which only happens when the process handling them died, and returns the ones it failed.
	ExpireRunning(ctx context.Context, username string, cutoffs ExpiryCutoffs, message string) ([]Job, error)
	// ClaimInterrupted takes over one running creative job at the given intelligence, of any user, whose last
	// sign of life is before the cutoff and that was taken over fewer than maxResumes times: it records a
	// heartbeat now, counts the resume and clears the progress, and returns the job as it now is; nil when
	// there is none. Two servers claiming at once never get the same job.
	ClaimInterrupted(ctx context.Context, intelligence int, before time.Time, maxResumes int) (*Job, error)
	// Prune deletes all but the user's newest keep jobs.
	Prune(ctx context.Context, username string, keep int) error
}

// ExpiredJobStatus and ExpiredJobCode are the error status and code of a job ExpireRunning failed: a gateway
// timeout, interrupted since the process working on it died.
const (
	ExpiredJobStatus = 504
	ExpiredJobCode   = "interrupted"
)
