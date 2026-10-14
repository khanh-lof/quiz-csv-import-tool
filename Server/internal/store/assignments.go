package store

import (
	"context"
	"maps"
	"slices"
	"time"
)

// ResultGrace is how long after an assignment closes a finished stage run is still accepted, so a
// student in the middle of a stage at the deadline does not lose it. Opening and joining get no grace.
const ResultGrace = 5 * time.Minute

// maxRunIDs is how many of a player's latest run ids are remembered to recognise a resent result.
const maxRunIDs = 50

// Assignment is a Quiz cử chỉ job handed to students: a snapshot of the job's title and CSV, so
// deleting or pruning the job never breaks a live link, plus how it is played and when it closes.
type Assignment struct {
	ID string `bson:"_id"`
	// Code is the public, unguessable part of the students' link. Callers match it as stored (the
	// handlers upper-case what a student typed).
	Code     string `bson:"code"`
	Username string `bson:"username"`
	JobID    string `bson:"jobId"`
	Title    string `bson:"title"`
	// Label names the class or group the teacher assigned it to; optional.
	Label string `bson:"label"`
	// CSV is the job's raw model answer, the way the client's own parser reads it. List leaves it empty.
	CSV string `bson:"csv"`
	// TimeMode is how long a student gets per question: "standard", "extra" or "unlimited".
	TimeMode string `bson:"timeMode"`
	// StageCounts is the number of questions in each stage ("1" to "6"), which is what a result is
	// checked against; stages without questions are absent.
	StageCounts map[string]int `bson:"stageCounts"`
	CreatedAt   time.Time      `bson:"createdAt"`
	// ClosesAt is the teacher's scheduled closing time and ClosedAt the moment they closed it by hand;
	// the assignment closes at the earlier of the two. Clearing ClosedAt reopens it.
	ClosesAt *time.Time `bson:"closesAt,omitempty"`
	ClosedAt *time.Time `bson:"closedAt,omitempty"`
}

// EffectiveClose is when the assignment closed or will close: the earlier of ClosedAt and ClosesAt.
// It reports false when neither is set.
func (a *Assignment) EffectiveClose() (time.Time, bool) {
	switch {
	case a.ClosedAt != nil && a.ClosesAt != nil:
		return minTime(*a.ClosedAt, *a.ClosesAt), true
	case a.ClosedAt != nil:
		return *a.ClosedAt, true
	case a.ClosesAt != nil:
		return *a.ClosesAt, true
	}
	return time.Time{}, false
}

// OpenAt reports whether students can open and join the assignment at now.
func (a *Assignment) OpenAt(now time.Time) bool {
	return a.ClosedAt == nil && (a.ClosesAt == nil || now.Before(*a.ClosesAt))
}

// AcceptsResultsAt reports whether a finished stage run reaching the server at now is still taken:
// while the assignment is open, and for ResultGrace after it closed.
func (a *Assignment) AcceptsResultsAt(now time.Time) bool {
	if a.OpenAt(now) {
		return true
	}
	closed, ok := a.EffectiveClose()
	return ok && !now.After(closed.Add(ResultGrace))
}

func minTime(a, b time.Time) time.Time {
	if b.Before(a) {
		return b
	}
	return a
}

// StageResult is a player's best run of one stage, and how many times they finished it.
type StageResult struct {
	Correct  int  `bson:"correct"`
	Total    int  `bson:"total"`
	Attempts int  `bson:"attempts"`
	Passed   bool `bson:"passed"`
	// BestAt is when the best score was reached, or the pass made: the ranking breaks ties by it.
	BestAt time.Time `bson:"bestAt"`
}

// Player is one student of one assignment. The browser keeps the token; only its hash is stored, as
// with refresh tokens, so reading the database does not let anyone play as somebody else.
type Player struct {
	ID           string `bson:"_id"`
	AssignmentID string `bson:"assignmentId"`
	Name         string `bson:"name"`
	// NameKey is the lower-cased name, unique within the assignment, so "Lan" and "lan" cannot both join.
	NameKey      string     `bson:"nameKey"`
	TokenHash    string     `bson:"tokenHash"`
	JoinedAt     time.Time  `bson:"joinedAt"`
	LastPlayedAt *time.Time `bson:"lastPlayedAt,omitempty"`
	// Stages holds the best result per stage, keyed like Assignment.StageCounts.
	Stages map[string]StageResult `bson:"stages"`
	// RunIDs are the player's last maxRunIDs reported runs, so a result the browser resends after a
	// lost answer is counted once.
	RunIDs []string `bson:"runIds"`
	// Version guards RecordResult's read-modify-write (optimistic concurrency).
	Version int `bson:"version"`
}

// TimeChange says what to do with one time of an assignment in an update.
type TimeChange struct {
	// Set false leaves the time as it is; true replaces it with Value, or clears it when Value is nil.
	Set   bool
	Value *time.Time
}

// AssignmentUpdate lists what Assignments.Update changes; everything left at its zero value stays.
type AssignmentUpdate struct {
	Label    *string
	ClosesAt TimeChange
	ClosedAt TimeChange
}

func (u AssignmentUpdate) isEmpty() bool {
	return u.Label == nil && !u.ClosesAt.Set && !u.ClosedAt.Set
}

