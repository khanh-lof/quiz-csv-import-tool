package store

import (
	"context"
	"slices"
	"sync"
	"time"
)

// MemoryJobs is an in-process Jobs implementation for tests.
type MemoryJobs struct {
	mu   sync.Mutex
	jobs map[string]Job
	Now  func() time.Time
}

func NewMemoryJobs() *MemoryJobs {
	return &MemoryJobs{jobs: map[string]Job{}, Now: time.Now}
}

func (m *MemoryJobs) Create(_ context.Context, job *Job) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.jobs[job.ID]; ok {
		return ErrDuplicate
	}
	m.jobs[job.ID] = *job
	return nil
}

func (m *MemoryJobs) Complete(_ context.Context, username, id string, result JobResult) error {
	return m.finish(username, id, func(j *Job) {
		j.Status, j.CSV, j.Source = JobDone, result.CSV, result.Source
		if result.Usage != nil {
			usage := *result.Usage
			j.Usage = &usage
		}
		if len(result.BankQuestions) > 0 {
			j.BankQuestions, j.FromBank = slices.Clone(result.BankQuestions), result.FromBank
		}
	})
}

func (m *MemoryJobs) Revise(_ context.Context, username, id, csv, source string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	j, ok := m.jobs[id]
	if !ok || j.Username != username || j.Status != JobDone {
		return ErrNotFound
	}
	j.CSV, j.Source = csv, source
	m.jobs[id] = j
	return nil
}

func (m *MemoryJobs) Fail(_ context.Context, username, id string, failure JobFailure, usage JobUsage) error {
	return m.finish(username, id, func(j *Job) {
		j.Status, j.ErrorStatus, j.ErrorCode, j.ErrorMessage, j.Usage = JobFailed, failure.Status, failure.Code, failure.Message, &usage
	})
}

func (m *MemoryJobs) Progress(_ context.Context, username, id string, rows int) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if j, ok := m.jobs[id]; ok && j.Username == username && j.Status == JobRunning {
		j.ProgressRows = rows
		m.jobs[id] = j
	}
	return nil
}

func (m *MemoryJobs) Heartbeat(_ context.Context, username, id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if j, ok := m.jobs[id]; ok && j.Username == username && j.Status == JobRunning {
		now := m.Now().UTC()
		j.HeartbeatAt = &now
		m.jobs[id] = j
	}
	return nil
}

func (m *MemoryJobs) finish(username, id string, apply func(*Job)) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	j, ok := m.jobs[id]
	if !ok || j.Username != username || j.Status != JobRunning {
		return nil
	}
	apply(&j)
	now := m.Now().UTC()
	j.FinishedAt = &now
	m.jobs[id] = j
	return nil
}

func (m *MemoryJobs) Get(_ context.Context, username, id string) (*Job, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	j, ok := m.jobs[id]
	if !ok || j.Username != username {
		return nil, ErrNotFound
	}
	return &j, nil
}

func (m *MemoryJobs) List(_ context.Context, username string, limit int) ([]Job, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	jobs := m.newestFirst(username)
	jobs = jobs[:max(min(limit, len(jobs)), 0)]
	for i := range jobs {
		jobs[i].Source = ""
	}
	return jobs, nil
}

func (m *MemoryJobs) newestFirst(username string) []Job {
	out := []Job{}
	for _, j := range m.jobs {
		if j.Username == username {
			out = append(out, j)
		}
	}
	slices.SortFunc(out, func(a, b Job) int { return b.CreatedAt.Compare(a.CreatedAt) })
	return out
}

func (m *MemoryJobs) Delete(_ context.Context, username, id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if j, ok := m.jobs[id]; !ok || j.Username != username {
		return ErrNotFound
	}
	delete(m.jobs, id)
	return nil
}

func (m *MemoryJobs) SetImages(_ context.Context, username, id string, images []JobImage, storedAt time.Time) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if j, ok := m.jobs[id]; ok && j.Username == username {
		storedAt = storedAt.UTC().Truncate(time.Millisecond)
		j.Images, j.ImagesStoredAt = images, &storedAt
		m.jobs[id] = j
	}
	return nil
}

func (m *MemoryJobs) ExpireRunning(_ context.Context, username string, cutoffs ExpiryCutoffs, message string) ([]Job, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var expired []Job
	now := m.Now().UTC()
	for id, j := range m.jobs {
		before := cutoffs.Before
		if cutoffs.resumable(j) {
			before = cutoffs.ResumableBefore
		}
		if j.Username == username && j.Status == JobRunning && lastSign(j).Before(before) {
			j.Status, j.ErrorStatus, j.ErrorCode, j.ErrorMessage, j.FinishedAt = JobFailed, ExpiredJobStatus, ExpiredJobCode, message, &now
			m.jobs[id] = j
			expired = append(expired, j)
		}
	}
	return expired, nil
}

func (m *MemoryJobs) ClaimInterrupted(_ context.Context, before time.Time, maxResumes int) (*Job, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for id, j := range m.jobs {
		if j.Status == JobRunning && j.Creative && j.Resumes < maxResumes && lastSign(j).Before(before) {
			now := m.Now().UTC()
			j.HeartbeatAt, j.Resumes, j.ProgressRows = &now, j.Resumes+1, 0
			m.jobs[id] = j
			return &j, nil
		}
	}
	return nil, nil
}

func (m *MemoryJobs) Prune(_ context.Context, username string, keep int) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	jobs := m.newestFirst(username)
	if len(jobs) > keep {
		for _, j := range jobs[keep:] {
			if j.Status != JobRunning {
				delete(m.jobs, j.ID)
			}
		}
	}
	return nil
}

// lastSign is when a running job last showed that its process was alive.
func lastSign(j Job) time.Time {
	if j.HeartbeatAt != nil {
		return *j.HeartbeatAt
	}
	return j.CreatedAt
}
