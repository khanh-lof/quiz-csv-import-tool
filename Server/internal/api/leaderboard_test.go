package api

import (
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"testing"
	"time"

	"quiz-csv-import-tool/server/internal/store"
)

var leaderboardBase = time.Date(2026, time.October, 14, 9, 0, 0, 0, time.UTC)

// minute is a moment the given number of minutes after the start of the lesson.
func minute(minutes int) time.Time { return leaderboardBase.Add(time.Duration(minutes) * time.Minute) }

// stageRun is a stage result: the best score, how many times it was played and when it was reached.
func stageRun(correct, total, attempts int, passed bool, bestAt time.Time) store.StageResult {
	return store.StageResult{Correct: correct, Total: total, Attempts: attempts, Passed: passed, BestAt: bestAt}
}

func testPlayer(id string, joined time.Time, stages map[string]store.StageResult) store.Player {
	return store.Player{ID: id, Name: strings.ToUpper(id), JoinedAt: joined, Stages: stages}
}

// withAvatar is the player with an avatar picked.
func withAvatar(p store.Player, avatar string) store.Player {
	p.Avatar = avatar
	return p
}

func entryIDs(entries []leaderboardEntry) []string {
	out := make([]string, len(entries))
	for i, r := range entries {
		out[i] = r.ID
	}
	return out
}

func entryRanks(entries []leaderboardEntry) []int {
	out := make([]int, len(entries))
	for i, r := range entries {
		out[i] = -1
		if r.Rank != nil {
			out[i] = *r.Rank
		}
	}
	return out
}

var leaderboardStageCounts = map[string]int{"1": 5, "2": 10, "3": 5}

func TestLeaderboardOrder(t *testing.T) {
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

	entries := buildLeaderboard(players, leaderboardStageCounts)
	want := []string{"two-passed", "one-passed-early", "one-passed-high", "one-passed-low", "none-passed"}
	if got := entryIDs(entries); !slices.Equal(got, want) {
		t.Fatalf("order %v, want %v", got, want)
	}
	if got, want := entryRanks(entries), []int{1, 2, 3, 4, 5}; !slices.Equal(got, want) {
		t.Fatalf("ranks %v, want %v", got, want)
	}

	first := entries[0]
	if first.StagesPassed != 2 || first.Correct != 12 || first.Possible != 20 || first.Attempts != 3 {
		t.Errorf("totals of the leader: %+v", first)
	}
	if first.Stages["2"] != (stageScore{Correct: 7, Total: 10, Passed: true, Attempts: 2}) {
		t.Errorf("stage 2 of the leader: %+v", first.Stages["2"])
	}
}

func TestLeaderboardTiesShareARank(t *testing.T) {
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

	entries := buildLeaderboard(players, leaderboardStageCounts)
	if got, want := entryIDs(entries), []string{"a", "b", "c", "later", "worse", "worse-too"}; !slices.Equal(got, want) {
		t.Fatalf("order %v, want %v", got, want)
	}
	// Ranks are numbered like a race: three share 1st, so the next is 4th, and the last two share 5th.
	if got, want := entryRanks(entries), []int{1, 1, 1, 4, 5, 5}; !slices.Equal(got, want) {
		t.Fatalf("ranks %v, want %v", got, want)
	}
}

func TestLeaderboardWithoutResultsComeLastUnranked(t *testing.T) {
	players := []store.Player{
		testPlayer("late", minute(9), nil),
		testPlayer("early", minute(1), map[string]store.StageResult{}),
		testPlayer("played", minute(5), map[string]store.StageResult{"1": stageRun(0, 5, 1, false, minute(6))}),
		// A result for a stage the assignment does not have counts for nothing.
		testPlayer("ghost", minute(3), map[string]store.StageResult{"6": stageRun(5, 5, 1, true, minute(4))}),
	}

	entries := buildLeaderboard(players, leaderboardStageCounts)
	if got, want := entryIDs(entries), []string{"played", "early", "ghost", "late"}; !slices.Equal(got, want) {
		t.Fatalf("order %v, want %v", got, want)
	}
	// Having played a stage and got nothing right still earns a place, unlike not having played.
	if got, want := entryRanks(entries), []int{1, -1, -1, -1}; !slices.Equal(got, want) {
		t.Fatalf("ranks %v, want %v", got, want)
	}
	for _, r := range entries[1:] {
		if r.Stages == nil || len(r.Stages) != 0 || r.Possible != 20 || r.StagesPassed != 0 || r.Correct != 0 ||
			r.Attempts != 0 || r.ReachedAt != nil || r.LastPlayedAt != nil {
			t.Errorf("%s should be an empty row: %+v", r.ID, r)
		}
	}
}

