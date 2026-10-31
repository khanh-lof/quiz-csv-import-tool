package csvgen

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"slices"
	"strings"
	"testing"
)

func TestParseCreativeOptions(t *testing.T) {
	// gesture builds the query of a GestureQuiz request with the given extra parameters.
	gesture := func(extra string) string {
		return "exportType=3&courseType=0&level=1&lessonNumbers=1&" + extra
	}
	// gestureIs checks the stages and the number of questions a gesture request parsed into.
	gestureIs := func(stages []int, questions int) func(Options) bool {
		return func(o Options) bool {
			return slices.Equal(o.GestureStages, stages) && o.QuestionsPerStage == questions
		}
	}
	all := []int{1, 2, 3, 4, 5, 6}
	tests := []struct {
		query   string
		wantErr string
		check   func(Options) bool
	}{
		{query: "exportType=2&courseType=0&level=4&lessonNumbers=7", check: func(o Options) bool {
			return o.ExportType == Wayground && o.CourseType == Hsk && *o.Level == 4 && slices.Equal(o.LessonNumbers, []int{7}) &&
				o.HskStandard == Hsk2 && // HSK 2.0 when no standard is sent
				o.CourseDisplayName() == "HSK 2.0 (the six-level standard), taught from 《HSK标准教程》 HSK Standard Course (Giáo trình chuẩn HSK)" && o.Intelligence == 1
		}},
		{query: "exportType=0&courseType=0&hskStandard=3&level=9&lessonNumbers=1", check: func(o Options) bool {
			return o.HskStandard == Hsk3 && *o.Level == 9 && strings.HasPrefix(o.CourseDisplayName(), "HSK 3.0 ")
		}},
		{query: "exportType=0&courseType=1&hskStandard=x&level=1&lessonNumbers=1", check: func(o Options) bool {
			return o.HskStandard == 0 // hskStandard only applies to HSK
		}},
		{query: "exportType=0&courseType=0&level=1&lessonNumbers=1&intelligence=1", check: func(o Options) bool {
			return o.Intelligence == 1
		}},
		{query: "exportType=0&courseType=0&level=1&lessonNumbers=1&intelligence=2", check: func(o Options) bool {
			return o.Intelligence == 2
		}},
		{query: "exportType=Blooket&courseType=yct&level=1&lessonNumbers=2", check: func(o Options) bool {
			return o.ExportType == Blooket && o.CourseType == Yct
		}},
		{query: "exportType=3&courseType=0&level=1&lessonNumbers=1", check: func(o Options) bool {
			return o.ExportType == GestureQuiz
		}},
		{query: "exportType=gesturequiz&courseType=0&level=1&lessonNumbers=1", check: func(o Options) bool {
			return o.ExportType == GestureQuiz
		}},
		{query: "exportType=GestureQuiz&courseType=0&level=1&lessonNumbers=1", check: func(o Options) bool {
			return o.ExportType == GestureQuiz
		}},
		// A gesture quiz with nothing chosen has every stage and the default number of questions.
		{query: gesture(""), check: gestureIs(all, 5)},
		{query: gesture("gestureStages=&questionsPerStage="), check: gestureIs(all, 5)},
		{query: gesture("gestureStages=+&questionsPerStage=+"), check: gestureIs(all, 5)},
		{query: gesture("gestureStages=3"), check: gestureIs([]int{3}, 5)},
		{query: gesture("gestureStages=1,2,3,4,5,6&questionsPerStage=7"), check: gestureIs(all, 7)},
		{query: gesture("gestureStages=%203,%201%20"), check: gestureIs([]int{1, 3}, 5)}, // trimmed and sorted
		{query: gesture("gestureStages=6,4"), check: gestureIs([]int{4, 6}, 5)},
		{query: gesture("questionsPerStage=4"), check: gestureIs(all, 4)},
		{query: gesture("questionsPerStage=10"), check: gestureIs(all, 10)},
		{query: gesture("questionsPerStage=%207%20"), check: gestureIs(all, 7)},
		{query: gesture("gestureStages=0"), wantErr: "Invalid gestureStages parameter."},
		{query: gesture("gestureStages=7"), wantErr: "Invalid gestureStages parameter."},
		{query: gesture("gestureStages=1,1"), wantErr: "Invalid gestureStages parameter."},
		{query: gesture("gestureStages=1,,3"), wantErr: "Invalid gestureStages parameter."},
		{query: gesture("gestureStages=a"), wantErr: "Invalid gestureStages parameter."},
		{query: gesture("gestureStages=,"), wantErr: "Invalid gestureStages parameter."},
		{query: gesture("gestureStages=1,"), wantErr: "Invalid gestureStages parameter."},
		{query: gesture("gestureStages=01"), wantErr: "Invalid gestureStages parameter."},
		{query: gesture("gestureStages=%2B3"), wantErr: "Invalid gestureStages parameter."},
		{query: gesture("questionsPerStage=3"), wantErr: "Invalid questionsPerStage parameter."},
		{query: gesture("questionsPerStage=11"), wantErr: "Invalid questionsPerStage parameter."},
		{query: gesture("questionsPerStage=x"), wantErr: "Invalid questionsPerStage parameter."},
		{query: gesture("questionsPerStage=5.5"), wantErr: "Invalid questionsPerStage parameter."},
		// The other platforms ignore both parameters, even invalid ones, and keep them unset.
		{query: "exportType=0&courseType=0&level=1&lessonNumbers=1&gestureStages=9&questionsPerStage=99", check: func(o Options) bool {
			return o.ExportType == GimKit && o.GestureStages == nil && o.QuestionsPerStage == 0
		}},
		{query: "exportType=2&courseType=0&level=1&lessonNumbers=1&gestureStages=1,3&questionsPerStage=7", check: func(o Options) bool {
			return o.ExportType == Wayground && o.GestureStages == nil && o.QuestionsPerStage == 0
		}},
		{query: "exportType=0&courseType=2&courseName=+Boya+&lessonNumbers=4", check: func(o Options) bool {
			return o.CourseType == Other && o.Level == nil && o.CourseDisplayName() == "Boya"
		}},
		{query: "exportType=0&courseType=0&courseName=Boya&level=1&lessonNumbers=1", check: func(o Options) bool {
			return o.CourseName == "" // courseName only applies to Other
		}},
		{query: "courseType=0&level=1&lessonNumbers=1", wantErr: "Invalid or missing exportType parameter."},
		{query: "exportType=4&courseType=0&level=1&lessonNumbers=1", wantErr: "Invalid or missing exportType parameter."},
		{query: "exportType=0&courseType=9&level=1&lessonNumbers=1", wantErr: "Invalid or missing courseType parameter."},
		{query: "exportType=0&courseType=2&lessonNumbers=1", wantErr: "Invalid or missing courseName parameter."},
		{query: "exportType=0&courseType=0&level=x&lessonNumbers=1", wantErr: "Invalid level parameter."},
		{query: "exportType=0&courseType=1&lessonNumbers=1", wantErr: "Invalid or missing level parameter."},
		{query: "exportType=0&courseType=0&hskStandard=4&level=1&lessonNumbers=1", wantErr: "Invalid hskStandard parameter."},
		{query: "exportType=0&courseType=0&level=7&lessonNumbers=1", wantErr: "HSK 2.0 has levels 1 to 6."},
		{query: "exportType=0&courseType=0&hskStandard=3&level=10&lessonNumbers=1", wantErr: "HSK 3.0 has levels 1 to 9."},
		{query: "exportType=0&courseType=0&hskStandard=3&level=0&lessonNumbers=1", wantErr: "HSK 3.0 has levels 1 to 9."},
		{query: "exportType=0&courseType=0&level=1", wantErr: "Invalid or missing lessonNumbers parameter."},
		{query: "exportType=0&courseType=0&level=1&lessonNumbers=0", wantErr: "Invalid or missing lessonNumbers parameter."},
		{query: "exportType=0&courseType=0&level=1&lessonNumbers=-3", wantErr: "Invalid or missing lessonNumbers parameter."},
		{query: "exportType=0&courseType=2&courseName=Boya&lessonNumbers=0", wantErr: "Invalid or missing lessonNumbers parameter."},
		{query: "exportType=0&courseType=0&level=1&lessonNumbers=1&intelligence=0", wantErr: "Invalid intelligence parameter."},
		{query: "exportType=0&courseType=0&level=1&lessonNumbers=1&intelligence=3", wantErr: "Invalid intelligence parameter."},
		{query: "exportType=0&courseType=0&level=1&lessonNumbers=1&intelligence=x", wantErr: "Invalid intelligence parameter."},
	}
	for _, tt := range tests {
		q, _ := url.ParseQuery(tt.query)
		opts, err := ParseCreativeOptions(q)
		if tt.wantErr != "" {
			if err == nil || err.Error() != tt.wantErr {
				t.Errorf("%s: want error %q, got %v", tt.query, tt.wantErr, err)
			}
			continue
		}
		if err != nil || !tt.check(opts) {
			t.Errorf("%s: unexpected result %+v, %v", tt.query, opts, err)
		}
	}
}