// Assignments is implemented by MongoAssignments (production) and MemoryAssignments (tests). The
// teacher-side methods take the owner's username, so a user can never read or change another's
// assignments; the student-side ones (GetByCode and the player methods) work from the public code or
// the player's own token, and the handlers decide what a student may see.
type Assignments interface {
	// Create stores a new assignment; ErrDuplicate when its id or code is already used.
	Create(ctx context.Context, a *Assignment) error
	// Get returns the user's assignment with its CSV; ErrNotFound when they have no such one.
	Get(ctx context.Context, username, id string) (*Assignment, error)
	// GetByCode returns an assignment by the code in its link, whoever owns it; ErrNotFound if none.
	GetByCode(ctx context.Context, code string) (*Assignment, error)
	// List returns the user's newest assignments first, at most limit of them and without their CSV.
	List(ctx context.Context, username string, limit int) ([]Assignment, error)
	// Count returns how many assignments the user has.
	Count(ctx context.Context, username string) (int, error)
	// Update changes the label and the two times, and returns the assignment as it is afterwards
	// (unchanged when u changes nothing); ErrNotFound when the user has no such assignment.
	Update(ctx context.Context, username, id string, u AssignmentUpdate) (*Assignment, error)
	// Delete removes the user's assignment together with its players; ErrNotFound when they have none.
	Delete(ctx context.Context, username, id string) error

	// CreatePlayer adds a player; ErrDuplicate when the name key is taken in that assignment (or the
	// id is).
	CreatePlayer(ctx context.Context, p *Player) error
	// CountPlayers returns the number of players of each of the assignments, 0 for those without any.
	CountPlayers(ctx context.Context, assignmentIDs []string) (map[string]int, error)
	// ListPlayers returns the assignment's players in the order they joined.
	ListPlayers(ctx context.Context, assignmentID string) ([]Player, error)
	// PlayerByToken finds the player of the assignment holding the token with this hash; ErrNotFound if none.
	PlayerByToken(ctx context.Context, assignmentID, tokenHash string) (*Player, error)
	// RecordResult merges one finished stage run into the player's results: the best run per stage
	// stays, a pass stays, attempts are counted. A run id the player already reported is ignored
	// (nil, nothing changes), so resending is safe. It re-reads and retries when another run of the
	// same player was written first, like Users.UpdateSessions, and fails with ErrConflict if that
	// keeps happening; ErrNotFound when the player is not in that assignment.
	RecordResult(ctx context.Context, assignmentID, playerID, runID, stage string, correct, total int, passed bool, now time.Time) error
	// DeletePlayer removes one player; ErrNotFound when the assignment has no such player.
	DeletePlayer(ctx context.Context, assignmentID, playerID string) error
}

// mergeResult folds one reported run into the player's results and reports whether it changed
// anything: false means the run id was already recorded. Both implementations use it, so the rules
// cannot drift apart. A worse run never lowers the best and a pass is never taken back; BestAt moves
// only when the best score improves or the pass is made, which is what the ranking's tie-break needs.
func mergeResult(p *Player, runID, stage string, correct, total int, passed bool, now time.Time) bool {
	if slices.Contains(p.RunIDs, runID) {
		return false
	}
	now = storedTime(now)

	r, played := p.Stages[stage]
	r.Attempts++
	r.Total = total
	if !played || correct > r.Correct {
		r.Correct = correct
		r.BestAt = now
	}
	if passed && !r.Passed {
		r.Passed = true
		r.BestAt = now
	}
	if p.Stages == nil {
		p.Stages = map[string]StageResult{}
	}
	p.Stages[stage] = r

	p.LastPlayedAt = &now
	p.RunIDs = append(p.RunIDs, runID)
	if extra := len(p.RunIDs) - maxRunIDs; extra > 0 {
		p.RunIDs = slices.Delete(p.RunIDs, 0, extra)
	}
	return true
}

// storedTime is a time the way it comes back from MongoDB, which keeps UTC milliseconds. Both
// implementations store times through it, so a value reads back identical from either.
func storedTime(t time.Time) time.Time {
	return t.UTC().Truncate(time.Millisecond)
}

func storedTimePtr(t *time.Time) *time.Time {
	if t == nil {
		return nil
	}
	v := storedTime(*t)
	return &v
}

// stored returns a deep copy of the assignment in the form the stores keep it: times in
// milliseconds, a non-nil StageCounts. It copies the map and the time pointers, so the copy shares
// nothing with the original, and doing it again changes nothing, which is why MemoryAssignments also
// uses it for every copy it hands out.
func (a Assignment) stored() Assignment {
	counts := map[string]int{}
	maps.Copy(counts, a.StageCounts)
	a.StageCounts = counts
	a.CreatedAt = storedTime(a.CreatedAt)
	a.ClosesAt = storedTimePtr(a.ClosesAt)
	a.ClosedAt = storedTimePtr(a.ClosedAt)
	return a
}

// stored is Assignment.stored for a player: a deep copy with times in milliseconds and non-nil
// Stages and RunIDs, so empty values are written as {} and [] rather than null.
func (p Player) stored() Player {
	stages := make(map[string]StageResult, len(p.Stages))
	for k, r := range p.Stages {
		r.BestAt = storedTime(r.BestAt)
		stages[k] = r
	}
	p.Stages = stages
	p.RunIDs = append([]string{}, p.RunIDs...)
	p.JoinedAt = storedTime(p.JoinedAt)
	p.LastPlayedAt = storedTimePtr(p.LastPlayedAt)
	return p
}
