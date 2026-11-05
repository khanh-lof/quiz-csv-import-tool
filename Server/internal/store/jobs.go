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
	// Usage is what the generation cost, for the admin; absent on jobs from before it was stored and on jobs
	// that ExpireRunning failed.
	Usage *JobUsage `bson:"usage,omitempty"`

	// RoundStart is the rate-limit round the job was counted in, so an abandoned job can be refunded.
	RoundStart time.Time `bson:"roundStart"`
	CreatedAt  time.Time `bson:"createdAt"`
	// HeartbeatAt is when the process working on a running job last said it still is; nil until it first does.
	HeartbeatAt *time.Time `bson:"heartbeatAt,omitempty"`
	FinishedAt  *time.Time `bson:"finishedAt,omitempty"`
}

// JobFailure is how a job failed. Code is the stable reason the client words the failure by: one of csvgen's
// Failure* codes, "nothing_to_play", or ExpiredJobCode ("timeout" on jobs from when a generation had a deadline).
type JobFailure struct {
	Status  int
	Code    string
	Message string
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

// Jobs is implemented by MongoJobs (production) and MemoryJobs (tests). Every method is scoped to
// one user, so a user can never read or change another's jobs.
type Jobs interface {
	Create(ctx context.Context, job *Job) error
	// Complete stores the answer of a running job, and the source of a Radicals one. Finished jobs are left alone.
	Complete(ctx context.Context, username, id, csv, source string, usage JobUsage) error
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
	// ExpireRunning fails, with ExpiredJobStatus, the user's running jobs whose last heartbeat (or, before
	// the first one, their creation) is before the cutoff, which only happens when the process handling
	// them died, and returns the ones it failed.
	ExpireRunning(ctx context.Context, username string, before time.Time, message string) ([]Job, error)
	// Prune deletes all but the user's newest keep jobs.
	Prune(ctx context.Context, username string, keep int) error
}

// ExpiredJobStatus and ExpiredJobCode are the error status and code of a job ExpireRunning failed: a gateway
// timeout, interrupted since the process working on it died.
const (
	ExpiredJobStatus = 504
	ExpiredJobCode   = "interrupted"
)