func TestParseCreativeOptionsLessonNumbers(t *testing.T) {
	// HSK 2.0 level 4 has no textbook, so only the rules of the list itself apply.
	const course = "exportType=0&courseType=0&level=4&"
	const invalid = "Invalid or missing lessonNumbers parameter."
	const tooMany = "At most 5 lessons per quiz."
	tests := []struct {
		query   string
		want    []int
		wantErr string
	}{
		{query: course + "lessonNumbers=3,4,5", want: []int{3, 4, 5}},
		{query: course + "lessonNumbers=5,3,4", want: []int{3, 4, 5}},
		{query: course + "lessonNumbers=12,1", want: []int{1, 12}}, // by value, not as text
		{query: course + "lessonNumbers=%205,%203%20", want: []int{3, 5}},
		{query: course + "lessonNumbers=7", want: []int{7}},
		{query: course + "lessonNumbers=1,2,3,4,5", want: []int{1, 2, 3, 4, 5}},
		// The single lessonNumber is no longer read.
		{query: course + "lessonNumber=6", wantErr: invalid},
		{query: course + "lessonNumbers=", wantErr: invalid},
		{query: course + "lessonNumbers=+", wantErr: invalid},
		{query: course + "intelligence=1", wantErr: invalid},
		{query: course + "lessonNumbers=,", wantErr: invalid},
		{query: course + "lessonNumbers=3,,4", wantErr: invalid},
		{query: course + "lessonNumbers=3,", wantErr: invalid},
		{query: course + "lessonNumbers=,3", wantErr: invalid},
		{query: course + "lessonNumbers=3,3", wantErr: invalid},
		{query: course + "lessonNumbers=3,%203", wantErr: invalid},
		{query: course + "lessonNumbers=0", wantErr: invalid},
		{query: course + "lessonNumbers=3,0", wantErr: invalid},
		{query: course + "lessonNumbers=3,-4", wantErr: invalid},
		{query: course + "lessonNumbers=3,x", wantErr: invalid},
		{query: course + "lessonNumbers=3.5", wantErr: invalid},
		{query: course + "lessonNumbers=1,2,3,4,5,6", wantErr: tooMany},
		{query: course + "lessonNumbers=9,8,7,6,5,4,3", wantErr: tooMany},
		// A repeat or a bad element is reported before the count, whatever the length of the list.
		{query: course + "lessonNumbers=1,1,2,3,4,5", wantErr: invalid},
		{query: course + "lessonNumbers=1,2,3,4,5,x", wantErr: invalid},
		// The list is checked after the level and before the intelligence, where the lesson always was.
		{query: "exportType=0&courseType=0&level=7&lessonNumbers=0", wantErr: "HSK 2.0 has levels 1 to 6."},
		{query: course + "lessonNumbers=0&intelligence=9", wantErr: invalid},
		{query: course + "lessonNumbers=1,2,3,4,5,6&intelligence=9", wantErr: tooMany},
		{query: course + "lessonNumbers=1,2&intelligence=9", wantErr: "Invalid intelligence parameter."},
	}
	for _, tt := range tests {
		q, _ := url.ParseQuery(tt.query)
		opts, err := ParseCreativeOptions(q)
		if tt.wantErr != "" {
			if err == nil || err.Error() != tt.wantErr {
				t.Errorf("%s: want error %q, got %v", tt.query, tt.wantErr, err)
			}
			continue
		}
		if err != nil || !slices.Equal(opts.LessonNumbers, tt.want) {
			t.Errorf("%s: got %v, %v, want lessons %v", tt.query, opts.LessonNumbers, err, tt.want)
		}
	}
}

