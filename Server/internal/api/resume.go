package api

import (
	"context"
	"time"

	"quiz-csv-import-tool/server/internal/csvgen"
	"quiz-csv-import-tool/server/internal/store"
)

// A High intelligence job runs on a host that may stop it at any time (Render restarts a free instance at will,
// and a deploy cuts off what still runs 30 s in). The High intelligence server checks for such jobs every minute
// while it is up (ClaimInterruptedJob) and runs them again (ResumeJob); the main server, meanwhile, gives them
// longer before failing them (resumeGiveUp) and wakes that server when it sees one waiting (listJobs).
const (
	// resumeAfter is how long a High intelligence job goes without a heartbeat before it is taken over: three
	// heartbeats missed, so the process working on it is gone.
	resumeAfter = 3 * jobHeartbeatInterval
	// maxResumes is how many times a job is taken over; one interrupted again after that is failed instead.
	maxResumes = 2
	// resumeGiveUp is how long the main server waits for the High intelligence server to take an interrupted
	// job over before failing it as interrupted: time for that server to wake, or to be deployed again.
	resumeGiveUp = 10 * time.Minute
	// wakeEvery is how often the main server wakes the High intelligence server at most.
	wakeEvery = time.Minute
)

// interruptedMessage is the error message of a job failed because the process working on it died.
const interruptedMessage = "AI generation was interrupted."

// awaitingResume matches a running High intelligence job that the High intelligence server has yet to take over.
func awaitingResume(now time.Time) func(store.Job) bool {
	return func(job store.Job) bool {
		lastSign := job.CreatedAt
		if job.HeartbeatAt != nil {
			lastSign = *job.HeartbeatAt
		}
		return job.Status == store.JobRunning && job.Creative && job.Intelligence == csvgen.HighIntelligence &&
			job.Resumes < maxResumes && lastSign.Before(now.Add(-resumeAfter))
	}
}

// ClaimInterruptedJob takes over one High intelligence job, of any user, whose process died, for ResumeJob to run;
// nil when there is none. The High intelligence server calls it until it returns nil.
func (s *Server) ClaimInterruptedJob(ctx context.Context) (*store.Job, error) {
	return s.Jobs.ClaimInterrupted(ctx, csvgen.HighIntelligence, time.Now().Add(-resumeAfter), maxResumes)
}

// ResumeJob runs a job ClaimInterruptedJob took over from the start, with the options and the kept images it was
// made with, and records the outcome like any job; the AI call it was counted as stays counted. A job that cannot
// be run again (made before its options were kept, or its images not kept) is failed as interrupted and its call
// given back.
func (s *Server) ResumeJob(ctx context.Context, job *store.Job) {
	ctx = context.WithoutCancel(ctx)
	s.Logger.Warn("resuming an interrupted job", "user", job.Username, "job", job.ID, "resume", job.Resumes)
	opts, ok := retryOptions(job)
	var images []csvgen.Image
	if ok && job.ImageCount > 0 {
		_, ok = s.imagesKeptUntil(job)
		if ok {
			var err error
			if images, err = s.ImageStore.Fetch(ctx, job.Images); err != nil {
				s.Logger.Warn("fetching the images of an interrupted job failed", "user", job.Username, "job", job.ID, "error", err)
				ok = false
			}
		}
	}
	if !ok {
		s.recordJob(ctx, func(ctx context.Context) error {
			return s.Jobs.Fail(ctx, job.Username, job.ID,
				store.JobFailure{Status: store.ExpiredJobStatus, Code: store.ExpiredJobCode, Message: interruptedMessage}, store.JobUsage{})
		}, job)
		s.refundAICall(ctx, job.Username, job.RoundStart)
		return
	}
	s.runJob(ctx, job, images, opts)
}
