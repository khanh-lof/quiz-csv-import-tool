package gesturequiz

import (
	"fmt"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"
)

// parseCSV is the client spec's own helper: the rows of the CSV, then the quiz of them.
func parseCSV(csv string) *Quiz { return FromRows(SplitRows(csv)) }

func stagesOf(q *Quiz) []int {
	var out []int
	for stage, questions := range q.Stages {
		if len(questions) > 0 {
			out = append(out, stage)
		}
	}
	slices.Sort(out)
	return out
}

func questionsOf(q *Quiz, stage int) []string {
	var out []string
	for _, question := range q.Stages[stage] {
		out = append(out, question.Question)
	}
	return out
}

func TestGroupsQuestionsByStageAndKeepsCSVOrder(t *testing.T) {
	quiz := parseCSV(strings.Join([]string{
		"3,Q3a,A,B,C,,e",
		"1,Q1a,Đúng,,,,e",
		"3,Q3b,A,B,C,,e",
		"1,Q1b,Sai,,,,e",
	}, "\n"))

	if got := stagesOf(quiz); !slices.Equal(got, []int{1, 3}) {
		t.Fatalf("stages %v", got)
	}
	if got := questionsOf(quiz, 1); !slices.Equal(got, []string{"Q1a", "Q1b"}) {
		t.Errorf("stage 1: %v", got)
	}
	if got := questionsOf(quiz, 3); !slices.Equal(got, []string{"Q3a", "Q3b"}) {
		t.Errorf("stage 3: %v", got)
	}
	if quiz.Count(2) != 0 || quiz.Total() != 4 || quiz.Skipped != 0 {
		t.Errorf("count %d, total %d, skipped %d", quiz.Count(2), quiz.Total(), quiz.Skipped)
	}
	if got := quiz.StageCounts(); !reflect.DeepEqual(got, map[string]int{"1": 2, "3": 2}) {
		t.Errorf("stage counts %v", got)
	}
}

func TestKeepsTheExplanation(t *testing.T) {
	quiz := parseCSV("2,Q,A,B,,,Vì sao")
	want := Question{Stage: 2, Question: "Q", Correct: "A", Wrong: []string{"B"}, Explanation: "Vì sao"}
	if got := quiz.Stages[2][0]; !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v, want %+v", got, want)
	}
}

func TestReadsTheStageAsTheFirstIntegerOfTheFirstCell(t *testing.T) {
	quiz := parseCSV(strings.Join([]string{"Stage 2,Q,A,B,,,", " 4 ,Q,A,B,C,,"}, "\n"))
	if got := stagesOf(quiz); !slices.Equal(got, []int{2, 4}) {
		t.Fatalf("stages %v", got)
	}
}

func TestSkipsRowsWhoseStageIsMissingOrOutOfRange(t *testing.T) {
	quiz := parseCSV(strings.Join([]string{
		"0,Q,A,B,,,",
		"7,Q,A,B,,,",
		"x,Q,A,B,,,",
		",Q,A,B,,,",
		"2,Q,A,B,,,",
	}, "\n"))
	if quiz.Total() != 1 || quiz.Skipped != 4 {
		t.Fatalf("total %d, skipped %d", quiz.Total(), quiz.Skipped)
	}
	// A number too long for an int is no stage either, and neither is 007.
	quiz = parseCSV("99999999999999999999999,Q,A,B,,,\n007,Q,A,B,,,\n02,Q,A,B,,,")
	if quiz.Total() != 1 || quiz.Skipped != 2 || quiz.Count(2) != 1 {
		t.Fatalf("total %d, skipped %d", quiz.Total(), quiz.Skipped)
	}
}

func TestSkipsRowsWithAnEmptyQuestion(t *testing.T) {
	quiz := parseCSV("2,,A,B,,,\n2,Q,A,B,,,")
	if quiz.Total() != 1 || quiz.Skipped != 1 {
		t.Fatalf("total %d, skipped %d", quiz.Total(), quiz.Skipped)
	}
}

