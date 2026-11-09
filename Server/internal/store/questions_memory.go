package store

import (
	"context"
	"slices"
	"sort"
	"sync"
	"time"
)

// MemoryQuestionBank is an in-process QuestionBank for tests.
type MemoryQuestionBank struct {
	mu        sync.Mutex
	questions map[string]Question
}

func NewMemoryQuestionBank() *MemoryQuestionBank {
	return &MemoryQuestionBank{questions: map[string]Question{}}
}

func (m *MemoryQuestionBank) Pool(_ context.Context, language int, book string, maxLesson int) ([]Question, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	pool := []Question{}
	for _, q := range m.questions {
		if q.Language == language && q.Book == book && q.MaxLesson <= maxLesson && q.Status == QuestionActive {
			pool = append(pool, cloneQuestion(q))
		}
	}
	// A map has no order; the store's callers must not depend on one, but tests read better with one.
	sort.Slice(pool, func(i, j int) bool { return pool[i].ID < pool[j].ID })
	return pool, nil
}

func (m *MemoryQuestionBank) Insert(_ context.Context, questions []Question) ([]string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	held := map[string]bool{}
	for _, q := range m.questions {
		held[q.Book+"\x00"+q.Fingerprint] = true
	}
	var ids []string
	for _, q := range questions {
		key := q.Book + "\x00" + q.Fingerprint
		if _, taken := m.questions[q.ID]; taken || held[key] {
			continue
		}
		held[key] = true
		q.CreatedAt = storedTime(q.CreatedAt)
		m.questions[q.ID] = cloneQuestion(q)
		ids = append(ids, q.ID)
	}
	return ids, nil
}

func (m *MemoryQuestionBank) MarkServed(_ context.Context, ids []string, at time.Time) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	at = storedTime(at)
	for _, id := range ids {
		if q, ok := m.questions[id]; ok {
			q.ServedCount++
			q.LastServedAt = &at
			m.questions[id] = q
		}
	}
	return nil
}

// Get returns a stored question, for tests; false when there is none.
func (m *MemoryQuestionBank) Get(id string) (Question, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	q, ok := m.questions[id]
	return cloneQuestion(q), ok
}

// Len is how many questions are stored, for tests.
func (m *MemoryQuestionBank) Len() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.questions)
}

func cloneQuestion(q Question) Question {
	q.Lessons = slices.Clone(q.Lessons)
	q.Targets = slices.Clone(q.Targets)
	q.Distractors = slices.Clone(q.Distractors)
	q.Chunks = slices.Clone(q.Chunks)
	if q.LastServedAt != nil {
		at := *q.LastServedAt
		q.LastServedAt = &at
	}
	return q
}
