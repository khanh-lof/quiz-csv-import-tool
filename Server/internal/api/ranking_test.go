package api

import (
	"encoding/json"
	"slices"
	"strings"
	"testing"
	"time"

	"quiz-csv-import-tool/server/internal/store"
)

var rankingBase = time.Date(2026, time.October, 14, 9, 0, 0, 0, time.UTC)

// minute is a moment the given number of minutes after the start of the lesson.
func minute(minutes int) time.Time { return rankingBase.Add(time.Duration(minutes) * time.Minute) }

// stageRun is a stage result: the best score, how many times it was played and when it was reached.
func stageRun(correct, total, attempts int, passed bool, bestAt time.Time) store.StageResult {
	return store.StageResult{Correct: correct, Total: total, Attempts: attempts, Passed: passed, BestAt: bestAt}
}

func testPlayer(id string, joined time.Time, stages map[string]store.StageResult) store.Player {
	return store.Player{ID: id, Name: strings.ToUpper(id), JoinedAt: joined, Stages: stages}
}

func playerIDs(ranked []rankedPlayer) []string {
	out := make([]string, len(ranked))
	for i, r := range ranked {
		out[i] = r.ID
	}
	return out
}

func playerRanks(ranked []rankedPlayer) []int {
	out := make([]int, len(ranked))
	for i, r := range ranked {
		out[i] = -1
		if r.Rank != nil {
			out[i] = *r.Rank
		}
	}
	return out
}

var rankingStageCounts = map[string]int{"1": 5, "2": 10, "3": 5}

func TestRankPlayersOrder(t *testing.T) {
	players := []store.Player{
		// Two stages passed, 12 correct: ahead of everyone with fewer stages, whatever their score.
		testPlayer("two-passed", minute(0), map[string]store.StageResult{
			"1": stageRun(5, 5, 1, true, minute(10)),
			"2": stageRun(7, 10, 2, true, minute(20)),
		}),
		// One stage passed but a high count of correct answers elsewhere does not beat two passes.
		testPlayer("one-passed-high", minute(1), map[string]store.StageResult{
			"1": stageRun(5, 5, 1, true, minute(5)),
			"2": stageRun(6, 10, 3, false, minute(6)),
			"3": stageRun(4, 5, 1, false, minute(7)),
		}),
		// The same stages passed and the same correct count as the one above, but reached earlier.
		testPlayer("one-passed-early", minute(2), map[string]store.StageResult{
			"1": stageRun(5, 5, 1, true, minute(4)),
			"2": stageRun(6, 10, 3, false, minute(4)),
			"3": stageRun(4, 5, 1, false, minute(4)),
		}),
		// Fewer correct answers than the two above.
		testPlayer("one-passed-low", minute(3), map[string]store.StageResult{
			"1": stageRun(4, 5, 1, true, minute(1)),
		}),
		// Nothing passed, but results: after every player who passed something.
		testPlayer("none-passed", minute(4), map[string]store.StageResult{
			"1": stageRun(1, 5, 1, false, minute(2)),
		}),
	}
	// Input order must not matter.
	slices.Reverse(players)

	ranked := rankPlayers(players, rankingStageCounts)
	want := []string{"two-passed", "one-passed-early", "one-passed-high", "one-passed-low", "none-passed"}
	if got := playerIDs(ranked); !slices.Equal(got, want) {
		t.Fatalf("order %v, want %v", got, want)
	}
	if got, want := playerRanks(ranked), []int{1, 2, 3, 4, 5}; !slices.Equal(got, want) {
		t.Fatalf("ranks %v, want %v", got, want)
	}

	first := ranked[0]
	if first.StagesPassed != 2 || first.Correct != 12 || first.Possible != 20 || first.Attempts != 3 {
		t.Errorf("totals of the leader: %+v", first)
	}
	if first.Stages["2"] != (stageScore{Correct: 7, Total: 10, Passed: true, Attempts: 2}) {
		t.Errorf("stage 2 of the leader: %+v", first.Stages["2"])
	}
}

func TestRankPlayersTiesShareARank(t *testing.T) {
	same := func() map[string]store.StageResult {
		return map[string]store.StageResult{
			"1": stageRun(5, 5, 1, true, minute(10)),
			"2": stageRun(8, 10, 1, true, minute(12)),
		}
	}
	players := []store.Player{
		testPlayer("c", minute(2), same()),
		testPlayer("b", minute(1), same()),
		testPlayer("a", minute(1), same()), // joined in the same instant as b: the id decides
		// Same score a minute later: not a tie.
		testPlayer("later", minute(0), map[string]store.StageResult{
			"1": stageRun(5, 5, 1, true, minute(10)),
			"2": stageRun(8, 10, 1, true, minute(13)),
		}),
		testPlayer("worse", minute(0), map[string]store.StageResult{"1": stageRun(5, 5, 1, true, minute(1))}),
		testPlayer("worse-too", minute(5), map[string]store.StageResult{"1": stageRun(5, 5, 1, true, minute(1))}),
	}

	ranked := rankPlayers(players, rankingStageCounts)
	if got, want := playerIDs(ranked), []string{"a", "b", "c", "later", "worse", "worse-too"}; !slices.Equal(got, want) {
		t.Fatalf("order %v, want %v", got, want)
	}
	// Competition ranking: three share 1st, so the next is 4th, and the last two share 5th.
	if got, want := playerRanks(ranked), []int{1, 1, 1, 4, 5, 5}; !slices.Equal(got, want) {
		t.Fatalf("ranks %v, want %v", got, want)
	}
}

