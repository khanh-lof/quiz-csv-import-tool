// Package csvgen turns lesson images into quiz CSV through an OpenAI-compatible vision model.
package csvgen

import (
	"errors"
	"fmt"
	"net/url"
	"slices"
	"strconv"
	"strings"
)

// ExportType is the quiz platform the CSV is meant for. The client sends it by ordinal, so the
// order must match Client/src/models/export-type.ts exactly.
type ExportType int

const (
	GimKit ExportType = iota
	Blooket
	Wayground
	// GestureQuiz is not an import target: QuizTool plays the quiz itself as a webcam gesture game.
	GestureQuiz
)

var exportTypeNames = []string{"GimKit", "Blooket", "Wayground", "GestureQuiz"}

// CourseType identifies the course a lesson belongs to. Sent by ordinal; keep in the same order
// as Client/src/models/course-type.ts.
type CourseType int

const (
	Hsk CourseType = iota
	Yct
	Other
)

var courseTypeNames = []string{"Hsk", "Yct", "Other"}

// HskStandard is the version of the HSK standard an HSK lesson follows. Sent by value (2 or 3), not
// by ordinal; keep in step with Client/src/models/hsk-standard.ts.
type HskStandard int

const (
	// Hsk2 is the 2009 six-level HSK, taught from the original 《HSK标准教程》. The default, since
	// it is what Vietnamese classrooms mostly still use.
	Hsk2 HskStandard = 2
	// Hsk3 is the nine-level HSK 3.0 (GF 0025-2021).
	Hsk3 HskStandard = 3
)

// MaxLevel is the highest level of the standard: HSK 2.0 stops at 6, HSK 3.0 goes to 9.
func (s HskStandard) MaxLevel() int {
	if s == Hsk3 {
		return 9
	}
	return 6
}

// IntelligenceLevels is how many "Độ thông minh" levels the GUI offers (1 = Thấp, 2 = Cao); each
// picks one model from LLM_INTELLIGENCE_MODELS, cheapest first.
const IntelligenceLevels = 2

// DefaultIntelligence is used when the client sends none; it matches the GUI default (Thấp).
const DefaultIntelligence = 1

// GestureStageCount is how many games (stages) a Quiz cử chỉ can have. A stage's number, 1 to
// GestureStageCount, is the identity of its game in the CSV, so it never changes when a quiz leaves
// other stages out. Keep in step with STAGES in Client/src/game/stages.ts.
const GestureStageCount = 6

// The number of questions a gesture quiz asks for in each of its stages. Four is the minimum because
// a stage is passed with 70% right, and with fewer questions it would be all-or-nothing. Keep in step
// with Client/src/models/gesture-quiz-options.ts.
const (
	MinQuestionsPerStage     = 4
	MaxQuestionsPerStage     = 10
	DefaultQuestionsPerStage = 5
)

// AllGestureStages returns every stage number, the quiz a teacher gets without choosing games.
func AllGestureStages() []int {
	stages := make([]int, GestureStageCount)
	for i := range stages {
		stages[i] = i + 1
	}
	return stages
}

// Options is everything the creative prompt needs to know about the lesson. Level is optional for
// CourseType Other, and images are optional altogether: without them the model falls back to the
// canonical word list of the lesson.
type Options struct {
	ExportType ExportType
	CourseType CourseType
	// CourseName is free text, only used when CourseType is Other.
	CourseName string
	// HskStandard is only used when CourseType is Hsk.
	HskStandard  HskStandard
	Level        *int
	LessonNumber *int
	// Intelligence is 1..IntelligenceLevels and selects the model, see Client.modelFor.
	Intelligence int
	// GestureStages (ascending, unique, each 1..GestureStageCount) and QuestionsPerStage describe the
	// quiz of the GestureQuiz platform and stay zero for the other platforms. ParseCreativeOptions
	// always fills them for GestureQuiz; the accessors below also give a hand-built Options its defaults.
	GestureStages     []int
	QuestionsPerStage int
}

// GestureQuizStages returns the stage numbers of a gesture quiz, all of them when none were chosen.
func (o Options) GestureQuizStages() []int {
	if len(o.GestureStages) == 0 {
		return AllGestureStages()
	}
	return o.GestureStages
}

// GestureQuizQuestions returns how many questions each stage of a gesture quiz gets.
func (o Options) GestureQuizQuestions() int {
	if o.QuestionsPerStage == 0 {
		return DefaultQuestionsPerStage
	}
	return o.QuestionsPerStage
}

// CourseDisplayName is the course name handed to the model. For HSK and YCT it names the textbook,
// since lesson numbers only exist there (the exam syllabuses have levels but no lessons). A book whose
// lessons are embedded (see textbooks.go) is named exactly.
func (o Options) CourseDisplayName() string {
	if book := textbookFor(o); book != nil {
		return fmt.Sprintf("%s, the %s level %d textbook", book.fullName(), book.course, book.level)
	}
	switch o.CourseType {
	case Hsk:
		if o.HskStandard == Hsk3 {
			return "HSK 3.0 (the nine-level standard GF 0025-2021), taught from the HSK 3.0 edition of 《HSK标准教程》 HSK Standard Course (Giáo trình chuẩn HSK 3.0)"
		}
		return "HSK 2.0 (the six-level standard), taught from 《HSK标准教程》 HSK Standard Course (Giáo trình chuẩn HSK)"
	case Yct:
		return "YCT (Youth Chinese Test), taught from 《YCT标准教程》 YCT Standard Course (Giáo trình chuẩn YCT)"
	}
	if strings.TrimSpace(o.CourseName) == "" {
		return "an unnamed Chinese course"
	}
	return o.CourseName
}

