package store

import (
	"cmp"
	"context"
	"slices"
	"strings"
	"sync"
	"time"
)

// MemoryAssignments is an in-process Assignments implementation for tests. Like the other stores it
// keeps its own copies of everything: what it stores and what it returns never alias the caller's
// maps, slices or time pointers.
type MemoryAssignments struct {
	mu          sync.Mutex
	assignments map[string]Assignment
	players     map[string]Player
	// Now is kept for parity with the other in-memory stores; no method reads the clock, because
	// RecordResult takes its time from the caller.
	Now func() time.Time
}

func NewMemoryAssignments() *MemoryAssignments {
	return &MemoryAssignments{assignments: map[string]Assignment{}, players: map[string]Player{}, Now: time.Now}
}

func (m *MemoryAssignments) Create(_ context.Context, a *Assignment) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.assignments[a.ID]; ok {
		return ErrDuplicate
	}
	for _, other := range m.assignments {
		if other.Code == a.Code {
			return ErrDuplicate
		}
	}
	m.assignments[a.ID] = a.stored()
	return nil
}

func (m *MemoryAssignments) Get(_ context.Context, username, id string) (*Assignment, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.owned(username, id)
}

// owned returns a copy of the user's assignment; the caller holds the lock.
func (m *MemoryAssignments) owned(username, id string) (*Assignment, error) {
	a, ok := m.assignments[id]
	if !ok || a.Username != username {
		return nil, ErrNotFound
	}
	out := a.stored()
	return &out, nil
}

func (m *MemoryAssignments) GetByCode(_ context.Context, code string) (*Assignment, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, a := range m.assignments {
		if a.Code == code {
			out := a.stored()
			return &out, nil
		}
	}
	return nil, ErrNotFound
}

func (m *MemoryAssignments) List(_ context.Context, username string, limit int) ([]Assignment, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := []Assignment{}
	for _, a := range m.assignments {
		if a.Username == username {
			a = a.stored()
			a.CSV = ""
			out = append(out, a)
		}
	}
	// Equal creation times are ordered by id only so the result does not depend on map order.
	slices.SortFunc(out, func(a, b Assignment) int {
		return cmp.Or(b.CreatedAt.Compare(a.CreatedAt), strings.Compare(b.ID, a.ID))
	})
	return out[:max(0, min(limit, len(out)))], nil
}

func (m *MemoryAssignments) Count(_ context.Context, username string) (int, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	n := 0
	for _, a := range m.assignments {
		if a.Username == username {
			n++
		}
	}
	return n, nil
}

func (m *MemoryAssignments) Update(_ context.Context, username, id string, u AssignmentUpdate) (*Assignment, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	a, err := m.owned(username, id)
	if err != nil || u.isEmpty() {
		return a, err
	}
	if u.Label != nil {
		a.Label = *u.Label
	}
	if u.ClosesAt.Set {
		a.ClosesAt = u.ClosesAt.Value
	}
	if u.ClosedAt.Set {
		a.ClosedAt = u.ClosedAt.Value
	}
	m.assignments[id] = a.stored()
	out := m.assignments[id].stored()
	return &out, nil
}

func (m *MemoryAssignments) Delete(_ context.Context, username, id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if a, ok := m.assignments[id]; !ok || a.Username != username {
		return ErrNotFound
	}
	delete(m.assignments, id)
	for pid, p := range m.players {
		if p.AssignmentID == id {
			delete(m.players, pid)
		}
	}
	return nil
}

func (m *MemoryAssignments) CreatePlayer(_ context.Context, p *Player) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.players[p.ID]; ok {
		return ErrDuplicate
	}
	for _, other := range m.players {
		if other.AssignmentID == p.AssignmentID && other.NameKey == p.NameKey {
			return ErrDuplicate
		}
	}
	m.players[p.ID] = p.stored()
	return nil
}

func (m *MemoryAssignments) CountPlayers(_ context.Context, assignmentIDs []string) (map[string]int, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	counts := make(map[string]int, len(assignmentIDs))
	for _, id := range assignmentIDs {
		counts[id] = 0
	}
	for _, p := range m.players {
		if _, asked := counts[p.AssignmentID]; asked {
			counts[p.AssignmentID]++
		}
	}
	return counts, nil
}

func (m *MemoryAssignments) ListPlayers(_ context.Context, assignmentID string) ([]Player, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := []Player{}
	for _, p := range m.players {
		if p.AssignmentID == assignmentID {
			out = append(out, p.stored())
		}
	}
	slices.SortFunc(out, func(a, b Player) int {
		return cmp.Or(a.JoinedAt.Compare(b.JoinedAt), strings.Compare(a.ID, b.ID))
	})
	return out, nil
}

func (m *MemoryAssignments) PlayerByToken(_ context.Context, assignmentID, tokenHash string) (*Player, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, p := range m.players {
		if p.AssignmentID == assignmentID && p.TokenHash == tokenHash {
			out := p.stored()
			return &out, nil
		}
	}
	return nil, ErrNotFound
}

func (m *MemoryAssignments) RecordResult(_ context.Context, assignmentID, playerID, runID, stage string, correct, total int, passed bool, now time.Time) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	stored, ok := m.players[playerID]
	if !ok || stored.AssignmentID != assignmentID {
		return ErrNotFound
	}
	p := stored.stored()
	if !mergeResult(&p, runID, stage, correct, total, passed, now) {
		return nil
	}
	p.Version++
	m.players[playerID] = p
	return nil
}

func (m *MemoryAssignments) DeletePlayer(_ context.Context, assignmentID, playerID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if p, ok := m.players[playerID]; !ok || p.AssignmentID != assignmentID {
		return ErrNotFound
	}
	delete(m.players, playerID)
	return nil
}
