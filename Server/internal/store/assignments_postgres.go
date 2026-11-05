package store

import (
	"context"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// PostgresAssignments keeps assignments and their players in two tables. Players are rows of their own, not
// a list on the assignment, so many students finishing a stage at the same moment write different rows.
// Deleting an assignment deletes its players (ON DELETE CASCADE).
type PostgresAssignments struct {
	pool *pgxpool.Pool
}

func NewPostgresAssignments(pool *pgxpool.Pool) *PostgresAssignments {
	return &PostgresAssignments{pool: pool}
}

// assignmentColumns are every column but csv, which List leaves out.
const assignmentColumns = `id, code, username, job_id, title, label, language, time_mode, stage_lock, stage_counts,
	pass_percents, max_attempts, hide_board, show_pinyin, created_at, closes_at, closed_at`

func scanAssignment(row pgx.Row, extra ...any) (*Assignment, error) {
	var a Assignment
	dest := append([]any{&a.ID, &a.Code, &a.Username, &a.JobID, &a.Title, &a.Label, &a.Language, &a.TimeMode,
		&a.StageLock, &a.StageCounts, &a.PassPercents, &a.MaxAttempts, &a.HideBoard, &a.ShowPinyin, &a.CreatedAt,
		&a.ClosesAt, &a.ClosedAt}, extra...)
	if err := row.Scan(dest...); err != nil {
		return nil, notFound(err)
	}
	if a.StageCounts == nil {
		a.StageCounts = map[string]int{}
	}
	if len(a.PassPercents) == 0 {
		a.PassPercents = nil
	}
	return &a, nil
}

func (p *PostgresAssignments) Create(ctx context.Context, a *Assignment) error {
	doc := a.stored()
	_, err := p.pool.Exec(ctx, `INSERT INTO assignments (`+assignmentColumns+`, csv) VALUES
		($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
		doc.ID, doc.Code, doc.Username, doc.JobID, doc.Title, doc.Label, doc.Language, doc.TimeMode, doc.StageLock,
		doc.StageCounts, doc.PassPercents, doc.MaxAttempts, doc.HideBoard, doc.ShowPinyin, doc.CreatedAt,
		doc.ClosesAt, doc.ClosedAt, doc.CSV)
	if isUniqueViolation(err) {
		return ErrDuplicate
	}
	return err
}

func (p *PostgresAssignments) Get(ctx context.Context, username, id string) (*Assignment, error) {
	return p.getWithCSV(ctx, `id = $1 AND username = $2`, id, username)
}

func (p *PostgresAssignments) GetByCode(ctx context.Context, code string) (*Assignment, error) {
	return p.getWithCSV(ctx, `code = $1`, code)
}

func (p *PostgresAssignments) getWithCSV(ctx context.Context, where string, args ...any) (*Assignment, error) {
	var csv string
	a, err := scanAssignment(p.pool.QueryRow(ctx, `SELECT `+assignmentColumns+`, csv FROM assignments WHERE `+where, args...), &csv)
	if err != nil {
		return nil, err
	}
	a.CSV = csv
	return a, nil
}

func (p *PostgresAssignments) List(ctx context.Context, username string, limit int) ([]Assignment, error) {
	if limit <= 0 {
		return []Assignment{}, nil
	}
	rows, err := p.pool.Query(ctx, `SELECT `+assignmentColumns+` FROM assignments WHERE username = $1
		ORDER BY created_at DESC, id DESC LIMIT $2`, username, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	list := []Assignment{}
	for rows.Next() {
		a, err := scanAssignment(rows)
		if err != nil {
			return nil, err
		}
		list = append(list, *a)
	}
	return list, rows.Err()
}

func (p *PostgresAssignments) Count(ctx context.Context, username string) (int, error) {
	var n int
	err := p.pool.QueryRow(ctx, `SELECT count(*) FROM assignments WHERE username = $1`, username).Scan(&n)
	return n, err
}

func (p *PostgresAssignments) Update(ctx context.Context, username, id string, u AssignmentUpdate) (*Assignment, error) {
	if u.isEmpty() {
		return p.Get(ctx, username, id)
	}
	args := []any{id, username}
	var set []string
	add := func(column string, value any) {
		args = append(args, value)
		set = append(set, fmt.Sprintf("%s = $%d", column, len(args)))
	}
	if u.Label != nil {
		add("label", *u.Label)
	}
	if u.ShowPinyin != nil {
		add("show_pinyin", *u.ShowPinyin)
	}
	if u.ClosesAt.Set {
		add("closes_at", storedTimePtr(u.ClosesAt.Value))
	}
	if u.ClosedAt.Set {
		add("closed_at", storedTimePtr(u.ClosedAt.Value))
	}
	var csv string
	a, err := scanAssignment(p.pool.QueryRow(ctx, `UPDATE assignments SET `+strings.Join(set, ", ")+
		` WHERE id = $1 AND username = $2 RETURNING `+assignmentColumns+`, csv`, args...), &csv)
	if err != nil {
		return nil, err
	}
	a.CSV = csv
	return a, nil
}

func (p *PostgresAssignments) Delete(ctx context.Context, username, id string) error {
	return checkOne(p.pool.Exec(ctx, `DELETE FROM assignments WHERE id = $1 AND username = $2`, id, username))
}

const playerColumns = `id, assignment_id, name, avatar, name_key, token_hash, joined_at, last_played_at, stages,
	started, version`

func scanPlayer(row pgx.Row, extra ...any) (*Player, error) {
	var pl Player
	dest := append([]any{&pl.ID, &pl.AssignmentID, &pl.Name, &pl.Avatar, &pl.NameKey, &pl.TokenHash, &pl.JoinedAt,
		&pl.LastPlayedAt, &pl.Stages, &pl.Started, &pl.Version}, extra...)
	if err := row.Scan(dest...); err != nil {
		return nil, notFound(err)
	}
	if pl.Stages == nil {
		pl.Stages = map[string]StageResult{}
	}
	if len(pl.Started) == 0 {
		pl.Started = nil
	}
	return &pl, nil
}

func (p *PostgresAssignments) CreatePlayer(ctx context.Context, pl *Player) error {
	doc := pl.stored()
	_, err := p.pool.Exec(ctx, `INSERT INTO assignment_players (`+playerColumns+`, run) VALUES
		($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
		doc.ID, doc.AssignmentID, doc.Name, doc.Avatar, doc.NameKey, doc.TokenHash, doc.JoinedAt, doc.LastPlayedAt,
		doc.Stages, doc.Started, doc.Version, doc.Run)
	if isUniqueViolation(err) {
		return ErrDuplicate
	}
	return err
}

func (p *PostgresAssignments) CountPlayers(ctx context.Context, assignmentIDs []string) (map[string]int, error) {
	counts := make(map[string]int, len(assignmentIDs))
	if len(assignmentIDs) == 0 {
		return counts, nil
	}
	for _, id := range assignmentIDs {
		counts[id] = 0
	}
	rows, err := p.pool.Query(ctx, `SELECT assignment_id, count(*) FROM assignment_players
		WHERE assignment_id = ANY($1) GROUP BY assignment_id`, assignmentIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		var n int
		if err := rows.Scan(&id, &n); err != nil {
			return nil, err
		}
		counts[id] = n
	}
	return counts, rows.Err()
}

// ListPlayers leaves out each player's run: it is the bulk of a row that is being written all the time, and
// the leaderboard it is read for never needs it.
func (p *PostgresAssignments) ListPlayers(ctx context.Context, assignmentID string) ([]Player, error) {
	rows, err := p.pool.Query(ctx, `SELECT `+playerColumns+` FROM assignment_players WHERE assignment_id = $1
		ORDER BY joined_at, id`, assignmentID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	players := []Player{}
	for rows.Next() {
		pl, err := scanPlayer(rows)
		if err != nil {
			return nil, err
		}
		players = append(players, *pl)
	}
	return players, rows.Err()
}

func (p *PostgresAssignments) PlayerByToken(ctx context.Context, assignmentID, tokenHash string) (*Player, error) {
	return p.playerWithRun(ctx, p.pool, `SELECT `+playerColumns+`, run FROM assignment_players
		WHERE assignment_id = $1 AND token_hash = $2 LIMIT 1`, assignmentID, tokenHash)
}

func (p *PostgresAssignments) playerWithRun(ctx context.Context, q interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}, sql string, args ...any) (*Player, error) {
	var run *Run
	pl, err := scanPlayer(q.QueryRow(ctx, sql, args...), &run)
	if err != nil {
		return nil, err
	}
	pl.Run = run
	return pl, nil
}

// UpdatePlayer locks the player's row from the read to the write. Only stages, started, run and
// last_played_at are written.
func (p *PostgresAssignments) UpdatePlayer(ctx context.Context, assignmentID, playerID string, change func(p *Player) error) (*Player, error) {
	var written Player
	err := pgx.BeginFunc(ctx, p.pool, func(tx pgx.Tx) error {
		read, err := p.playerWithRun(ctx, tx, `SELECT `+playerColumns+`, run FROM assignment_players
			WHERE id = $1 AND assignment_id = $2 FOR UPDATE`, playerID, assignmentID)
		if err != nil {
			return err
		}

		changed := read.stored()
		if changed.Started == nil {
			changed.Started = map[string]int{}
		}
		if err := change(&changed); err != nil {
			return err
		}
		changed = changed.stored()

		written = read.stored()
		written.Stages, written.Started, written.Run, written.LastPlayedAt =
			changed.Stages, changed.Started, changed.Run, changed.LastPlayedAt
		written.Version++
		_, err = tx.Exec(ctx, `UPDATE assignment_players SET stages = $3, started = $4, run = $5, last_played_at = $6,
				version = version + 1
			WHERE id = $1 AND assignment_id = $2`,
			playerID, assignmentID, written.Stages, written.Started, written.Run, written.LastPlayedAt)
		return err
	})
	if err != nil {
		return nil, err
	}
	return &written, nil
}

// SetPlayerAvatar writes the one column. UpdatePlayer never writes the avatar, so the two cannot undo each
// other and the version is left alone.
func (p *PostgresAssignments) SetPlayerAvatar(ctx context.Context, assignmentID, playerID, avatar string) error {
	return checkOne(p.pool.Exec(ctx, `UPDATE assignment_players SET avatar = $3 WHERE id = $1 AND assignment_id = $2`,
		playerID, assignmentID, avatar))
}

func (p *PostgresAssignments) DeletePlayer(ctx context.Context, assignmentID, playerID string) error {
	return checkOne(p.pool.Exec(ctx, `DELETE FROM assignment_players WHERE id = $1 AND assignment_id = $2`,
		playerID, assignmentID))
}
