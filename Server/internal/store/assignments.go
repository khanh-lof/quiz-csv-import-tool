package store

import (
	"context"
	"maps"
	"slices"
	"time"
)

// ResultGrace is how long after an assignment closes the server still takes the rest of a run that was in
// progress, so a student in the middle of a stage at the deadline does not lose it. Opening, joining and
// starting a run get no grace.
const ResultGrace = 5 * time.Minute

// Assignment is a Game job handed to students: a snapshot of the job's title and CSV, so
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
	// CSV is the job's raw model answer, which the server parses to deal the questions of a run. It never
	// reaches a student. List leaves it empty.
	CSV string `bson:"csv"`
	// TimeMode is how long a student gets per question: "standard", "extra" or "unlimited".
	TimeMode string `bson:"timeMode"`
	// StageLock is how a student moves through the stages: "sequential" (each stage opens once the one
	// before it is passed) or "open" (every stage can be played from the start). Assignments made before
	// the setting existed have it empty, which means "sequential"; use the API's stageLockOf to read it.
	StageLock string `bson:"stageLock,omitempty"`
	// StageCounts is the number of questions in each stage ("1" to "6"), as the server counted them in
	// the CSV when the assignment was made; stages without questions are absent.
	StageCounts map[string]int `bson:"stageCounts"`
	// PassPercents is, per stage, the percentage of right answers that passes it (10 to 100), as the
	// teacher set it; a stage that is absent, like every stage of an assignment made before the setting,
	// uses the default 70. Use the API's passPercentOf to read it.
	PassPercents map[string]int `bson:"passPercents,omitempty"`
	// MaxAttempts caps how many runs a student may start per stage (1 to 10); nil, which is what every
	// assignment made before the setting reads as, means unlimited. Only set on an "open" stage lock.
	MaxAttempts *int `bson:"maxAttempts,omitempty"`
	// HideBoard is true when the teacher hid the leaderboard from the students; the zero value, which
	// every assignment made before the setting has, shows it. Fixed for the assignment's life.
	HideBoard bool      `bson:"hideBoard,omitempty"`
	CreatedAt time.Time `bson:"createdAt"`
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

// OpenAt reports whether students can open and join the assignment, and start a run, at now.
func (a *Assignment) OpenAt(now time.Time) bool {
	return a.ClosedAt == nil && (a.ClosesAt == nil || now.Before(*a.ClosesAt))
}

// AcceptsResultsAt reports whether a run already under way may go on at now: the next question and the
// answers reaching the server are still taken while the assignment is open, and for ResultGrace after it
// closed.
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

// StageResult is a player's best finished run of one stage, and how many runs of it they started.
type StageResult struct {
	Correct  int  `bson:"correct"`
	Total    int  `bson:"total"`
	Attempts int  `bson:"attempts"`
	Passed   bool `bson:"passed"`
	// BestAt is when the best score was reached, or the pass made: the leaderboard breaks ties by it.
	BestAt time.Time `bson:"bestAt"`
}

// Player is one student of one assignment. The browser keeps the token; only its hash is stored, as
// with refresh tokens, so reading the database does not let anyone play as somebody else.
type Player struct {
	ID           string `bson:"_id"`
	AssignmentID string `bson:"assignmentId"`
	Name         string `bson:"name"`
	// Avatar is the id of the avatar the student picked; empty for none, and for a player from before
	// avatars existed. The API's avatarIDs lists the valid ids; the store keeps whatever it is given.
	Avatar string `bson:"avatar,omitempty"`
	// NameKey is the lower-cased name, unique within the assignment, so "Lan" and "lan" cannot both join.
	NameKey      string     `bson:"nameKey"`
	TokenHash    string     `bson:"tokenHash"`
	JoinedAt     time.Time  `bson:"joinedAt"`
	LastPlayedAt *time.Time `bson:"lastPlayedAt,omitempty"`
	// Stages holds the best finished run per stage, keyed like Assignment.StageCounts.
	Stages map[string]StageResult `bson:"stages"`
	// Started is how many runs the player has started per stage. A run counts toward the replay limit
	// the moment it starts, finished or not, so leaving a run half way does not buy another try.
	Started map[string]int `bson:"started,omitempty"`
	// Run is the player's latest run, active or finished: starting one replaces it, so a second tab
	// cannot keep a run going beside another one. A finished run stays until the next start, so the
	// answer to its last question can be asked for again if the first reply was lost.
	Run *Run `bson:"run,omitempty"`
	// Version guards UpdatePlayer's read-modify-write (optimistic concurrency).
	Version int `bson:"version"`
}

// Run is one play of one stage, dealt and judged by the server: the questions in the order they are
// asked, how each was shown and, once answered, how it went. It holds no answer text; the right answer is
// found in the assignment's quiz by each question's Item.
type Run struct {
	ID         string        `bson:"id"`
	Stage      string        `bson:"stage"` // "1" to "6", like Assignment.StageCounts
	StartedAt  time.Time     `bson:"startedAt"`
	FinishedAt *time.Time    `bson:"finishedAt,omitempty"`
	Questions  []RunQuestion `bson:"questions"` // in the order asked
}

