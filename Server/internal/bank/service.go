package bank

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"log/slog"
	mathrand "math/rand/v2"
	"slices"
	"time"

	"quiz-csv-import-tool/server/internal/csvgen"
	"quiz-csv-import-tool/server/internal/store"
)

// Writer asks the model for questions; implemented by *csvgen.Client.
type Writer interface {
	WriteQuestions(ctx context.Context, opts csvgen.Options, vocabulary csvgen.Vocabulary, specs []csvgen.QuestionSpec) ([]csvgen.QuestionDraft, csvgen.Usage, error)
}

// Service builds quizzes from the bank, asking Writer for what the bank lacks.
type Service struct {
	Store  store.QuestionBank
	Writer Writer
	Logger *slog.Logger
	// Seed is each quiz's randomness, Now the clock and NewID the id of a new question; nil means a random seed,
	// time.Now and a random 32-hex-digit id. Tests set them.
	Seed  func() uint64
	Now   func() time.Time
	NewID func() string
}

// Build is a quiz being built for one request.
type Build struct {
	Request Request
	Options csvgen.Options
	Plan    Plan
	pool    []store.Question
	seed    uint64
}

// Prepare plans the quiz of a creative request from the bank alone. ok is false when the bank does not build
// that quiz (see NewRequest); err is set when the bank could not be read.
func (s *Service) Prepare(ctx context.Context, opts csvgen.Options) (build *Build, ok bool, err error) {
	req, ok := NewRequest(opts)
	if !ok {
		return nil, false, nil
	}
	pool, err := s.Store.Pool(ctx, int(req.Language), req.Vocabulary.Book, req.Vocabulary.MaxLesson())
	if err != nil {
		return nil, true, fmt.Errorf("reading the question bank: %w", err)
	}
	seed := s.seed()
	return &Build{Request: req, Options: opts, Plan: PlanQuiz(req, pool, seed), pool: pool, seed: seed}, true, nil
}

// Finish writes the quiz of the build's plan and counts its questions as served. fromBank is how many of them the
// bank held before the job.
func (s *Service) Finish(ctx context.Context, b *Build, fromBank int) (csvgen.Result, error) {
	csv, err := Render(b.Request, b.Plan.Picks, b.seed)
	if err != nil {
		return csvgen.Result{}, csvgen.BadOutput(err)
	}
	ids := b.Plan.IDs()
	// Only the rotation suffers when this fails.
	if err := s.Store.MarkServed(ctx, ids, s.now()); err != nil {
		s.Logger.Warn("counting the served bank questions failed", "error", err)
	}
	return csvgen.Result{CSV: csv, BankQuestions: ids, FromBank: fromBank}, nil
}

// Fill asks the model for the questions the build's plan lacks, and a few more for the words the bank had no
// question on, stores the ones that pass Validate, plans the quiz again with them and writes it. A plan still
// short of half its questions (or of a Game stage) after that fails as bad output.
func (s *Service) Fill(ctx context.Context, b *Build, jobID string) (csvgen.Result, error) {
	drafts, usage, err := s.Writer.WriteQuestions(ctx, b.Options, b.Request.Vocabulary, specsFor(b.Plan))
	if err != nil {
		return csvgen.Result{Usage: usage}, err
	}
	origin := Origin{
		Vocabulary: b.Request.Vocabulary, Language: b.Request.Language, Model: usage.Model, JobID: jobID, Now: s.now(),
	}
	var written []store.Question
	for i, draft := range drafts {
		q, err := Validate(draft, origin, s.newID())
		if err != nil {
			s.Logger.Warn("leaving out a question the model wrote", "job", jobID, "question", i+1, "reason", err.Error())
			continue
		}
		written = append(written, q)
	}
	stored, err := s.Store.Insert(ctx, written)
	if err != nil {
		// The quiz can still use them; the next one will have to ask again.
		s.Logger.Warn("storing the model's questions in the bank failed", "job", jobID, "error", err)
		stored = nil
		for _, q := range written {
			stored = append(stored, q.ID)
		}
	}
	s.Logger.Info("question bank filled", "job", jobID, "book", b.Request.Vocabulary.Book, "gaps", len(b.Plan.Gaps),
		"asked", len(specsFor(b.Plan)), "written", len(drafts), "valid", len(written), "stored", len(stored))

	before := make(map[string]bool, len(b.pool))
	for _, q := range b.pool {
		before[q.ID] = true
	}
	pool := slices.Clone(b.pool)
	for _, q := range written {
		// A question the bank already held under another id is in the pool already.
		if slices.Contains(stored, q.ID) {
			pool = append(pool, q)
		}
	}
	b.pool, b.Plan = pool, PlanQuiz(b.Request, pool, b.seed)
	if !b.Plan.Complete() && !b.Plan.Playable() {
		return csvgen.Result{Usage: usage}, csvgen.BadOutput(fmt.Errorf("the bank and the model's answer make %d of the quiz's %d questions",
			len(b.Plan.Picks), b.Plan.Size))
	}
	fromBank := 0
	for _, id := range b.Plan.IDs() {
		if before[id] {
			fromBank++
		}
	}
	result, err := s.Finish(ctx, b, fromBank)
	result.Usage = usage
	return result, err
}