func TestStage1(t *testing.T) {
	answerOf := func(cell string) string {
		quiz := parseCSV("1,Q," + cell + ",,,,")
		if quiz.Count(1) == 0 {
			return ""
		}
		return quiz.Stages[1][0].Correct
	}

	for _, cell := range []string{
		"Đúng", "đúng", "ĐÚNG", "Dung", "dung", "Đ", "True", "TRUE", "true", "对", "對", "Đúng.",
		// What the folding adds to the client spec's list: more spellings the same rules accept.
		"Đúng!", "Đúng。", "Đúng！", "  đúng . ", "Yes", "t", "正确", "正確", "✓", "✔", "Dui", "ＴＲＵＥ",
		// "Đúng" typed as D + a combining accent sequence still folds to the same word.
		"Đu" + string(rune(0x0301)) + "ng",
	} {
		if got := answerOf(cell); got != TrueAnswer {
			t.Errorf("%q folds to %q, want %q", cell, got, TrueAnswer)
		}
	}
	for _, cell := range []string{"Sai", "sai", "SAI", "False", "false", "错", "錯", "Sai.", "No", "f", "S", "错误", "錯誤", "✗", "✘", "Cuo"} {
		if got := answerOf(cell); got != FalseAnswer {
			t.Errorf("%q folds to %q, want %q", cell, got, FalseAnswer)
		}
	}

	quiz := parseCSV(strings.Join([]string{"1,Q,Có,,,,", "1,Q,Có thể,,,,", "1,Q,,,,,"}, "\n"))
	if quiz.Total() != 0 || quiz.Skipped != 3 {
		t.Errorf("other answers: total %d, skipped %d", quiz.Total(), quiz.Skipped)
	}

	// Wrong answers are dropped.
	if question := parseCSV("1,Q,Sai,x,y,z,").Stages[1][0]; len(question.Wrong) != 0 {
		t.Errorf("wrong answers kept: %v", question.Wrong)
	}
}

func TestStages2To5(t *testing.T) {
	t.Run("keeps exactly as many wrong answers as the stage needs", func(t *testing.T) {
		quiz := parseCSV(strings.Join([]string{"2,Q,A,B,C,D,", "3,Q,A,B,C,D,", "4,Q,A,B,C,D,", "5,Q,A,B,C,D,"}, "\n"))
		for stage, want := range map[int][]string{2: {"B"}, 3: {"B", "C"}, 4: {"B", "C"}, 5: {"B", "C", "D"}} {
			if got := quiz.Stages[stage][0].Wrong; !slices.Equal(got, want) {
				t.Errorf("stage %d: wrong %v, want %v", stage, got, want)
			}
		}
	})

	t.Run("skips a row with too few wrong answers", func(t *testing.T) {
		quiz := parseCSV(strings.Join([]string{"2,Q,A,,,,", "3,Q,A,B,,,", "4,Q,A,B,,,", "5,Q,A,B,C,,"}, "\n"))
		if quiz.Total() != 0 || quiz.Skipped != 4 {
			t.Fatalf("total %d, skipped %d", quiz.Total(), quiz.Skipped)
		}
	})

	t.Run("closes the gaps between wrong answers", func(t *testing.T) {
		if got := parseCSV("3,Q,A,,B,C,").Stages[3][0].Wrong; !slices.Equal(got, []string{"B", "C"}) {
			t.Fatalf("wrong %v", got)
		}
	})

	t.Run("drops wrong answers equal to the correct one and duplicates", func(t *testing.T) {
		if got := parseCSV("2,Q,A,A,B,B,").Stages[2][0].Wrong; !slices.Equal(got, []string{"B"}) {
			t.Errorf("wrong %v", got)
		}
		if got := parseCSV("3,Q,A,A,B,C,").Stages[3][0].Wrong; !slices.Equal(got, []string{"B", "C"}) {
			t.Errorf("wrong %v", got)
		}
		// A copy of the correct answer or of another wrong one does not count towards the number needed.
		if parseCSV("3,Q,A,A,B,B,").Skipped != 1 || parseCSV("5,Q,A,B,B,C,").Skipped != 1 {
			t.Error("a duplicate counted towards the wrong answers needed")
		}
	})

	t.Run("skips a row with no correct answer", func(t *testing.T) {
		quiz := parseCSV("2,Q,,B,,,")
		if quiz.Total() != 0 || quiz.Skipped != 1 {
			t.Fatalf("total %d, skipped %d", quiz.Total(), quiz.Skipped)
		}
	})
}

