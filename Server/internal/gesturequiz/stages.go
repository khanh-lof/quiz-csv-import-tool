// Package gesturequiz is the server's reading of a Game quiz: the CSV the AI wrote, split into questions
// by stage, with the stage table and the time limits the game plays by. It is a port of the client's own
// parser (Client/src/models/gesture-quiz.ts, services/csv-import.service.ts's parseCsvRows, services/
// ai-csv.service.ts's extractCsvContent, game/stages.ts), and the two are kept in step by hand: a shared
// assignment is judged here, so what counts as a question must be what the page of a teacher's preview and
// of a file opened on /play would have made of the same CSV. How long a question lasts is not kept in step
// with anything: a shared quiz is timed by the server alone (see DefaultSeconds).
package gesturequiz

import "time"

// The stages the game knows. The stage number is the game's identity everywhere it is stored or sent.
const (
	FirstStage     = 1
	LastStage      = 6
	TrueFalseStage = 1
	WordOrderStage = 6
)

// Stage is one stage of the game: how many answers the player picks from (0 for the sentence-ordering
// stage, which has chunks instead).
type Stage struct {
	Number      int
	OptionCount int
}

// stages is the client's STAGES table, easiest to hardest.
var stages = [...]Stage{
	{Number: 1, OptionCount: 2},
	{Number: 2, OptionCount: 2},
	{Number: 3, OptionCount: 3},
	{Number: 4, OptionCount: 3},
	{Number: 5, OptionCount: 4},
	{Number: 6, OptionCount: 0},
}

// StageByNumber returns the stage with that number, and false for anything outside 1 to 6.
func StageByNumber(number int) (Stage, bool) {
	if number < FirstStage || number > LastStage {
		return Stage{}, false
	}
	return stages[number-1], true
}

// DefaultSeconds is how many seconds a question of each stage (1 to 6, in order) lasts in the standard time
// mode when the server is not configured otherwise (GAME_STAGE_SECONDS). The server is the only clock a
// shared quiz has, so the page is told the limits, never given a table of its own.
var DefaultSeconds = [LastStage]int{12, 12, 15, 15, 20, 45}

// The most and the fewest seconds a stage may be given in the configuration: below the fewest a question
// could not be read, above the most it is no time limit at all.
const (
	MinSeconds = 5
	MaxSeconds = 600
)

// The time modes of an assignment: how long a student gets per question.
const (
	TimeStandard  = "standard"
	TimeExtra     = "extra"
	TimeUnlimited = "unlimited"
)

// LimitSeconds is how many seconds a question that lasts `seconds` in the standard mode lasts in the time
// mode, and false when there is no limit (the unlimited mode). Extra time is the standard seconds times 1.5
// rounded half up, which in integers is (3*s+1)/2: 12, 15, 20 and 45 seconds become 18, 23, 30 and 68. Any
// other mode reads as the standard one.
func LimitSeconds(seconds int, mode string) (int, bool) {
	switch mode {
	case TimeUnlimited:
		return 0, false
	case TimeExtra:
		return (seconds*3 + 1) / 2, true
	}
	return seconds, true
}

// TimeLimit is LimitSeconds as a duration.
func TimeLimit(seconds int, mode string) (time.Duration, bool) {
	limit, limited := LimitSeconds(seconds, mode)
	return time.Duration(limit) * time.Second, limited
}