func TestExtractCSVContent(t *testing.T) {
	tests := map[string]string{
		"":                                      "",
		"  a,b\nc,d  ":                          "a,b\nc,d",
		"Here you go:\n```csv\na,b\n```\nEnjoy": "a,b",
		"```\na,b\n```":                         "a,b",
		"Sure!\nCâu hỏi, Đáp án\nxin chào,你好": "Câu hỏi, Đáp án\nxin chào,你好",
		"câu hỏi,đáp án\nx,y":                 "câu hỏi,đáp án\nx,y",
		"Question,Correct Answer\nWhat?,That": "Question,Correct Answer\nWhat?,That",
	}
	for in, want := range tests {
		if got := ExtractCSVContent(in); got != want {
			t.Errorf("ExtractCSVContent(%q) = %q, want %q", in, got, want)
		}
	}
}

func textsOf(t *testing.T, req responsesRequest) []string {
	t.Helper()
	var texts []string
	for _, p := range req.Input[0].Content {
		if p.Type == "input_text" {
			texts = append(texts, p.Text)
		}
	}
	return texts
}

func TestBuildCreativeRequest(t *testing.T) {
	level, lesson := 2, 5
	req := buildCreativeRequest("m", nil, Options{ExportType: Wayground, CourseType: Yct, Level: &level, LessonNumbers: []int{lesson}})
	if req.Model != "m" || req.MaxOutputTokens != 64000 || req.Input[0].Role != "user" ||
		len(req.Tools) != 1 || req.Tools[0].Type != "web_search" {
		t.Fatalf("unexpected request %+v", req)
	}
	system := req.Instructions
	if !strings.HasPrefix(system, "You are an expert Chinese-language teacher") ||
		!strings.HasSuffix(system, "The final response must contain nothing except the CSV rows.") ||
		strings.Contains(system, "\r") {
		t.Fatal("creative system prompt not loaded intact")
	}

	texts := textsOf(t, req)
	if len(texts) != 8 {
		t.Fatalf("want 8 text parts (intro, 4 Wayground, 3 lesson), got %d: %q", len(texts), texts)
	}
	if !strings.HasPrefix(texts[0], "No image is provided.") ||
		!strings.HasPrefix(texts[3], `"Text of the question`) || !strings.HasSuffix(texts[3], "(optional)") ||
		!strings.HasPrefix(texts[4], "Image Link:") ||
		texts[5] != "Course: YCT (Youth Chinese Test), taught from 《YCT标准教程》 YCT Standard Course (Giáo trình chuẩn YCT)" || texts[6] != "Level: 2" || texts[7] != "Lesson number: 5" {
		t.Fatalf("unexpected text parts %q", texts)
	}

	withImage := buildCreativeRequest("m", []Image{{ContentType: "image/png", Data: []byte{1, 2}}},
		Options{ExportType: GimKit, CourseType: Other, CourseName: "Boya", LessonNumbers: []int{lesson}})
	texts = textsOf(t, withImage)
	if texts[0] != "Convert the images to CSV using the required format." ||
		texts[3] != "Level: this course has no level, none was given." {
		t.Fatalf("unexpected text parts %q", texts)
	}
	// No image column on GimKit, so no search.
	if withImage.Tools != nil || withImage.MaxOutputTokens != 32000 {
		t.Fatalf("unexpected request %+v", withImage)
	}
	parts := withImage.Input[0].Content
	if last := parts[len(parts)-1]; last.Type != "input_image" || last.ImageURL != "data:image/png;base64,AQI=" {
		t.Fatalf("unexpected image part %+v", last)
	}

	// GestureQuiz has no image column either, so it gets no search tool and the plain token budget;
	// its stage rules arrive as the template message right after the columns.
	gesture := buildCreativeRequest("m", nil, Options{ExportType: GestureQuiz, CourseType: Hsk, Level: &level, LessonNumbers: []int{lesson}})
	if gesture.Tools != nil || gesture.MaxOutputTokens != 32000 {
		t.Fatalf("unexpected request %+v", gesture)
	}
	if len(gesture.Input[0].Content) != 6 {
		t.Fatalf("want 6 parts and no image, got %+v", gesture.Input[0].Content)
	}
	texts = textsOf(t, gesture)
	if len(texts) != 6 {
		t.Fatalf("want 6 text parts (intro, 2 GestureQuiz, 3 lesson), got %d: %q", len(texts), texts)
	}
	if !strings.HasPrefix(texts[1], "CSV columns: Stage,") || !strings.Contains(texts[2], "GESTURE QUIZ STAGES") ||
		strings.Contains(texts[2], "\r") || texts[5] != "Lesson number: 5" {
		t.Fatalf("unexpected text parts %q", texts)
	}
}