func TestStage6(t *testing.T) {
	t.Run("splits the answer into trimmed chunks", func(t *testing.T) {
		question := parseCSV("6,Tôi là người Việt Nam.,我 / 是 /越南人 ,,,,").Stages[6][0]
		if !slices.Equal(question.Chunks, []string{"我", "是", "越南人"}) || question.Correct != "我 / 是 / 越南人" || len(question.Wrong) != 0 {
			t.Fatalf("question %+v", question)
		}
	})

	t.Run("ignores empty chunks", func(t *testing.T) {
		if got := parseCSV("6,Q,我 / / 喝 / 茶 /,,,,").Stages[6][0].Chunks; !slices.Equal(got, []string{"我", "喝", "茶"}) {
			t.Fatalf("chunks %v", got)
		}
	})

	t.Run("needs between 2 and 8 chunks", func(t *testing.T) {
		quiz := parseCSV(strings.Join([]string{
			"6,Q,我,,,,",
			"6,Q,a / b,,,,",
			"6,Q,a / b / c / d / e / f / g / h,,,,",
			"6,Q,a / b / c / d / e / f / g / h / i,,,,",
		}, "\n"))
		var lengths []int
		for _, question := range quiz.Stages[6] {
			lengths = append(lengths, len(question.Chunks))
		}
		if !slices.Equal(lengths, []int{2, 8}) || quiz.Skipped != 2 {
			t.Fatalf("chunk counts %v, skipped %d", lengths, quiz.Skipped)
		}
	})
}

func TestSkipsAHeaderRowInAnyCaseWithoutCountingIt(t *testing.T) {
	for _, header := range []string{"Stage,Question,Correct Answer,Wrong Answer 1", "STAGE,Question", "  stage  ,Question"} {
		quiz := parseCSV(header + "\n1,Q,Đúng,,,,")
		if quiz.Total() != 1 || quiz.Skipped != 0 {
			t.Errorf("%q: total %d, skipped %d", header, quiz.Total(), quiz.Skipped)
		}
	}
}

func TestIgnoresEmptyRows(t *testing.T) {
	quiz := parseCSV(strings.Join([]string{"", "1,Q,Đúng,,,,", ",,,,,,", "   ", "2,Q,A,B,,,"}, "\n"))
	if quiz.Total() != 2 || quiz.Skipped != 0 {
		t.Fatalf("total %d, skipped %d", quiz.Total(), quiz.Skipped)
	}
}

func TestCountsTheRowsItDrops(t *testing.T) {
	quiz := parseCSV(strings.Join([]string{"1,Q,Đúng,,,,", "1,Q,Có,,,,", "2,Q,A,,,,", "9,Q,A,B,,,"}, "\n"))
	if quiz.Total() != 1 || quiz.Skipped != 3 {
		t.Fatalf("total %d, skipped %d", quiz.Total(), quiz.Skipped)
	}
}

func TestAnEmptyQuizHasNoStages(t *testing.T) {
	for _, raw := range []string{"", "   ", "Stage,Question", "not a quiz at all", "1,Q,Có,,,,"} {
		quiz := Parse(raw)
		if quiz.Total() != 0 || len(quiz.StageCounts()) != 0 {
			t.Errorf("%q: total %d, counts %v", raw, quiz.Total(), quiz.StageCounts())
		}
	}
}

func TestParseReadsWhatTheAIWrote(t *testing.T) {
	want := map[string]int{"1": 1, "2": 1}
	bom := string(rune(0xFEFF))
	for name, raw := range map[string]string{
		"plain":               "1,Q1,Đúng,,,,e\n2,Q2,A,B,,,e",
		"with a header":       "Stage,Question,Correct Answer,Wrong Answer 1,Wrong Answer 2,Wrong Answer 3,Explanation\n1,Q1,Đúng,,,,e\n2,Q2,A,B,,,e",
		"in a csv fence":      "Here is your quiz:\n```csv\n1,Q1,Đúng,,,,e\n2,Q2,A,B,,,e\n```\nEnjoy!",
		"in a bare fence":     "```\n1,Q1,Đúng,,,,e\n2,Q2,A,B,,,e\n```",
		"in an upper fence":   "```CSV\n1,Q1,Đúng,,,,e\n2,Q2,A,B,,,e\n```",
		"with a byte mark":    bom + "1,Q1,Đúng,,,,e\n2,Q2,A,B,,,e",
		"fenced, byte mark":   "```\n" + bom + "1,Q1,Đúng,,,,e\n2,Q2,A,B,,,e\n```",
		"with CRLF line ends": "1,Q1,Đúng,,,,e\r\n2,Q2,A,B,,,e\r\n",
		"with CR line ends":   "1,Q1,Đúng,,,,e\r2,Q2,A,B,,,e\r",
		"surrounded":          "\n\n  1,Q1,Đúng,,,,e\n2,Q2,A,B,,,e  \n\n",
	} {
		if got := Parse(raw).StageCounts(); !reflect.DeepEqual(got, want) {
			t.Errorf("%s: %v, want %v", name, got, want)
		}
	}
}

