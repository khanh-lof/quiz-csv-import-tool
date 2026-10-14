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

func (m *MemoryJobs) Complete(_ context.Context, username, id, csv string) error {
	return m.finish(username, id, func(j *Job) {
		j.Status, j.CSV = JobDone, csv
	})
}

func (m *MemoryJobs) Fail(_ context.Context, username, id string, errorStatus int, message string) error {
	return m.finish(username, id, func(j *Job) {
		j.Status, j.ErrorStatus, j.ErrorMessage = JobFailed, errorStatus, message
	})
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
	return jobs[:min(limit, len(jobs))], nil
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

func (m *MemoryJobs) ExpireRunning(_ context.Context, username string, before time.Time, message string) ([]Job, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var expired []Job
	now := m.Now().UTC()
	for id, j := range m.jobs {
		if j.Username == username && j.Status == JobRunning && j.CreatedAt.Before(before) {
			j.Status, j.ErrorStatus, j.ErrorMessage, j.FinishedAt = JobFailed, 504, message, &now
			m.jobs[id] = j
			expired = append(expired, j)
		}
	}
	return expired, nil
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
