package api

import (
	"cmp"
	"slices"
	"strings"
	"time"

	"quiz-csv-import-tool/server/internal/store"
)

// stageScore is a player's best run of one stage, as the ranking page shows it.
type stageScore struct {
	Correct  int  `json:"correct"`
	Total    int  `json:"total"`
	Passed   bool `json:"passed"`
	Attempts int  `json:"attempts"`
}

// rankedPlayer is one row of an assignment's ranking. Rank is nil for a player who has joined but has
// no result yet; ReachedAt is when the player's current score was reached, which breaks ties.
type rankedPlayer struct {
	ID           string                `json:"id"`
	Name         string                `json:"name"`
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

// rankPlayers orders an assignment's players and numbers them. Players with results come first, by
// stages passed, then by the sum of their best correct counts, then by who reached that score first;
// players equal on all three share a rank (1, 1, 3, like a race), and those still tied are listed by
// when they joined. Players without a result follow in the order they joined, unranked. Only the
// stages in stageCounts count, so a result for a stage the assignment does not have is ignored.
func rankPlayers(players []store.Player, stageCounts map[string]int) []rankedPlayer {
	possible := 0
	for _, n := range stageCounts {
		possible += n
	}

	ranked := make([]rankedPlayer, len(players))
	for i, p := range players {
		ranked[i] = scorePlayer(p, stageCounts, possible)
	}
	slices.SortStableFunc(ranked, compareRanked)

	for i := range ranked {
		if len(ranked[i].Stages) == 0 {
			break // the unranked players are all at the end
		}
		rank := i + 1
		if i > 0 && sameScore(ranked[i-1], ranked[i]) {
			rank = *ranked[i-1].Rank
		}
		ranked[i].Rank = &rank
	}
	return ranked
}

func scorePlayer(p store.Player, stageCounts map[string]int, possible int) rankedPlayer {
	row := rankedPlayer{
		ID:       p.ID,
		Name:     p.Name,
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
		row.Stages[stage] = stageScore{Correct: r.Correct, Total: r.Total, Passed: r.Passed, Attempts: r.Attempts}
		row.Correct += r.Correct
		row.Attempts += r.Attempts
		if r.Passed {
			row.StagesPassed++
		}
		if at := r.BestAt.UTC(); row.ReachedAt == nil || at.After(*row.ReachedAt) {
			row.ReachedAt = &at
		}
	}
	return row
}

func compareRanked(a, b rankedPlayer) int {
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
func sameScore(a, b rankedPlayer) bool {
	return a.StagesPassed == b.StagesPassed && a.Correct == b.Correct && a.ReachedAt.Equal(*b.ReachedAt)
}
