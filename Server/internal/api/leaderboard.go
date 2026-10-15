package api

import (
	"cmp"
	"slices"
	"strings"
	"time"

	"quiz-csv-import-tool/server/internal/store"
)

const (
	// studentBoardMaxRank is the lowest place the students' board lists: the top five.
	studentBoardMaxRank = 5
	// studentBoardMaxRows caps its rows, since a tie for fifth place can add some beyond five (and a
	// class that all tie for first would otherwise list everyone).
	studentBoardMaxRows = 10
)

// stageScore is a player's best run of one stage, as the leaderboard page shows it.
type stageScore struct {
	Correct  int  `json:"correct"`
	Total    int  `json:"total"`
	Passed   bool `json:"passed"`
	Attempts int  `json:"attempts"`
}

// leaderboardEntry is one row of an assignment's leaderboard. Rank is nil for a player who has joined
// but has no result yet; ReachedAt is when the player's current score was reached, which breaks ties.
type leaderboardEntry struct {
	ID           string                `json:"id"`
	Name         string                `json:"name"`
	Avatar       string                `json:"avatar"`
	Rank         *int                  `json:"rank"`
	StagesPassed int                   `json:"stagesPassed"`
	Correct      int                   `json:"correct"`
	Possible     int                   `json:"possible"`
	Attempts     int                   `json:"attempts"`
	Stages       map[string]stageScore `json:"stages"`
	JoinedAt     time.Time             `json:"joinedAt"`
	LastPlayedAt *time.Time            `json:"lastPlayedAt"`
	ReachedAt    *time.Time            `json:"reachedAt"`
}

// buildLeaderboard orders an assignment's players and numbers them. Players with results come first, by
// stages passed, then by the sum of their best correct counts, then by who reached that score first;
// players equal on all three share a rank (1, 1, 3, like a race), and those still tied are listed by
// when they joined. Players without a result follow in the order they joined, unranked. Only the
// stages in stageCounts count, so a result for a stage the assignment does not have is ignored. Ranking
// uses only the finished runs; a run that was started and left is an attempt and no score.
func buildLeaderboard(players []store.Player, stageCounts map[string]int) []leaderboardEntry {
	possible := possibleOf(stageCounts)

	entries := make([]leaderboardEntry, len(players))
	for i, p := range players {
		entries[i] = scorePlayer(p, stageCounts, possible)
	}
	slices.SortStableFunc(entries, compareEntries)

	for i := range entries {
		if len(entries[i].Stages) == 0 {
			break // the unranked players are all at the end
		}
		rank := i + 1
		if i > 0 && sameScore(entries[i-1], entries[i]) {
			rank = *entries[i-1].Rank
		}
		entries[i].Rank = &rank
	}
	return entries
}

// possibleOf is the most a player can get right in the assignment: every question of every stage.
func possibleOf(stageCounts map[string]int) int {
	possible := 0
	for _, n := range stageCounts {
		possible += n
	}
	return possible
}

func scorePlayer(p store.Player, stageCounts map[string]int, possible int) leaderboardEntry {
	row := leaderboardEntry{
		ID:       p.ID,
		Name:     p.Name,
		Avatar:   p.Avatar,
		Possible: possible,
		Stages:   map[string]stageScore{},
		JoinedAt: p.JoinedAt.UTC(),
	}
	if p.LastPlayedAt != nil {
		last := p.LastPlayedAt.UTC()
		row.LastPlayedAt = &last
	}
	for stage, r := range p.Stages {
		if _, ok := stageCounts[stage]; !ok {
			continue
		}
		// A run counts as an attempt from the moment it starts, so a stage's attempts are what was
		// started, or what its results say for a player from before the server dealt the runs.
		attempts := max(r.Attempts, p.Started[stage])
		row.Stages[stage] = stageScore{Correct: r.Correct, Total: r.Total, Passed: r.Passed, Attempts: attempts}
		row.Correct += r.Correct
		row.Attempts += attempts
		if r.Passed {
			row.StagesPassed++
		}
		if at := r.BestAt.UTC(); row.ReachedAt == nil || at.After(*row.ReachedAt) {
			row.ReachedAt = &at
		}
	}
	// A run that was started and never finished is an attempt too, but it records no score: it adds to the
	// attempts and to nothing else, so the player is not ranked for it.
	for stage, started := range p.Started {
		if _, ok := stageCounts[stage]; !ok {
			continue
		}
		if _, finished := p.Stages[stage]; !finished {
			row.Attempts += started
		}
	}
	return row
}

