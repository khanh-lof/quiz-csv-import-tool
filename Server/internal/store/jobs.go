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
	// ExportType is the csvgen.ExportType ordinal; only creative jobs have one.
	ExportType   *int `bson:"exportType,omitempty"`
	Intelligence int  `bson:"intelligence"`
	ImageCount   int  `bson:"imageCount"`

	// The lesson a creative job was asked for, kept so the client can filter by it. CourseType is the
	// csvgen.CourseType ordinal and HskStandard the standard itself (2 or 3, HSK only); Level and
	// LessonNumber are absent when not given. Jobs from before these were stored have none of them.
	CourseType   *int   `bson:"courseType,omitempty"`
	CourseName   string `bson:"courseName,omitempty"`
	HskStandard  *int   `bson:"hskStandard,omitempty"`
	Level        *int   `bson:"level,omitempty"`
	LessonNumber *int   `bson:"lessonNumber,omitempty"`

	CSV string `bson:"csv"`
	// ErrorStatus is the HTTP status the failure used to be answered with (502, 504), zero otherwise.
	ErrorStatus  int    `bson:"errorStatus"`
	ErrorMessage string `bson:"errorMessage"`

	// RoundStart is the rate-limit round the job was counted in, so an abandoned job can be refunded.
	RoundStart time.Time  `bson:"roundStart"`
	CreatedAt  time.Time  `bson:"createdAt"`
	FinishedAt *time.Time `bson:"finishedAt,omitempty"`
}

// Jobs is implemented by MongoJobs (production) and MemoryJobs (tests). Every method is scoped to
// one user, so a user can never read or change another's jobs.
type Jobs interface {
	Create(ctx context.Context, job *Job) error
	// Complete stores the answer of a running job. Finished jobs are left alone.
	Complete(ctx context.Context, username, id, csv string) error
	// Fail marks a running job as failed. Finished jobs are left alone.
	Fail(ctx context.Context, username, id string, errorStatus int, message string) error
	// List returns the user's newest jobs first, at most limit of them.
	List(ctx context.Context, username string, limit int) ([]Job, error)
	// Delete removes one job; ErrNotFound when the user has no such job.
	Delete(ctx context.Context, username, id string) error
	// ExpireRunning fails the user's jobs that have been running since before the cutoff, which only
	// happens when the process handling them died, and returns the ones it failed.
	ExpireRunning(ctx context.Context, username string, before time.Time, message string) ([]Job, error)
	// Prune deletes all but the user's newest keep jobs.
	Prune(ctx context.Context, username string, keep int) error
}