func TestExtractCSV(t *testing.T) {
	bom := string(rune(0xFEFF))
	tests := map[string]string{
		"":                                      "",
		"  \n ":                                 "",
		"  a,b\nc,d  ":                          "a,b\nc,d",
		"Here you go:\n```csv\na,b\n```\nEnjoy": "a,b",
		"```\na,b\n```":                         "a,b",
		"```CSV a,b ```":                        "a,b",
		"```csv\n  a,b\n\n```":                  "a,b",
		"Sure!\nCâu hỏi, Đáp án\nxin chào,你好": "Câu hỏi, Đáp án\nxin chào,你好",
		"câu hỏi ,  đáp án\nx,y":              "câu hỏi ,  đáp án\nx,y",
		"Question,Correct Answer\nWhat?,That": "Question,Correct Answer\nWhat?,That",
		// A fence with nothing in it does not win: the rest of the rules still apply.
		"```\n```\n1,Q,Đúng":     "```\n```\n1,Q,Đúng",
		bom + "1,Q,Đúng":         "1,Q,Đúng",
		"```\n" + bom + "a,b```": "a,b",
		// A header with a no-break space between its words is still a header.
		"x\nCâu hỏi," + string(rune(0xA0)) + "Đáp án\nq,a": "Câu hỏi," + string(rune(0xA0)) + "Đáp án\nq,a",
	}
	for in, want := range tests {
		if got := ExtractCSV(in); got != want {
			t.Errorf("ExtractCSV(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestSplitRows(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want [][]string
	}{
		{"nothing", "", nil},
		{"one row", "a,b,c", [][]string{{"a", "b", "c"}}},
		{"a trailing line break adds no row", "a,b\n", [][]string{{"a", "b"}}},
		{"a trailing comma adds an empty cell", "a,b,\n", [][]string{{"a", "b", ""}}},
		{"cells are trimmed", " a , b\t, c ", [][]string{{"a", "b", "c"}}},
		{"all three line ends", "a\nb\rc\r\nd", [][]string{{"a"}, {"b"}, {"c"}, {"d"}}},
		{"quotes keep commas and line breaks", "\"a,b\",\"c\nd\",e", [][]string{{"a,b", "c\nd", "e"}}},
		{"two quotes are one", "\"say \"\"hi\"\"\",x", [][]string{{"say \"hi\"", "x"}}},
		{"an empty quoted cell", "\"\",x", [][]string{{"", "x"}}},
		{"empty lines are empty rows", "a\n\nb", [][]string{{"a"}, {""}, {"b"}}},
		{"a lone CR inside quotes stays", "\"a\rb\",c", [][]string{{"a\rb", "c"}}},
		{"an unclosed quote runs to the end", "\"a,b\nc", [][]string{{"a,b\nc"}}},
		{"a quote in the middle of a cell toggles", "ab\"c,d\"e,f", [][]string{{"abc,de", "f"}}},
		{"chinese", "你好,世界\n", [][]string{{"你好", "世界"}}},
	}
	for _, tt := range tests {
		if got := SplitRows(tt.in); !reflect.DeepEqual(got, tt.want) {
			t.Errorf("%s: SplitRows(%q) = %q, want %q", tt.name, tt.in, got, tt.want)
		}
	}
}

func TestFoldAnswer(t *testing.T) {
	for in, want := range map[string]string{
		"Đúng":   "dung",
		"ĐÚNG.":  "dung",
		"  Sai ": "sai",
		"Sai!!":  "sai",
		"错。":     "错",
		"Yes\n":  "yes",
		"Cuối":   "cuoi",
	} {
		if got := foldAnswer(in); got != want {
			t.Errorf("foldAnswer(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestStageTable(t *testing.T) {
	want := []int{2, 2, 3, 3, 4, 0}
	for i, options := range want {
		def, ok := StageByNumber(i + 1)
		if !ok || def.Number != i+1 || def.OptionCount != options {
			t.Errorf("stage %d: %+v %v, want options %d", i+1, def, ok, options)
		}
	}
	for _, bad := range []int{-1, 0, 7, 100} {
		if _, ok := StageByNumber(bad); ok {
			t.Errorf("stage %d exists", bad)
		}
	}
	if DefaultSeconds != [6]int{12, 12, 15, 15, 20, 45} {
		t.Errorf("default seconds %v", DefaultSeconds)
	}
	for stage, seconds := range DefaultSeconds {
		if seconds < MinSeconds || seconds > MaxSeconds {
			t.Errorf("the default of stage %d, %d seconds, is outside %d to %d", stage+1, seconds, MinSeconds, MaxSeconds)
		}
	}
}

func TestTimeLimit(t *testing.T) {
	extra := []int{18, 18, 23, 23, 30, 68}
	for i, standard := range DefaultSeconds {
		if got, ok := TimeLimit(standard, TimeStandard); !ok || got != time.Duration(standard)*time.Second {
			t.Errorf("%d seconds standard: %v %v", standard, got, ok)
		}
		if got, ok := TimeLimit(standard, TimeExtra); !ok || got != time.Duration(extra[i])*time.Second {
			t.Errorf("%d seconds extra: %v %v, want %ds", standard, got, ok, extra[i])
		}
		if _, ok := TimeLimit(standard, TimeUnlimited); ok {
			t.Errorf("%d seconds unlimited has a limit", standard)
		}
		// Any other mode reads as the standard one.
		if got, ok := TimeLimit(standard, "turbo"); !ok || got != time.Duration(standard)*time.Second {
			t.Errorf("%d seconds with an unknown mode: %v %v", standard, got, ok)
		}
	}
	// The limit comes from the seconds it is given, whatever they are.
	if got, ok := TimeLimit(30, TimeStandard); !ok || got != 30*time.Second {
		t.Errorf("30 seconds: %v %v", got, ok)
	}
	if got, ok := TimeLimit(30, TimeExtra); !ok || got != 45*time.Second {
		t.Errorf("30 seconds extra: %v %v", got, ok)
	}
	if got, ok := LimitSeconds(7, TimeExtra); !ok || got != 11 { // 10.5 rounds up
		t.Errorf("7 seconds extra: %v %v", got, ok)
	}
	if got, ok := LimitSeconds(7, TimeStandard); !ok || got != 7 {
		t.Errorf("7 seconds: %v %v", got, ok)
	}
	if _, ok := LimitSeconds(7, TimeUnlimited); ok {
		t.Error("7 seconds unlimited has a limit")
	}
	// The integer rule is JavaScript's Math.round(seconds * 1.5) for every whole number of seconds.
	for seconds := 1; seconds <= 600; seconds++ {
		want := (seconds*3 + 1) / 2
		floatRound := int(float64(seconds)*1.5 + 0.5)
		if want != floatRound {
			t.Errorf("%d seconds: (3s+1)/2 = %d, rounding half up gives %d", seconds, want, floatRound)
		}
	}
}

func TestShuffleChunksNeverReturnsTheAnswer(t *testing.T) {
	answer := []string{"我", "是", "兰"}
	seen := map[string]bool{}
	for range 500 {
		mixed := ShuffleChunks(answer)
		if slices.Equal(mixed, answer) {
			t.Fatalf("the shuffle returned the answer: %v", mixed)
		}
		if len(mixed) != len(answer) {
			t.Fatalf("shuffle of %v is %v", answer, mixed)
		}
		sorted := slices.Sorted(slices.Values(mixed))
		if !slices.Equal(sorted, slices.Sorted(slices.Values(answer))) {
			t.Fatalf("shuffle of %v lost or added a chunk: %v", answer, mixed)
		}
		seen[fmt.Sprint(mixed)] = true
	}
	if len(seen) < 3 {
		t.Errorf("only %d different orders in 500 shuffles", len(seen))
	}
	if !slices.Equal(answer, []string{"我", "是", "兰"}) {
		t.Fatalf("the answer was changed: %v", answer)
	}

	// Pieces that are all alike have no other order, and the shuffle says so rather than looping.
	if got := ShuffleChunks([]string{"a", "a"}); !slices.Equal(got, []string{"a", "a"}) {
		t.Errorf("equal pieces: %v", got)
	}
	// Two pieces: the only other order is the swap.
	for range 50 {
		if got := ShuffleChunks([]string{"a", "b"}); !slices.Equal(got, []string{"b", "a"}) {
			t.Fatalf("two pieces: %v", got)
		}
	}
}