func TestLeaderboardIgnoresStagesTheAssignmentLacks(t *testing.T) {
	p := testPlayer("a", minute(0), map[string]store.StageResult{
		"1": stageRun(5, 5, 2, true, minute(3)),
		"6": stageRun(5, 5, 4, true, minute(99)),
	})
	entries := buildLeaderboard([]store.Player{p}, leaderboardStageCounts)
	r := entries[0]
	if len(r.Stages) != 1 || r.StagesPassed != 1 || r.Correct != 5 || r.Attempts != 2 {
		t.Fatalf("stage 6 leaked into %+v", r)
	}
	if r.ReachedAt == nil || !r.ReachedAt.Equal(minute(3)) {
		t.Fatalf("reachedAt %v, want the last counted stage's time", r.ReachedAt)
	}
}

func TestLeaderboardReachedAtIsTheLatestBestAt(t *testing.T) {
	last := minute(30)
	p := testPlayer("a", minute(0), map[string]store.StageResult{
		"1": stageRun(5, 5, 1, true, minute(10)),
		"2": stageRun(7, 10, 1, true, last),
		"3": stageRun(1, 5, 1, false, minute(20)),
	})
	p.LastPlayedAt = &last
	r := buildLeaderboard([]store.Player{p}, leaderboardStageCounts)[0]
	if r.ReachedAt == nil || !r.ReachedAt.Equal(last) || r.LastPlayedAt == nil || !r.LastPlayedAt.Equal(last) {
		t.Fatalf("reachedAt %v, lastPlayedAt %v", r.ReachedAt, r.LastPlayedAt)
	}
	if r.Correct != 13 || r.Attempts != 3 || r.StagesPassed != 2 {
		t.Fatalf("sums wrong: %+v", r)
	}
}