// stageRuleStarts is how each stage's rule paragraph begins, and a sentence that only that paragraph
// holds, so a message can be checked for the rules of the stages it has and of those it must not have.
var stageRuleStarts = [GestureStageCount]struct{ start, sentence string }{
	{"Stage 1 – True or false", "Make about half of the statements false"},
	{"Stage 2 – Two choices", "Chinese word to Vietnamese meaning, Vietnamese meaning to Chinese word"},
	{"Stage 3 – Three choices (the learner moves the head", "Recognition with closer distractors"},
	{"Stage 4 – Three choices (the learner slices", "fill in the blank in a short sentence"},
	{"Stage 5 – Four choices", "Never use the bare numbers 1 to 4 as options"},
	{"Stage 6 – Sentence ordering", "The game shuffles the chunks itself"},
}

func gestureMessage(t *testing.T, stages []int, questions int) string {
	t.Helper()
	level, lesson := 1, 1
	req := buildCreativeRequest("m", nil, Options{
		ExportType: GestureQuiz, CourseType: Hsk, Level: &level, LessonNumbers: []int{lesson},
		GestureStages: stages, QuestionsPerStage: questions,
	})
	texts := textsOf(t, req)
	if len(texts) != 6 || !strings.HasPrefix(texts[1], "CSV columns: Stage,") {
		t.Fatalf("unexpected text parts %q", texts)
	}
	return texts[2]
}

func TestGestureQuizMessage(t *testing.T) {
	tests := []struct {
		name      string
		stages    []int
		questions int
		contain   []string
		absent    []string
	}{
		{
			name: "defaults", // all six stages and five questions, also for a hand-built Options
			contain: []string{
				"GESTURE QUIZ STAGES",
				"This quiz has 6 stages: stage 1 (true or false), stage 2 (two choices answered by tilting the head), stage 3 (three choices answered by biting with the mouth), stage 4 (three choices answered by slicing fruit), stage 5 (four choices answered by showing fingers) and stage 6 (sentence ordering).",
				"They are played in order from the easiest to the hardest, and a stage must be passed before the next one opens.",
				"Classify every question by how difficult it really is",
				"at most 8 Chinese characters or about 6 Vietnamese words in stages 2 to 5.",
				"Stage: the number of the row's stage, which must be 1, 2, 3, 4, 5 or 6, in the first column.",
				"Write exactly 5 questions for every stage, 30 rows in total, and output the rows grouped by stage in ascending order of the stage number, stage 1 first.",
				"Every stage must have all 5 rows",
			},
			absent: []string{"renumbered", "single stage"},
		},
		{
			name: "two stages, seven questions", stages: []int{4, 6}, questions: 7,
			contain: []string{
				"This quiz has 2 stages: stage 4 (three choices answered by slicing fruit) and stage 6 (sentence ordering).",
				"a stage must be passed before the next one opens",
				"it is not renumbered when the other stages are left out of this quiz. The Stage column of every row must be 4 or 6, exactly as numbered above, and no row may use any other stage number.",
				"put it in the stage of this quiz that matches that difficulty",
				"about 6 Vietnamese words in stage 4. The options of a row must all be different",
				"Stage: the number of the row's stage, which must be 4 or 6, in the first column. No other stage number is allowed.",
				"Write exactly 7 questions for every stage, 14 rows in total, and output the rows grouped by stage in ascending order of the stage number, stage 4 first.",
				"Every stage must have all 7 rows",
			},
			absent: []string{"stages 2 to 5", "in total, and output the rows grouped by stage in ascending order of the stage number, stage 1"},
		},
		{
			name: "no stage with options", stages: []int{1, 6}, questions: 4,
			contain: []string{
				"This quiz has 2 stages: stage 1 (true or false) and stage 6 (sentence ordering).",
				"must be 1 or 6",
				"Write exactly 4 questions for every stage, 8 rows in total",
				"Explanation: one short Vietnamese sentence",
			},
			absent: []string{"Options are shown in big type", "must all be different", "Cả A và B", "refers to other options"},
		},
		{
			name: "a single stage", stages: []int{6}, questions: 5,
			contain: []string{
				"This quiz has a single stage, stage 6 (sentence ordering), so the learner plays only that gesture game",
				"The Stage column of every row must be 6, exactly as numbered above",
				"Every row belongs to that stage, so write each question to fit its difficulty and its format.",
				"Stage: the number of the row's stage, which must be 6, in the first column.",
				"Write exactly 5 questions, all of stage 6, so 5 rows in total.",
			},
			absent: []string{"Options are shown in big type", "the next one opens", "Classify every question", "stages:", "every stage", "grouped by stage"},
		},
		{
			name: "a single stage with options", stages: []int{3}, questions: 10,
			contain: []string{
				"This quiz has a single stage, stage 3 (three choices answered by biting with the mouth)",
				"in stage 3. The options of a row must all be different",
				"Write exactly 10 questions, all of stage 3, so 10 rows in total.",
			},
			absent: []string{"the next one opens", "stages 2"},
		},
		{
			name: "stages with a gap", stages: []int{2, 3, 5}, questions: 6,
			contain: []string{"in stages 2, 3 and 5. The options", "must be 2, 3 or 5,", "18 rows in total"},
		},
		{
			name: "two stages with options", stages: []int{3, 5}, questions: 6,
			contain: []string{"in stages 3 and 5. The options", "must be 3 or 5,", "12 rows in total"},
		},
		{
			name: "a run of stages with options", stages: []int{1, 2, 3, 4}, questions: 5,
			contain: []string{"in stages 2 to 4. The options", "must be 1, 2, 3 or 4,", "20 rows in total"},
			absent:  []string{"stage 5", "Stage 5 – ", "Stage 6 – "},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			msg := gestureMessage(t, tt.stages, tt.questions)
			for _, want := range tt.contain {
				if !strings.Contains(msg, want) {
					t.Errorf("message lacks %q:\n%s", want, msg)
				}
			}
			for _, bad := range tt.absent {
				if strings.Contains(msg, bad) {
					t.Errorf("message has %q:\n%s", bad, msg)
				}
			}
			// Exactly the rules of the chosen stages are there, whatever else is checked above.
			want := tt.stages
			if len(want) == 0 {
				want = AllGestureStages()
			}
			for i, rule := range stageRuleStarts {
				chosen := slices.Contains(want, i+1)
				for _, text := range []string{rule.start, rule.sentence} {
					if has := strings.Contains(msg, text); has != chosen {
						t.Errorf("stage %d: %q present = %v, want %v", i+1, text, has, chosen)
					}
				}
			}
		})
	}
}