func TestRankPlayersWithoutResultsComeLastUnranked(t *testing.T) {
	players := []store.Player{
		testPlayer("late", minute(9), nil),
		testPlayer("early", minute(1), map[string]store.StageResult{}),
		testPlayer("played", minute(5), map[string]store.StageResult{"1": stageRun(0, 5, 1, false, minute(6))}),
		// A result for a stage the assignment does not have counts for nothing.
		testPlayer("ghost", minute(3), map[string]store.StageResult{"6": stageRun(5, 5, 1, true, minute(4))}),
	}

	ranked := rankPlayers(players, rankingStageCounts)
	if got, want := playerIDs(ranked), []string{"played", "early", "ghost", "late"}; !slices.Equal(got, want) {
		t.Fatalf("order %v, want %v", got, want)
	}
	// Having played a stage and got nothing right still earns a place, unlike not having played.
	if got, want := playerRanks(ranked), []int{1, -1, -1, -1}; !slices.Equal(got, want) {
		t.Fatalf("ranks %v, want %v", got, want)
	}
	for _, r := range ranked[1:] {
		if r.Stages == nil || len(r.Stages) != 0 || r.Possible != 20 || r.StagesPassed != 0 || r.Correct != 0 ||
			r.Attempts != 0 || r.ReachedAt != nil || r.LastPlayedAt != nil {
			t.Errorf("%s should be an empty row: %+v", r.ID, r)
		}
	}
}

func TestRankPlayersIgnoresStagesTheAssignmentLacks(t *testing.T) {
	p := testPlayer("a", minute(0), map[string]store.StageResult{
		"1": stageRun(5, 5, 2, true, minute(3)),
		"6": stageRun(5, 5, 4, true, minute(99)),
	})
	ranked := rankPlayers([]store.Player{p}, rankingStageCounts)
	r := ranked[0]
	if len(r.Stages) != 1 || r.StagesPassed != 1 || r.Correct != 5 || r.Attempts != 2 {
		t.Fatalf("stage 6 leaked into %+v", r)
	}
	if r.ReachedAt == nil || !r.ReachedAt.Equal(minute(3)) {
		t.Fatalf("reachedAt %v, want the last counted stage's time", r.ReachedAt)
	}
}

func TestRankPlayersReachedAtIsTheLatestBestAt(t *testing.T) {
	last := minute(30)
	p := testPlayer("a", minute(0), map[string]store.StageResult{
		"1": stageRun(5, 5, 1, true, minute(10)),
		"2": stageRun(7, 10, 1, true, last),
		"3": stageRun(1, 5, 1, false, minute(20)),
	})
	p.LastPlayedAt = &last
	r := rankPlayers([]store.Player{p}, rankingStageCounts)[0]
	if r.ReachedAt == nil || !r.ReachedAt.Equal(last) || r.LastPlayedAt == nil || !r.LastPlayedAt.Equal(last) {
		t.Fatalf("reachedAt %v, lastPlayedAt %v", r.ReachedAt, r.LastPlayedAt)
	}
	if r.Correct != 13 || r.Attempts != 3 || r.StagesPassed != 2 {
		t.Fatalf("sums wrong: %+v", r)
	}
}

func TestRankPlayersJSONShape(t *testing.T) {
	ranked := rankPlayers([]store.Player{
		testPlayer("played", minute(0), map[string]store.StageResult{"1": stageRun(4, 5, 1, true, minute(2))}),
		testPlayer("idle", minute(1), nil),
	}, rankingStageCounts)
	raw, err := json.Marshal(ranked)
	if err != nil {
		t.Fatal(err)
	}
	var rows []map[string]any
	if err := json.Unmarshal(raw, &rows); err != nil {
		t.Fatal(err)
	}

	wantKeys := []string{"attempts", "correct", "id", "joinedAt", "lastPlayedAt", "name", "possible", "rank",
		"reachedAt", "stages", "stagesPassed"}
	for _, row := range rows {
		var keys []string
		for k := range row {
			keys = append(keys, k)
		}
		slices.Sort(keys)
		if !slices.Equal(keys, wantKeys) {
			t.Fatalf("keys %v, want %v", keys, wantKeys)
		}
	}
	if rows[0]["rank"] != float64(1) || rows[0]["reachedAt"] != "2026-10-14T09:02:00Z" || rows[0]["lastPlayedAt"] != nil {
		t.Errorf("played row: %v", rows[0])
	}
	stage := rows[0]["stages"].(map[string]any)["1"].(map[string]any)
	if stage["correct"] != float64(4) || stage["total"] != float64(5) || stage["passed"] != true || stage["attempts"] != float64(1) {
		t.Errorf("stage 1: %v", stage)
	}
	// Unranked and unplayed: null where there is nothing, never a missing key or a null stages object.
	if rows[1]["rank"] != nil || rows[1]["reachedAt"] != nil || rows[1]["lastPlayedAt"] != nil {
		t.Errorf("idle row: %v", rows[1])
	}
	if stages, ok := rows[1]["stages"].(map[string]any); !ok || len(stages) != 0 {
		t.Errorf("idle row stages: %v", rows[1]["stages"])
	}
}

func TestRankPlayersEmptyIsNotNull(t *testing.T) {
	raw, err := json.Marshal(rankPlayers(nil, rankingStageCounts))
	if err != nil || string(raw) != "[]" {
		t.Fatalf("got %s, %v", raw, err)
	}
}