// specsFor is what to ask the model for: the plan's gaps, then, so the bank grows, one more question for each word
// it had none on, at the next difficulty level, at most maxPlanSpecs in all.
func specsFor(plan Plan) []csvgen.QuestionSpec {
	specs := slices.Clone(plan.Gaps)
	for _, word := range plan.Uncovered {
		level := Medium
		if i := slices.IndexFunc(plan.Gaps, func(g csvgen.QuestionSpec) bool { return g.Word == word }); i >= 0 {
			level = plan.Gaps[i].Difficulty
		}
		next := level%Hard + 1
		spec := csvgen.QuestionSpec{Word: word, Format: FormatMC, Skills: skillsFor[next], Difficulty: next, Options: 4}
		if next == Hard {
			spec.Format = ""
		}
		specs = append(specs, spec)
	}
	return specs[:min(len(specs), maxPlanSpecs)]
}

func (s *Service) seed() uint64 {
	if s.Seed != nil {
		return s.Seed()
	}
	return mathrand.Uint64()
}

func (s *Service) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now()
}

func (s *Service) newID() string {
	if s.NewID != nil {
		return s.NewID()
	}
	var b [16]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

// jobKey carries the id of the job a generation is for, so the questions it writes name it.
type jobKey struct{}

// WithJob is ctx carrying the id of the job a generation is for.
func WithJob(ctx context.Context, id string) context.Context {
	return context.WithValue(ctx, jobKey{}, id)
}

func jobOf(ctx context.Context) string {
	id, _ := ctx.Value(jobKey{}).(string)
	return id
}

// Generator is the job's generator with the bank in front: a creative quiz the bank builds (see NewRequest),
// asked without images, comes from the bank, the model writing only what the bank lacks; everything else, and
// every quiz while the bank cannot be read, goes to Next as before.
type Generator struct {
	Next interface {
		Generate(ctx context.Context, images []csvgen.Image, creative bool, opts csvgen.Options) (csvgen.Result, error)
	}
	Service *Service
}

func (g *Generator) Generate(ctx context.Context, images []csvgen.Image, creative bool, opts csvgen.Options) (csvgen.Result, error) {
	if !creative || len(images) > 0 {
		return g.Next.Generate(ctx, images, creative, opts)
	}
	build, ok, err := g.Service.Prepare(ctx, opts)
	if !ok {
		return g.Next.Generate(ctx, images, creative, opts)
	}
	if err != nil {
		g.Service.Logger.Warn("question bank unavailable, generating the whole quiz", "job", jobOf(ctx), "error", err)
		return g.Next.Generate(ctx, images, creative, opts)
	}
	if build.Plan.Complete() {
		return g.Service.Finish(ctx, build, len(build.Plan.Picks))
	}
	return g.Service.Fill(ctx, build, jobOf(ctx))
}