// ParseCreativeOptions reads the creative-mode query parameters. The error text is returned to
// the client as-is.
func ParseCreativeOptions(q url.Values) (Options, error) {
	exportType, ok := parseEnum(q.Get("exportType"), exportTypeNames)
	if !ok {
		return Options{}, errors.New("Invalid or missing exportType parameter.")
	}
	courseType, ok := parseEnum(q.Get("courseType"), courseTypeNames)
	if !ok {
		return Options{}, errors.New("Invalid or missing courseType parameter.")
	}
	opts := Options{ExportType: ExportType(exportType), CourseType: CourseType(courseType)}

	if opts.CourseType == Hsk {
		opts.HskStandard = Hsk2
		if raw := strings.TrimSpace(q.Get("hskStandard")); raw != "" {
			standard, err := strconv.Atoi(raw)
			if err != nil || (HskStandard(standard) != Hsk2 && HskStandard(standard) != Hsk3) {
				return Options{}, errors.New("Invalid hskStandard parameter.")
			}
			opts.HskStandard = HskStandard(standard)
		}
	}

	if opts.CourseType == Other {
		opts.CourseName = strings.TrimSpace(q.Get("courseName"))
		if opts.CourseName == "" {
			return Options{}, errors.New("Invalid or missing courseName parameter.")
		}
	}

	if raw := strings.TrimSpace(q.Get("level")); raw != "" {
		level, err := strconv.Atoi(raw)
		if err != nil {
			return Options{}, errors.New("Invalid level parameter.")
		}
		if opts.CourseType == Hsk && (level < 1 || level > opts.HskStandard.MaxLevel()) {
			return Options{}, fmt.Errorf("HSK %d.0 has levels 1 to %d.", opts.HskStandard, opts.HskStandard.MaxLevel())
		}
		opts.Level = &level
	} else if opts.CourseType != Other {
		// Only a free-form course may come without a level.
		return Options{}, errors.New("Invalid or missing level parameter.")
	}

	lesson, err := strconv.Atoi(strings.TrimSpace(q.Get("lessonNumber")))
	if err != nil || lesson < 1 {
		return Options{}, errors.New("Invalid or missing lessonNumber parameter.")
	}
	opts.LessonNumber = &lesson
	// A book we hold the lessons of has a known number of them; for any other course the number is the
	// teacher's word, since the model only reads it as a position in a book it recalls.
	if book := textbookFor(opts); book != nil && lesson > book.lessons {
		return Options{}, fmt.Errorf("Lesson must be 1 to %d for %s.", book.lessons, book.title)
	}

	opts.Intelligence = DefaultIntelligence
	if raw := strings.TrimSpace(q.Get("intelligence")); raw != "" {
		intelligence, err := strconv.Atoi(raw)
		if err != nil || intelligence < 1 || intelligence > IntelligenceLevels {
			return Options{}, errors.New("Invalid intelligence parameter.")
		}
		opts.Intelligence = intelligence
	}

	// The two gesture quiz settings belong to that platform alone: for the others they are ignored,
	// even when invalid, so a stale parameter cannot make a GimKit request fail.
	if opts.ExportType == GestureQuiz {
		if opts.GestureStages, err = parseGestureStages(q.Get("gestureStages")); err != nil {
			return Options{}, err
		}
		opts.QuestionsPerStage = DefaultQuestionsPerStage
		if raw := strings.TrimSpace(q.Get("questionsPerStage")); raw != "" {
			n, err := strconv.Atoi(raw)
			if err != nil || n < MinQuestionsPerStage || n > MaxQuestionsPerStage {
				return Options{}, errors.New("Invalid questionsPerStage parameter.")
			}
			opts.QuestionsPerStage = n
		}
	}
	return opts, nil
}

// parseGestureStages reads the comma-separated stage numbers, in any order, and returns them
// ascending. A stage is a single digit, so anything else (an empty element, 0, 7, "03", "+3", a
// repeat) is invalid rather than guessed at. An absent or blank value means every stage.
func parseGestureStages(raw string) ([]int, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return AllGestureStages(), nil
	}
	var stages []int
	for _, part := range strings.Split(raw, ",") {
		part = strings.TrimSpace(part)
		if len(part) != 1 || part[0] < '1' || part[0] > '0'+GestureStageCount {
			return nil, errors.New("Invalid gestureStages parameter.")
		}
		stage := int(part[0] - '0')
		if slices.Contains(stages, stage) {
			return nil, errors.New("Invalid gestureStages parameter.")
		}
		stages = append(stages, stage)
	}
	slices.Sort(stages)
	return stages, nil
}

// parseEnum accepts an ordinal or a member name (case-insensitive).
func parseEnum(raw string, names []string) (int, bool) {
	raw = strings.TrimSpace(raw)
	if n, err := strconv.Atoi(raw); err == nil {
		return n, n >= 0 && n < len(names)
	}
	for i, name := range names {
		if strings.EqualFold(raw, name) {
			return i, true
		}
	}
	return 0, false
}
