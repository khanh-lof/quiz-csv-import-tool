package store

import (
	"context"
	"sync"
)

// MemoryRadicalDetails is an in-process RadicalDetails for tests.
type MemoryRadicalDetails struct {
	mu      sync.Mutex
	details map[string]RadicalDetail
}

func NewMemoryRadicalDetails() *MemoryRadicalDetails {
	return &MemoryRadicalDetails{details: map[string]RadicalDetail{}}
}

func (m *MemoryRadicalDetails) Lookup(_ context.Context, ids []string) (map[string]RadicalDetail, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	found := map[string]RadicalDetail{}
	for _, id := range ids {
		if d, ok := m.details[id]; ok && d.Status == RadicalActive {
			d.Uses++
			m.details[id] = d
			found[id] = d
		}
	}
	return found, nil
}

func (m *MemoryRadicalDetails) Save(_ context.Context, details []RadicalDetail) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, d := range details {
		if _, ok := m.details[d.ID]; !ok {
			d.CreatedAt = storedTime(d.CreatedAt)
			m.details[d.ID] = d
		}
	}
	return nil
}

// Len is how many details are stored, for tests.
func (m *MemoryRadicalDetails) Len() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.details)
}
