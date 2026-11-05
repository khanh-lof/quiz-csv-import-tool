package store

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type PostgresJobs struct {
	pool *pgxpool.Pool
	now  func() time.Time
}

func NewPostgresJobs(pool *pgxpool.Pool) *PostgresJobs {
	return &PostgresJobs{pool: pool, now: time.Now}
}

// jobColumns are every column but source, which only Get reads: it is the bulk of a Radicals job, and the
// history List feeds never needs it.
const jobColumns = `id, username, status, title, creative, language, export_type, intelligence, image_count,
	course_type, course_name, hsk_standard, level, lesson_numbers, gesture_stages, questions_per_stage,
	progress_rows, csv, error_status, error_code, error_message, usage, round_start, created_at, heartbeat_at,
	finished_at`

func scanJob(row pgx.Row, extra ...any) (*Job, error) {
	var j Job
	dest := append([]any{&j.ID, &j.Username, &j.Status, &j.Title, &j.Creative, &j.Language, &j.ExportType,
		&j.Intelligence, &j.ImageCount, &j.CourseType, &j.CourseName, &j.HskStandard, &j.Level, &j.LessonNumbers,
		&j.GestureStages, &j.QuestionsPerStage, &j.ProgressRows, &j.CSV, &j.ErrorStatus, &j.ErrorCode,
		&j.ErrorMessage, &j.Usage, &j.RoundStart, &j.CreatedAt, &j.HeartbeatAt, &j.FinishedAt}, extra...)
	if err := row.Scan(dest...); err != nil {
		return nil, notFound(err)
	}
	return &j, nil
}

func (p *PostgresJobs) Create(ctx context.Context, job *Job) error {
	_, err := p.pool.Exec(ctx, `INSERT INTO jobs (`+jobColumns+`, source) VALUES
		($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23,
		 $24, $25, $26, $27)`,
		job.ID, job.Username, job.Status, job.Title, job.Creative, job.Language, job.ExportType, job.Intelligence,
		job.ImageCount, job.CourseType, job.CourseName, job.HskStandard, job.Level, nilIfEmpty(job.LessonNumbers),
		nilIfEmpty(job.GestureStages), job.QuestionsPerStage, job.ProgressRows, job.CSV, job.ErrorStatus,
		job.ErrorCode, job.ErrorMessage, job.Usage, storedTime(job.RoundStart), storedTime(job.CreatedAt),
		storedTimePtr(job.HeartbeatAt), storedTimePtr(job.FinishedAt), job.Source)
	if isUniqueViolation(err) {
		return ErrDuplicate
	}
	return err
}

// nilIfEmpty stores an empty list as NULL, so it reads back nil like a list that was never set.
func nilIfEmpty(s []int) []int {
	if len(s) == 0 {
		return nil
	}
	return s
}

// Complete, Fail and the other writes of a running job only touch a job that is still running, so a job
// expired as abandoned is not revived by a late answer, and a finished one is never overwritten.
func (p *PostgresJobs) Complete(ctx context.Context, username, id, csv, source string, usage JobUsage) error {
	_, err := p.pool.Exec(ctx, `UPDATE jobs SET status = $3, csv = $4, usage = $5, finished_at = $6,
			source = CASE WHEN $7 = '' THEN source ELSE $7 END
		WHERE id = $1 AND username = $2 AND status = 'running'`,
		id, username, JobDone, csv, usage, storedTime(p.now()), source)
	return err
}

func (p *PostgresJobs) Revise(ctx context.Context, username, id, csv, source string) error {
	return checkOne(p.pool.Exec(ctx, `UPDATE jobs SET csv = $3, source = $4 WHERE id = $1 AND username = $2 AND status = 'done'`,
		id, username, csv, source))
}

func (p *PostgresJobs) Fail(ctx context.Context, username, id string, failure JobFailure, usage JobUsage) error {
	_, err := p.pool.Exec(ctx, `UPDATE jobs SET status = $3, error_status = $4, error_code = $5, error_message = $6,
			usage = $7, finished_at = $8
		WHERE id = $1 AND username = $2 AND status = 'running'`,
		id, username, JobFailed, failure.Status, failure.Code, failure.Message, usage, storedTime(p.now()))
	return err
}

func (p *PostgresJobs) Progress(ctx context.Context, username, id string, rows int) error {
	_, err := p.pool.Exec(ctx, `UPDATE jobs SET progress_rows = $3 WHERE id = $1 AND username = $2 AND status = 'running'`,
		id, username, rows)
	return err
}

func (p *PostgresJobs) Heartbeat(ctx context.Context, username, id string) error {
	_, err := p.pool.Exec(ctx, `UPDATE jobs SET heartbeat_at = $3 WHERE id = $1 AND username = $2 AND status = 'running'`,
		id, username, storedTime(p.now()))
	return err
}

func (p *PostgresJobs) Get(ctx context.Context, username, id string) (*Job, error) {
	var source string
	job, err := scanJob(p.pool.QueryRow(ctx, `SELECT `+jobColumns+`, source FROM jobs WHERE id = $1 AND username = $2`,
		id, username), &source)
	if err != nil {
		return nil, err
	}
	job.Source = source
	return job, nil
}

func (p *PostgresJobs) List(ctx context.Context, username string, limit int) ([]Job, error) {
	if limit <= 0 {
		return []Job{}, nil
	}
	return p.query(ctx, `SELECT `+jobColumns+` FROM jobs WHERE username = $1 ORDER BY created_at DESC, id DESC LIMIT $2`,
		username, limit)
}

func (p *PostgresJobs) query(ctx context.Context, sql string, args ...any) ([]Job, error) {
	rows, err := p.pool.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	jobs := []Job{}
	for rows.Next() {
		job, err := scanJob(rows)
		if err != nil {
			return nil, err
		}
		jobs = append(jobs, *job)
	}
	return jobs, rows.Err()
}

func (p *PostgresJobs) Delete(ctx context.Context, username, id string) error {
	return checkOne(p.pool.Exec(ctx, `DELETE FROM jobs WHERE id = $1 AND username = $2`, id, username))
}

func (p *PostgresJobs) ExpireRunning(ctx context.Context, username string, before time.Time, message string) ([]Job, error) {
	return p.query(ctx, `UPDATE jobs SET status = $3, error_status = $4, error_code = $5, error_message = $6, finished_at = $7
		WHERE username = $1 AND status = 'running' AND coalesce(heartbeat_at, created_at) < $2
		RETURNING `+jobColumns,
		username, before, JobFailed, ExpiredJobStatus, ExpiredJobCode, message, storedTime(p.now()))
}

// Prune never deletes a running job: its answer would be written into nothing.
func (p *PostgresJobs) Prune(ctx context.Context, username string, keep int) error {
	_, err := p.pool.Exec(ctx, `DELETE FROM jobs WHERE username = $1 AND status <> 'running' AND id IN (
			SELECT id FROM jobs WHERE username = $1 ORDER BY created_at DESC, id DESC OFFSET $2)`,
		username, keep)
	return err
}