// Every combination of stages gives a clean message: no template leftovers or gaps, the rules of the
// chosen stages in ascending order, one for each, and nothing about the stages that were left out.
func TestGestureQuizMessageForEveryStageSet(t *testing.T) {
	for mask := 1; mask < 1<<GestureStageCount; mask++ {
		var stages []int
		for stage := 1; stage <= GestureStageCount; stage++ {
			if mask&(1<<(stage-1)) != 0 {
				stages = append(stages, stage)
			}
		}
		questions := MinQuestionsPerStage + mask%(MaxQuestionsPerStage-MinQuestionsPerStage+1)
		msg := gestureMessage(t, stages, questions)

		for _, bad := range []string{"{{", "}}", "<no value>", "\r", "\n\n\n", "%!"} {
			if strings.Contains(msg, bad) {
				t.Errorf("stages %v: message has %q:\n%s", stages, bad, msg)
			}
		}
		if msg != strings.TrimSpace(msg) || !strings.HasPrefix(msg, "GESTURE QUIZ STAGES\n\n") || !strings.HasSuffix(msg, "passed the stage.") {
			t.Errorf("stages %v: message is not trimmed or is cut off:\n%s", stages, msg)
		}
		last := -1
		for i, rule := range stageRuleStarts {
			at := strings.Index(msg, rule.start)
			if chosen := slices.Contains(stages, i+1); chosen != (at >= 0) {
				t.Fatalf("stages %v: rule of stage %d present = %v, want %v", stages, i+1, at >= 0, chosen)
			}
			if at >= 0 {
				if at < last {
					t.Errorf("stages %v: rule of stage %d is out of order", stages, i+1)
				}
				last = at
			}
		}
		if want := fmt.Sprintf("%d rows in total", len(stages)*questions); !strings.Contains(msg, want) {
			t.Errorf("stages %v: message lacks %q", stages, want)
		}
	}
}

func TestGestureQuizTokenBudget(t *testing.T) {
	tests := []struct {
		stages    []int
		questions int
		want      int
	}{
		{nil, 0, 32000}, // the defaults, 30 rows
		{AllGestureStages(), 5, 32000},
		{AllGestureStages(), 4, 32000},
		{[]int{1, 2, 3}, 10, 32000},    // 30 rows is still the base budget
		{AllGestureStages(), 6, 64000}, // 36 rows
		{[]int{1, 2, 3, 4}, 8, 64000},  // 32 rows
		{AllGestureStages(), 10, 64000},
		{[]int{6}, 10, 32000},
	}
	level, lesson := 1, 1
	for _, tt := range tests {
		req := buildCreativeRequest("m", nil, Options{
			ExportType: GestureQuiz, CourseType: Hsk, Level: &level, LessonNumbers: []int{lesson},
			GestureStages: tt.stages, QuestionsPerStage: tt.questions,
		})
		if req.MaxOutputTokens != tt.want || req.Tools != nil {
			t.Errorf("stages %v x %d: max_output_tokens %d with tools %v, want %d and none", tt.stages, tt.questions, req.MaxOutputTokens, req.Tools, tt.want)
		}
	}
	// The other platforms are untouched by the gesture settings.
	other := buildCreativeRequest("m", nil, Options{ExportType: GimKit, CourseType: Hsk, Level: &level, LessonNumbers: []int{lesson},
		GestureStages: AllGestureStages(), QuestionsPerStage: 10})
	if other.MaxOutputTokens != 32000 {
		t.Errorf("GimKit got %d output tokens", other.MaxOutputTokens)
	}
}

func TestGenerateCallsChatCompletions(t *testing.T) {
	var got map[string]any
	llm := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" || r.Header.Get("Authorization") != "Bearer key" {
			t.Errorf("unexpected request %s %q", r.URL.Path, r.Header.Get("Authorization"))
		}
		body, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(body, &got)
		_, _ = io.WriteString(w, `{"choices":[{"message":{"content":"`+"```csv\\nCâu hỏi,Đáp án\\na,b\\n```"+`"}}]}`)
	}))
	defer llm.Close()

	c := NewClient(llm.URL+"/v1/", "key", "gpt-x", nil, slog.New(slog.DiscardHandler))
	csv, err := c.Generate(context.Background(), []Image{{ContentType: "image/jpeg", Data: []byte("img")}}, false, Options{})
	if err != nil {
		t.Fatal(err)
	}
	if csv != "Câu hỏi,Đáp án\na,b" {
		t.Fatalf("unexpected csv %q", csv)
	}
	if got["model"] != "gpt-x" || got["max_completion_tokens"] != float64(32000) || got["reasoning_effort"] != "low" {
		t.Fatalf("unexpected payload %v", got)
	}
}