// RunQuestion is one question of a Run.
type RunQuestion struct {
	// Item is the index of the question in its stage's list of parsed questions (CSV order).
	Item int `bson:"item"`
	// Options are the answers as shown: stage 1 always "Đúng" then "Sai", stages 2 to 5 shuffled.
	Options []string `bson:"options,omitempty"`
	// Chunks are the pieces of a stage 6 sentence, shuffled to an order that is not the answer.
	Chunks []string `bson:"chunks,omitempty"`
	// ServedAt is when the question was handed to the player, which is when its clock started; nil for
	// one not asked yet. AnsweredAt is when its answer was judged; nil while it is open.
	ServedAt   *time.Time `bson:"servedAt,omitempty"`
	AnsweredAt *time.Time `bson:"answeredAt,omitempty"`
	Correct    bool       `bson:"correct"`
	TimedOut   bool       `bson:"timedOut"`
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
	// ListPlayers returns the assignment's players in the order they joined, without their Run: the
	// leaderboard has no use for it.
	ListPlayers(ctx context.Context, assignmentID string) ([]Player, error)
	// PlayerByToken finds the player of the assignment holding the token with this hash, with their Run;
	// ErrNotFound if none.
	PlayerByToken(ctx context.Context, assignmentID, tokenHash string) (*Player, error)
	// UpdatePlayer reads the player, calls change on a copy of it and writes back what change did to its
	// results (Stages), Started, Run and LastPlayedAt, only if no other write got there first; it
	// re-reads and retries when one did, like Users.UpdateSessions, and fails with ErrConflict if that
	// keeps happening. change may therefore run more than once, must not call the store, and sees
	// non-nil Stages and Started. When it returns an error nothing is written and that error comes back
	// unchanged, so a handler can use its own sentinels and capture the fresh player in a closure.
	// ErrNotFound when the assignment has no such player. It returns the player as written.
	UpdatePlayer(ctx context.Context, assignmentID, playerID string, change func(p *Player) error) (*Player, error)
	// SetPlayerAvatar replaces the player's avatar; ErrNotFound when the assignment has no such player.
	// It writes the avatar alone, so it cannot lose a run being updated at the same moment.
	SetPlayerAvatar(ctx context.Context, assignmentID, playerID, avatar string) error
	// DeletePlayer removes one player; ErrNotFound when the assignment has no such player.
	DeletePlayer(ctx context.Context, assignmentID, playerID string) error
}

// MergeRun folds the score of a finished run of the stage into the player's results. A worse run never
// lowers the best and a pass is never taken back; BestAt moves only when the best score improves or the
// pass is first made, which is what the leaderboard's tie-break needs. Attempts is how many runs of the
// stage the player has started, and never less than it was: a player from before the server dealt the
// runs has that count in Attempts and nothing in Started. Whether the run passed is the caller's to
// decide, from the assignment's pass percent; this is the one place that applies the rest of the rule,
// inside the change function of UpdatePlayer, so it works the same on both stores.
func MergeRun(p *Player, stage string, correct, total int, passed bool, now time.Time) {
	now = storedTime(now)

	r, played := p.Stages[stage]
	r.Attempts = max(r.Attempts, p.Started[stage])
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
	if len(a.PassPercents) > 0 {
		a.PassPercents = maps.Clone(a.PassPercents)
	} else {
		a.PassPercents = nil
	}
	if a.MaxAttempts != nil {
		v := *a.MaxAttempts
		a.MaxAttempts = &v
	}
	a.CreatedAt = storedTime(a.CreatedAt)
	a.ClosesAt = storedTimePtr(a.ClosesAt)
	a.ClosedAt = storedTimePtr(a.ClosedAt)
	return a
}

// stored is Assignment.stored for a player: a deep copy with times in milliseconds and a non-nil Stages,
// so an empty value is written as {} rather than null. Started and Run are copied too, and left nil when
// there is nothing in them, which is how a document that never had them reads back.
func (p Player) stored() Player {
	stages := make(map[string]StageResult, len(p.Stages))
	for k, r := range p.Stages {
		r.BestAt = storedTime(r.BestAt)
		stages[k] = r
	}
	p.Stages = stages
	if len(p.Started) > 0 {
		p.Started = maps.Clone(p.Started)
	} else {
		p.Started = nil
	}
	p.Run = p.Run.stored()
	p.JoinedAt = storedTime(p.JoinedAt)
	p.LastPlayedAt = storedTimePtr(p.LastPlayedAt)
	return p
}

// stored deep-copies a run with its times in milliseconds; a nil run stays nil.
func (r *Run) stored() *Run {
	if r == nil {
		return nil
	}
	out := *r
	out.StartedAt = storedTime(r.StartedAt)
	out.FinishedAt = storedTimePtr(r.FinishedAt)
	out.Questions = make([]RunQuestion, len(r.Questions))
	for i, q := range r.Questions {
		q.Options = cloneOrNil(q.Options)
		q.Chunks = cloneOrNil(q.Chunks)
		q.ServedAt = storedTimePtr(q.ServedAt)
		q.AnsweredAt = storedTimePtr(q.AnsweredAt)
		out.Questions[i] = q
	}
	return &out
}

// cloneOrNil copies a slice, and turns an empty one into nil, the way an omitted field reads back.
func cloneOrNil(s []string) []string {
	if len(s) == 0 {
		return nil
	}
	return slices.Clone(s)
}