func compareEntries(a, b leaderboardEntry) int {
	aPlayed, bPlayed := len(a.Stages) > 0, len(b.Stages) > 0
	if aPlayed != bPlayed {
		if aPlayed {
			return -1
		}
		return 1
	}
	if aPlayed {
		// Both have results, so both have a ReachedAt.
		byScore := cmp.Or(
			cmp.Compare(b.StagesPassed, a.StagesPassed),
			cmp.Compare(b.Correct, a.Correct),
			a.ReachedAt.Compare(*b.ReachedAt),
		)
		if byScore != 0 {
			return byScore
		}
	}
	// The id only keeps the order stable between two players who joined in the same millisecond.
	return cmp.Or(a.JoinedAt.Compare(b.JoinedAt), strings.Compare(a.ID, b.ID))
}

// sameScore reports whether two players with results are tied, which is what shares a rank.
func sameScore(a, b leaderboardEntry) bool {
	return a.StagesPassed == b.StagesPassed && a.Correct == b.Correct && a.ReachedAt.Equal(*b.ReachedAt)
}

// studentBoardRow is one of the places a student sees on the board. It carries no player id: the
// whole class reads the board, and You marks the reader's own row instead.
type studentBoardRow struct {
	Rank         int    `json:"rank"`
	Name         string `json:"name"`
	Avatar       string `json:"avatar"`
	StagesPassed int    `json:"stagesPassed"`
	Correct      int    `json:"correct"`
	You          bool   `json:"you"`
}

// studentBoardYou is the reader's own place, shown even when it is outside the top. Rank is nil for a
// student who has joined but has no result yet.
type studentBoardYou struct {
	Rank         *int   `json:"rank"`
	Name         string `json:"name"`
	Avatar       string `json:"avatar"`
	StagesPassed int    `json:"stagesPassed"`
	Correct      int    `json:"correct"`
}

// studentBoard is the leaderboard as a student sees it: the top of the class and their own place,
// not the whole class the teacher gets.
type studentBoard struct {
	Top         []studentBoardRow `json:"top"`
	You         *studentBoardYou  `json:"you"`
	Possible    int               `json:"possible"`
	StageCount  int               `json:"stageCount"`
	PlayerCount int               `json:"playerCount"`
}

// newStudentBoard cuts a student's view out of the full leaderboard. The top is every ranked entry
// from first to fifth place in leaderboard order, so a tie for fifth lists everyone who shares it, but
// never more than studentBoardMaxRows rows. youID is the reader's player id, empty for a reader
// without a known player; You is then nil, as it is for an id that is not on the leaderboard.
func newStudentBoard(entries []leaderboardEntry, youID string, stageCounts map[string]int) studentBoard {
	board := studentBoard{
		Top:         []studentBoardRow{},
		Possible:    possibleOf(stageCounts),
		StageCount:  len(stageCounts),
		PlayerCount: len(entries),
	}
	for _, e := range entries {
		isYou := youID != "" && e.ID == youID
		if isYou {
			board.You = &studentBoardYou{
				Rank: e.Rank, Name: e.Name, Avatar: e.Avatar, StagesPassed: e.StagesPassed, Correct: e.Correct,
			}
		}
		// The entries are in rank order with the unranked last, so past the top no entry is a row any
		// more; the loop still goes on, to find the reader.
		if e.Rank != nil && *e.Rank <= studentBoardMaxRank && len(board.Top) < studentBoardMaxRows {
			board.Top = append(board.Top, studentBoardRow{
				Rank: *e.Rank, Name: e.Name, Avatar: e.Avatar, StagesPassed: e.StagesPassed, Correct: e.Correct, You: isYou,
			})
		}
	}
	return board
}