func TestGenerateCreativeCallsResponses(t *testing.T) {
	var got map[string]any
	reply := `{"status":"completed","output":[{"type":"reasoning"},{"type":"web_search_call","status":"completed"},` +
		`{"type":"message","content":[{"type":"output_text","text":"` + "```csv\\na,b\\n```" + `"}]}]}`
	llm := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/responses" {
			t.Errorf("unexpected path %s", r.URL.Path)
		}
		body, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(body, &got)
		_, _ = io.WriteString(w, reply)
	}))
	defer llm.Close()

	level, lesson := 1, 1
	c := NewClient(llm.URL+"/v1", "key", "gpt-x", nil, slog.New(slog.DiscardHandler))
	csv, err := c.Generate(context.Background(), nil, true, Options{ExportType: Wayground, CourseType: Hsk, Level: &level, LessonNumbers: []int{lesson}})
	if err != nil {
		t.Fatal(err)
	}
	if csv != "a,b" {
		t.Fatalf("unexpected csv %q", csv)
	}
	if got["model"] != "gpt-x" || got["max_output_tokens"] != float64(64000) || got["instructions"] == "" {
		t.Fatalf("unexpected payload %v", got)
	}
}

func TestGenerateFailsOnIncompleteResponse(t *testing.T) {
	llm := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `{"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"output":[{"type":"message","content":[{"type":"output_text","text":"a,b"}]}]}`)
	}))
	defer llm.Close()
	c := NewClient(llm.URL, "key", "m", nil, slog.New(slog.DiscardHandler))
	if _, err := c.Generate(context.Background(), nil, true, Options{}); err == nil || !strings.Contains(err.Error(), "max_output_tokens") {
		t.Fatalf("want incomplete error, got %v", err)
	}
}

func TestGenerateFailsOnErrorStatus(t *testing.T) {
	llm := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "nope", http.StatusBadRequest)
	}))
	defer llm.Close()
	c := NewClient(llm.URL, "key", "m", nil, slog.New(slog.DiscardHandler))
	if _, err := c.Generate(context.Background(), nil, true, Options{}); err == nil {
		t.Fatal("want error on non-2xx status")
	}
}

func TestModelForIntelligence(t *testing.T) {
	models := []string{"m1", "m2"}
	c := NewClient("http://x", "key", "base", models, slog.New(slog.DiscardHandler))
	for level, want := range map[int]string{1: "m1", 2: "m2", 0: "m1", 3: "m1"} {
		if got := c.modelFor(Options{Intelligence: level}); got != want {
			t.Errorf("intelligence %d: want %q, got %q", level, want, got)
		}
	}
	if got := NewClient("http://x", "key", "base", nil, slog.New(slog.DiscardHandler)).modelFor(Options{Intelligence: 2}); got != "base" {
		t.Errorf("without intelligence models want the base model, got %q", got)
	}
}

// With the lessons of a textbook at hand, the number of its lessons is known, and the course is named
// exactly; every other course keeps taking any positive lesson number.
func TestParseCreativeOptionsForTextbooks(t *testing.T) {
	useFixtureLibrary(t)
	tests := []struct {
		query   string
		wantErr string
		course  string
	}{
		{query: "exportType=0&courseType=0&hskStandard=3&level=2&lessonNumbers=15", course: "《新HSK教程2》 (New HSK Course 2), the HSK 3.0 level 2 textbook"},
		{query: "exportType=0&courseType=0&hskStandard=3&level=1&lessonNumbers=1", course: "《新HSK教程1》 (New HSK Course 1), the HSK 3.0 level 1 textbook"},
		{query: "exportType=0&courseType=0&hskStandard=3&level=3&lessonNumbers=18", course: "《新HSK教程3》 (New HSK Course 3), the HSK 3.0 level 3 textbook"},
		{query: "exportType=0&courseType=1&level=6&lessonNumbers=15", course: "《YCT标准教程6》 (YCT Standard Course 6), the YCT level 6 textbook"},
		{query: "exportType=0&courseType=0&hskStandard=3&level=2&lessonNumbers=16", wantErr: "Lesson must be 1 to 15 for 《新HSK教程2》."},
		{query: "exportType=0&courseType=0&hskStandard=2&level=2&lessonNumbers=16", wantErr: "Lesson must be 1 to 15 for 《HSK标准教程2》."},
		{query: "exportType=0&courseType=0&hskStandard=3&level=3&lessonNumbers=19", wantErr: "Lesson must be 1 to 18 for 《新HSK教程3》."},
		{query: "exportType=0&courseType=0&hskStandard=3&level=1&lessonNumbers=0", wantErr: "Invalid or missing lessonNumbers parameter."},
		{query: "exportType=0&courseType=1&level=6&lessonNumbers=16", wantErr: "Lesson must be 1 to 15 for 《YCT标准教程6》."},
		// Every lesson of a list must be in the book, whichever place it has in the list.
		{query: "exportType=0&courseType=0&hskStandard=3&level=2&lessonNumbers=3,14,15", course: "《新HSK教程2》 (New HSK Course 2), the HSK 3.0 level 2 textbook"},
		{query: "exportType=0&courseType=0&hskStandard=3&level=2&lessonNumbers=3,16", wantErr: "Lesson must be 1 to 15 for 《新HSK教程2》."},
		{query: "exportType=0&courseType=0&hskStandard=3&level=2&lessonNumbers=16,3", wantErr: "Lesson must be 1 to 15 for 《新HSK教程2》."},
		{query: "exportType=0&courseType=0&hskStandard=3&level=3&lessonNumbers=17,18,19", wantErr: "Lesson must be 1 to 18 for 《新HSK教程3》."},
		{query: "exportType=0&courseType=1&level=6&lessonNumbers=1,16", wantErr: "Lesson must be 1 to 15 for 《YCT标准教程6》."},
		{query: "exportType=0&courseType=0&hskStandard=3&level=2&lessonNumbers=1,0", wantErr: "Invalid or missing lessonNumbers parameter."},
		// The size of the list is checked before the book's lesson count.
		{query: "exportType=0&courseType=0&hskStandard=3&level=2&lessonNumbers=1,2,3,4,5,16", wantErr: "At most 5 lessons per quiz."},
		{query: "exportType=0&courseType=0&level=4&lessonNumbers=3,40,99", course: "HSK 2.0 (the six-level standard), taught from 《HSK标准教程》 HSK Standard Course (Giáo trình chuẩn HSK)"},
		// Courses without material are not limited: the model reads the number as a position in a book.
		{query: "exportType=0&courseType=0&level=4&lessonNumbers=16", course: "HSK 2.0 (the six-level standard), taught from 《HSK标准教程》 HSK Standard Course (Giáo trình chuẩn HSK)"},
		{query: "exportType=0&courseType=0&level=4&lessonNumbers=40", course: "HSK 2.0 (the six-level standard), taught from 《HSK标准教程》 HSK Standard Course (Giáo trình chuẩn HSK)"},
		{query: "exportType=0&courseType=1&level=5&lessonNumbers=99", course: "YCT (Youth Chinese Test), taught from 《YCT标准教程》 YCT Standard Course (Giáo trình chuẩn YCT)"},
		{query: "exportType=0&courseType=0&hskStandard=3&level=4&lessonNumbers=30", course: "HSK 3.0 (the nine-level standard GF 0025-2021), taught from the HSK 3.0 edition of 《HSK标准教程》 HSK Standard Course (Giáo trình chuẩn HSK 3.0)"},
		{query: "exportType=0&courseType=2&courseName=Boya&level=2&lessonNumbers=99", course: "Boya"},
	}
	for _, tt := range tests {
		q, _ := url.ParseQuery(tt.query)
		opts, err := ParseCreativeOptions(q)
		if tt.wantErr != "" {
			if err == nil || err.Error() != tt.wantErr {
				t.Errorf("%s: want error %q, got %v", tt.query, tt.wantErr, err)
			}
			continue
		}
		if err != nil || opts.CourseDisplayName() != tt.course {
			t.Errorf("%s: got %q, %v, want course %q", tt.query, opts.CourseDisplayName(), err, tt.course)
		}
	}
}