func TestLeaderboardJSONShape(t *testing.T) {
	entries := buildLeaderboard([]store.Player{
		withAvatar(testPlayer("played", minute(0), map[string]store.StageResult{"1": stageRun(4, 5, 1, true, minute(2))}), "panda"),
		testPlayer("idle", minute(1), nil),
	}, leaderboardStageCounts)
	raw, err := json.Marshal(entries)
	if err != nil {
		t.Fatal(err)
	}
	var rows []map[string]any
	if err := json.Unmarshal(raw, &rows); err != nil {
		t.Fatal(err)
	}

	wantKeys := []string{"attempts", "avatar", "correct", "id", "joinedAt", "lastPlayedAt", "name", "possible", "rank",
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
	if rows[0]["rank"] != float64(1) || rows[0]["reachedAt"] != "2026-10-14T09:02:00Z" || rows[0]["lastPlayedAt"] != nil ||
		rows[0]["avatar"] != "panda" {
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
	// No avatar is an empty string, never null or a missing key.
	if rows[1]["avatar"] != "" {
		t.Errorf("idle row avatar: %#v", rows[1]["avatar"])
	}
	if stages, ok := rows[1]["stages"].(map[string]any); !ok || len(stages) != 0 {
		t.Errorf("idle row stages: %v", rows[1]["stages"])
	}
}

func TestLeaderboardEmptyIsNotNull(t *testing.T) {
	raw, err := json.Marshal(buildLeaderboard(nil, leaderboardStageCounts))
	if err != nil || string(raw) != "[]" {
		t.Fatalf("got %s, %v", raw, err)
	}
}

func TestLeaderboardCarriesTheAvatar(t *testing.T) {
	entries := buildLeaderboard([]store.Player{
		withAvatar(testPlayer("fox", minute(0), map[string]store.StageResult{"1": stageRun(5, 5, 1, true, minute(1))}), "fox"),
		withAvatar(testPlayer("idle", minute(1), nil), "owl"),
		testPlayer("none", minute(2), nil),
	}, leaderboardStageCounts)
	var got []string
	for _, e := range entries {
		got = append(got, e.Avatar)
	}
	if want := []string{"fox", "owl", ""}; !slices.Equal(got, want) {
		t.Fatalf("avatars %q, want %q", got, want)
	}
}

// ---- the students' board ----

// racer is a player who passed stage 1 with full marks at the given minute: players who reached it at
// different minutes are ranked one after the other, those who reached it at the same minute are tied.
func racer(id string, reached int) store.Player {
	p := testPlayer(id, minute(0), map[string]store.StageResult{"1": stageRun(5, 5, 1, true, minute(reached))})
	p.Name = "Name " + id
	return withAvatar(p, "panda")
}

// idler is a player who has joined and played nothing.
func idler(id string) store.Player {
	p := testPlayer(id, minute(0), nil)
	p.Name = "Name " + id
	return p
}

// studentBoardOf is the board that the student with player id youID sees of the players.
func studentBoardOf(players []store.Player, youID string) studentBoard {
	return newStudentBoard(buildLeaderboard(players, leaderboardStageCounts), youID, leaderboardStageCounts)
}

func boardRanks(b studentBoard) []int {
	out := make([]int, len(b.Top))
	for i, row := range b.Top {
		out[i] = row.Rank
	}
	return out
}

func boardNames(b studentBoard) []string {
	out := make([]string, len(b.Top))
	for i, row := range b.Top {
		out[i] = row.Name
	}
	return out
}

func TestStudentBoardIsTheTopFive(t *testing.T) {
	var players []store.Player
	for i, id := range []string{"a", "b", "c", "d", "e", "f", "g"} {
		players = append(players, racer(id, i+1))
	}
	players = append(players, idler("idle"))

	board := studentBoardOf(players, "")
	if got, want := boardRanks(board), []int{1, 2, 3, 4, 5}; !slices.Equal(got, want) {
		t.Fatalf("ranks %v, want %v", got, want)
	}
	if got, want := boardNames(board), []string{"Name a", "Name b", "Name c", "Name d", "Name e"}; !slices.Equal(got, want) {
		t.Fatalf("names %v, want %v", got, want)
	}
	first := board.Top[0]
	if first.Avatar != "panda" || first.StagesPassed != 1 || first.Correct != 5 || first.You {
		t.Errorf("first row %+v", first)
	}
	// The class is counted whole, and the questions are those of the assignment's stages.
	if board.PlayerCount != 8 || board.Possible != 20 || board.StageCount != 3 {
		t.Errorf("counts %+v", board)
	}
	if board.You != nil {
		t.Errorf("you for nobody: %+v", board.You)
	}
}

func TestStudentBoardTieForFifthAddsRows(t *testing.T) {
	players := []store.Player{
		racer("a", 1), racer("b", 2), racer("c", 3), racer("d", 4),
		racer("e", 5), racer("f", 5), racer("g", 5), // three share 5th place
		racer("h", 6), // 8th: not on the board
	}
	board := studentBoardOf(players, "")
	if got, want := boardRanks(board), []int{1, 2, 3, 4, 5, 5, 5}; !slices.Equal(got, want) {
		t.Fatalf("ranks %v, want %v", got, want)
	}
	if got, want := boardNames(board), []string{"Name a", "Name b", "Name c", "Name d", "Name e", "Name f", "Name g"}; !slices.Equal(got, want) {
		t.Fatalf("names %v, want %v", got, want)
	}
}

func TestStudentBoardNeverHasMoreThanTenRows(t *testing.T) {
	// A class that all tie for first place would list everyone without the cap.
	var tied []store.Player
	for i := range 14 {
		tied = append(tied, racer(fmt.Sprintf("t%02d", i), 1))
	}
	board := studentBoardOf(tied, "")
	if len(board.Top) != studentBoardMaxRows || board.PlayerCount != 14 {
		t.Fatalf("%d rows for %d players", len(board.Top), board.PlayerCount)
	}
	for _, row := range board.Top {
		if row.Rank != 1 {
			t.Errorf("row %+v", row)
		}
	}

	// A tie for fifth that would pass ten rows is cut at ten too.
	players := []store.Player{racer("a", 1), racer("b", 2), racer("c", 3), racer("d", 4)}
	for i := range 9 {
		players = append(players, racer(fmt.Sprintf("t%02d", i), 5))
	}
	board = studentBoardOf(players, "")
	if got, want := boardRanks(board), []int{1, 2, 3, 4, 5, 5, 5, 5, 5, 5}; !slices.Equal(got, want) {
		t.Fatalf("ranks %v, want %v", got, want)
	}
}

func TestStudentBoardYouInsideTheTop(t *testing.T) {
	players := []store.Player{racer("a", 1), racer("b", 2), racer("c", 3), idler("idle")}
	board := studentBoardOf(players, "b")

	if board.You == nil || board.You.Rank == nil || *board.You.Rank != 2 || board.You.Name != "Name b" ||
		board.You.Avatar != "panda" || board.You.StagesPassed != 1 || board.You.Correct != 5 {
		t.Fatalf("you %+v", board.You)
	}
	for _, row := range board.Top {
		if row.You != (row.Name == "Name b") {
			t.Errorf("row %+v", row)
		}
	}
}

func TestStudentBoardYouOutsideTheTop(t *testing.T) {
	var players []store.Player
	for i := range 8 {
		players = append(players, racer(fmt.Sprintf("p%d", i), i+1))
	}
	board := studentBoardOf(players, "p6")

	if board.You == nil || board.You.Rank == nil || *board.You.Rank != 7 || board.You.Name != "Name p6" {
		t.Fatalf("you %+v", board.You)
	}
	if len(board.Top) != 5 {
		t.Fatalf("%d rows", len(board.Top))
	}
	for _, row := range board.Top {
		if row.You {
			t.Errorf("a row of the top is marked as the reader's own: %+v", row)
		}
	}
}

func TestStudentBoardYouWithoutAResultHasNoRank(t *testing.T) {
	board := studentBoardOf([]store.Player{racer("a", 1), idler("idle")}, "idle")
	if board.You == nil || board.You.Rank != nil || board.You.Name != "Name idle" || board.You.Correct != 0 {
		t.Fatalf("you %+v", board.You)
	}
	if got := boardNames(board); !slices.Equal(got, []string{"Name a"}) {
		t.Fatalf("names %v", got)
	}
}

func TestStudentBoardYouNotOnTheLeaderboardIsNull(t *testing.T) {
	players := []store.Player{racer("a", 1)}
	for _, youID := range []string{"", "ghost"} {
		if board := studentBoardOf(players, youID); board.You != nil || board.Top[0].You {
			t.Errorf("youID %q: you %+v, row %+v", youID, board.You, board.Top[0])
		}
	}
}

func TestStudentBoardOfAnEmptyClass(t *testing.T) {
	raw, err := json.Marshal(studentBoardOf(nil, ""))
	if err != nil {
		t.Fatal(err)
	}
	// An empty top is an empty array and nobody to be is null, never a missing key.
	want := `{"top":[],"you":null,"possible":20,"stageCount":3,"playerCount":0}`
	if string(raw) != want {
		t.Fatalf("got %s, want %s", raw, want)
	}
	// Players who have joined but not played give an empty top too, with the class counted.
	board := studentBoardOf([]store.Player{idler("a"), idler("b")}, "")
	if len(board.Top) != 0 || board.PlayerCount != 2 {
		t.Fatalf("board %+v", board)
	}
}

func TestStudentBoardJSONShape(t *testing.T) {
	players := []store.Player{racer("id-0001", 1), racer("id-0002", 2)}
	players[0].Name, players[1].Name = "Lan", "Mai"
	raw, err := json.Marshal(studentBoardOf(players, "id-0002"))
	if err != nil {
		t.Fatal(err)
	}
	// Nobody's player id is in what a classmate reads.
	if strings.Contains(string(raw), "id-000") {
		t.Fatalf("a player id leaked: %s", raw)
	}
	var board map[string]any
	if err := json.Unmarshal(raw, &board); err != nil {
		t.Fatal(err)
	}
	if got, want := keysOf(board), []string{"playerCount", "possible", "stageCount", "top", "you"}; !slices.Equal(got, want) {
		t.Fatalf("keys %v, want %v", got, want)
	}
	top := board["top"].([]any)
	if len(top) != 2 {
		t.Fatalf("top %v", top)
	}
	for _, row := range top {
		if got, want := keysOf(row.(map[string]any)), []string{"avatar", "correct", "name", "rank", "stagesPassed", "you"}; !slices.Equal(got, want) {
			t.Fatalf("row keys %v, want %v", got, want)
		}
	}
	you := board["you"].(map[string]any)
	if got, want := keysOf(you), []string{"avatar", "correct", "name", "rank", "stagesPassed"}; !slices.Equal(got, want) {
		t.Fatalf("you keys %v, want %v", got, want)
	}
	if you["name"] != "Mai" || you["rank"] != float64(2) || you["avatar"] != "panda" || you["correct"] != float64(5) || you["stagesPassed"] != float64(1) {
		t.Errorf("you %v", you)
	}
	if first := top[0].(map[string]any); first["name"] != "Lan" || first["you"] != false || top[1].(map[string]any)["you"] != true {
		t.Errorf("rows %v", top)
	}
	if board["possible"] != float64(20) || board["stageCount"] != float64(3) || board["playerCount"] != float64(2) {
		t.Errorf("counts %v", board)
	}
}

// A run counts as an attempt from the moment it starts, so a stage's attempts are what the player started,
// or what the results say for a player from before runs were dealt by the server. A run that was started
// and never finished is an attempt with no score: it adds to the attempts and ranks nobody.
func TestLeaderboardCountsStartedRunsAsAttempts(t *testing.T) {
	finishedOnce := testPlayer("finished-once", minute(0), map[string]store.StageResult{
		"1": stageRun(5, 5, 1, true, minute(5)),
	})
	finishedOnce.Started = map[string]int{"1": 3, "2": 1, "9": 4} // two stage 1 runs left, one of stage 2, and a stage the quiz lacks
	legacy := testPlayer("legacy", minute(1), map[string]store.StageResult{
		"1": stageRun(4, 5, 6, true, minute(6)),
	}) // no Started: its attempts are the ones in its results
	ahead := testPlayer("ahead", minute(2), map[string]store.StageResult{
		"1": stageRun(3, 5, 1, false, minute(7)),
	})
	ahead.Started = map[string]int{"1": 2}
	abandoned := testPlayer("abandoned", minute(3), map[string]store.StageResult{})
	abandoned.Started = map[string]int{"1": 2, "3": 1}

	entries := buildLeaderboard([]store.Player{abandoned, ahead, legacy, finishedOnce}, leaderboardStageCounts)
	if got, want := entryIDs(entries), []string{"finished-once", "legacy", "ahead", "abandoned"}; !slices.Equal(got, want) {
		t.Fatalf("order %v, want %v", got, want)
	}
	// Ranking uses the finished runs alone: the player who only started runs is last and unranked.
	if got, want := entryRanks(entries), []int{1, 2, 3, -1}; !slices.Equal(got, want) {
		t.Fatalf("ranks %v, want %v", got, want)
	}

	byID := map[string]leaderboardEntry{}
	for _, e := range entries {
		byID[e.ID] = e
	}
	// Three started in stage 1 and one in stage 2 that was never finished: four attempts, one score; the
	// run of a stage the assignment lacks is not counted.
	if e := byID["finished-once"]; e.Attempts != 4 || e.Stages["1"].Attempts != 3 || len(e.Stages) != 1 || e.Correct != 5 {
		t.Errorf("finished-once %+v", e)
	}
	if e := byID["legacy"]; e.Attempts != 6 || e.Stages["1"].Attempts != 6 {
		t.Errorf("legacy %+v", e)
	}
	if e := byID["ahead"]; e.Attempts != 2 || e.Stages["1"].Attempts != 2 {
		t.Errorf("ahead %+v", e)
	}
	if e := byID["abandoned"]; e.Attempts != 3 || len(e.Stages) != 0 || e.Correct != 0 || e.ReachedAt != nil || e.Rank != nil {
		t.Errorf("abandoned %+v", e)
	}
}