func TestBuildCreativeRequestWithLessonMaterial(t *testing.T) {
	useFixtureLibrary(t)
	level, lesson := 2, 7
	opts := Options{ExportType: GimKit, CourseType: Hsk, HskStandard: Hsk3, Level: &level, LessonNumbers: []int{lesson}}
	material := lessonMaterial(textbookFor(opts), []int{lesson})
	if !strings.HasPrefix(material, "LESSON MATERIAL: 《新HSK教程2》") {
		t.Fatalf("unexpected material %q", material)
	}

	// Without images the material is the lesson: it follows the course, level and lesson number.
	req := buildCreativeRequest("m", nil, opts)
	texts := textsOf(t, req)
	want := []string{
		"Follow the LESSON SOURCE section: the LESSON MATERIAL message below is the lesson, taken from the textbook. Generate the CSV using the required format.",
		exportTypeMessages(opts)[0],
		"Course: 《新HSK教程2》 (New HSK Course 2), the HSK 3.0 level 2 textbook",
		"Level: 2",
		"Lesson number: 7",
		material,
	}
	if !slices.Equal(texts, want) {
		t.Fatalf("unexpected text parts:\n%q\nwant\n%q", texts, want)
	}
	if len(req.Input[0].Content) != len(want) || req.MaxOutputTokens != 32000 || req.Tools != nil {
		t.Errorf("unexpected request %+v", req)
	}

	// With images the material comes before them, and they only narrow it down.
	withImage := buildCreativeRequest("m", []Image{{ContentType: "image/png", Data: []byte{1, 2}}}, opts)
	texts = textsOf(t, withImage)
	if texts[0] != "The LESSON MATERIAL message below is the lesson, taken from the textbook; the images show the part of it to focus on. Generate the CSV using the required format." ||
		texts[len(texts)-1] != material || len(texts) != len(want) {
		t.Fatalf("unexpected text parts %q", texts)
	}
	parts := withImage.Input[0].Content
	if len(parts) != len(want)+1 || parts[len(parts)-2].Text != material || parts[len(parts)-1].Type != "input_image" {
		t.Fatalf("the material must come right before the images: %+v", parts)
	}

	// The token budgets do not depend on the material.
	opts.ExportType = Wayground
	if wayground := buildCreativeRequest("m", nil, opts); wayground.MaxOutputTokens != 64000 || len(wayground.Tools) != 1 {
		t.Errorf("unexpected Wayground request %+v", wayground)
	}
	opts.ExportType = GestureQuiz
	if gesture := buildCreativeRequest("m", nil, opts); gesture.MaxOutputTokens != 32000 || gesture.Tools != nil {
		t.Errorf("unexpected gesture request %+v", gesture)
	}
}

func TestLessonMessages(t *testing.T) {
	level := 2
	opts := Options{ExportType: GimKit, CourseType: Yct, Level: &level}
	tests := []struct {
		lessons []int
		want    string // the last message, empty when there is none after the level
	}{
		{nil, ""},
		{[]int{5}, "Lesson number: 5"},
		{[]int{3, 5}, "Lesson numbers: 3 and 5. Write one quiz that reviews all of these lessons together."},
		{[]int{3, 4, 5}, "Lesson numbers: 3, 4 and 5. Write one quiz that reviews all of these lessons together."},
		{[]int{1, 2, 3, 4, 5}, "Lesson numbers: 1, 2, 3, 4 and 5. Write one quiz that reviews all of these lessons together."},
	}
	for _, tt := range tests {
		opts.LessonNumbers = tt.lessons
		msgs := lessonMessages(opts)
		if tt.want == "" {
			if len(msgs) != 2 || msgs[1] != "Level: 2" {
				t.Errorf("no lessons: %q", msgs)
			}
			continue
		}
		if len(msgs) != 3 || msgs[2] != tt.want {
			t.Errorf("lessons %v: %q, want a last message %q", tt.lessons, msgs, tt.want)
		}
	}
}

func TestBuildCreativeRequestForSeveralLessons(t *testing.T) {
	useFixtureLibrary(t)
	images := []Image{{ContentType: "image/png", Data: []byte{1, 2}}}
	const lessonLine = "Lesson numbers: 3, 4 and 5. Write one quiz that reviews all of these lessons together."
	lessons := []int{3, 4, 5}

	// Without a textbook the model recalls the lessons: each of them, in one CSV.
	hsk2Level := 4
	noBook := Options{ExportType: GimKit, CourseType: Hsk, HskStandard: Hsk2, Level: &hsk2Level, LessonNumbers: lessons}
	rest := append(exportTypeMessages(noBook), "Course: "+noBook.CourseDisplayName(), "Level: 4", lessonLine)
	want := append([]string{"No image is provided. Follow the LESSON SOURCE section: identify the textbook for the course and level below, recall the new words of each of those lessons, and generate one CSV that covers all of them, using the required format."}, rest...)
	if texts := textsOf(t, buildCreativeRequest("m", nil, noBook)); !slices.Equal(texts, want) {
		t.Errorf("no images, no textbook:\n%q\nwant\n%q", texts, want)
	}
	// With images and no textbook the images are the lessons, whatever their number.
	want = append([]string{"Convert the images to CSV using the required format."}, rest...)
	if texts := textsOf(t, buildCreativeRequest("m", images, noBook)); !slices.Equal(texts, want) {
		t.Errorf("images, no textbook:\n%q\nwant\n%q", texts, want)
	}

	// With a textbook the material holds all the lessons in one message, after the lesson numbers.
	level := 2
	opts := Options{ExportType: GimKit, CourseType: Hsk, HskStandard: Hsk3, Level: &level, LessonNumbers: lessons}
	material := lessonMaterial(textbookFor(opts), lessons)
	if !strings.HasPrefix(material, "LESSON MATERIAL: 《新HSK教程2》 (New HSK Course 2), lessons 3, 4 and 5 of 15, taken from the textbook itself.\n\n") {
		t.Fatalf("unexpected material %q", material)
	}
	rest = append(exportTypeMessages(opts), "Course: 《新HSK教程2》 (New HSK Course 2), the HSK 3.0 level 2 textbook", "Level: 2", lessonLine, material)
	want = append([]string{"Follow the LESSON SOURCE section: the LESSON MATERIAL message below holds the lessons, taken from the textbook. Generate one CSV that covers all of them, using the required format."}, rest...)
	if texts := textsOf(t, buildCreativeRequest("m", nil, opts)); !slices.Equal(texts, want) {
		t.Errorf("textbook, no images:\n%q\nwant\n%q", texts, want)
	}
	want = append([]string{"The LESSON MATERIAL message below holds the lessons, taken from the textbook; the images show the part of them to focus on. Generate one CSV that covers all of them, using the required format."}, rest...)
	withImages := buildCreativeRequest("m", images, opts)
	if texts := textsOf(t, withImages); !slices.Equal(texts, want) {
		t.Errorf("textbook, images:\n%q\nwant\n%q", texts, want)
	}
	if parts := withImages.Input[0].Content; len(parts) != len(want)+1 || parts[len(parts)-2].Text != material || parts[len(parts)-1].Type != "input_image" {
		t.Errorf("the material must come right before the images: %+v", parts)
	}
	// A lesson the book lacks leaves no material, and the request reads as one without a textbook.
	opts.LessonNumbers = []int{3, 16}
	if texts := textsOf(t, buildCreativeRequest("m", nil, opts)); strings.Contains(strings.Join(texts, "\n"), "LESSON MATERIAL: ") {
		t.Errorf("material for a lesson the book does not have: %q", texts)
	}
}

// A course without material gets exactly the request it always had, whatever the library holds.
func TestBuildCreativeRequestWithoutLessonMaterial(t *testing.T) {
	level, lesson := 5, 7
	hsk2Level := 4
	tests := []Options{
		{ExportType: GimKit, CourseType: Hsk, HskStandard: Hsk2, Level: &hsk2Level, LessonNumbers: []int{lesson}},
		{ExportType: Wayground, CourseType: Hsk, HskStandard: Hsk3, Level: &level, LessonNumbers: []int{lesson}},
		{ExportType: GimKit, CourseType: Yct, Level: &level, LessonNumbers: []int{lesson}},
		{ExportType: GestureQuiz, CourseType: Other, CourseName: "Boya", LessonNumbers: []int{lesson}},
	}
	for _, opts := range tests {
		for _, images := range [][]Image{nil, {{ContentType: "image/png", Data: []byte{1}}}} {
			useLibrary(t, nil)
			before, err := json.Marshal(buildCreativeRequest("m", images, opts))
			if err != nil {
				t.Fatal(err)
			}
			useFixtureLibrary(t)
			after, err := json.Marshal(buildCreativeRequest("m", images, opts))
			if err != nil {
				t.Fatal(err)
			}
			if string(before) != string(after) || strings.Contains(string(after), "LESSON MATERIAL: ") {
				t.Errorf("%+v with %d images: the request changed:\n%s\n%s", opts, len(images), before, after)
			}
		}
	}
}

func TestCreativeSystemPromptHasTheMaterialCase(t *testing.T) {
	prompt := normalizePrompt(creativeSystemPrompt)
	for _, want := range []string{
		"### When a LESSON MATERIAL message is provided",
		"### When only images are provided",
		"### When neither is provided",
		"Optionally, a LESSON MATERIAL message",
		"The web search tool is only for finding illustrations.",
		"When a LESSON MATERIAL message is provided, it is the lesson",
	} {
		if strings.Count(prompt, want) != 1 {
			t.Errorf("the system prompt must have %q once", want)
		}
	}
	if strings.Index(prompt, "### When a LESSON MATERIAL") > strings.Index(prompt, "### When only images") {
		t.Error("the material case comes first")
	}
}
