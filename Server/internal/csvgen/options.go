// Package csvgen turns lesson images into quiz CSV through an OpenAI-compatible vision model.
package csvgen

import (
	"errors"
	"net/url"
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
)

var exportTypeNames = []string{"GimKit", "Blooket", "Wayground"}

// CourseType identifies the course a lesson belongs to. Sent by ordinal; keep in the same order
// as Client/src/models/course-type.ts.
type CourseType int

const (
	Hsk CourseType = iota
	Yct
	Other
)

var courseTypeNames = []string{"Hsk", "Yct", "Other"}

// IntelligenceLevels is how many "Độ thông minh" levels the GUI offers (1 = Thấp, 2 = Cao); each
// picks one model from LLM_INTELLIGENCE_MODELS, cheapest first.
const IntelligenceLevels = 2

// DefaultIntelligence is used when the client sends none; it matches the GUI default (Thấp).
const DefaultIntelligence = 1

// Options is everything the creative prompt needs to know about the lesson. Level is optional for
// CourseType Other, and images are optional altogether: without them the model falls back to the
// canonical word list of the lesson.
type Options struct {
	ExportType ExportType
	CourseType CourseType
	// CourseName is free text, only used when CourseType is Other.
	CourseName   string
	Level        *int
	LessonNumber *int
	// Intelligence is 1..IntelligenceLevels and selects the model, see Client.modelFor.
	Intelligence int
}

// CourseDisplayName is the course name handed to the model. For HSK and YCT it names the textbook,
// since lesson numbers only exist there (the exam syllabuses have levels but no lessons).
func (o Options) CourseDisplayName() string {
	switch o.CourseType {
	case Hsk:
		return "HSK, taught from 《HSK标准教程》 HSK Standard Course (Giáo trình chuẩn HSK)"
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
		opts.Level = &level
	} else if opts.CourseType != Other {
		// Only a free-form course may come without a level.
		return Options{}, errors.New("Invalid or missing level parameter.")
	}

	lesson, err := strconv.Atoi(strings.TrimSpace(q.Get("lessonNumber")))
	if err != nil {
		return Options{}, errors.New("Invalid or missing lessonNumber parameter.")
	}
	opts.LessonNumber = &lesson

	opts.Intelligence = DefaultIntelligence
	if raw := strings.TrimSpace(q.Get("intelligence")); raw != "" {
		intelligence, err := strconv.Atoi(raw)
		if err != nil || intelligence < 1 || intelligence > IntelligenceLevels {
			return Options{}, errors.New("Invalid intelligence parameter.")
		}
		opts.Intelligence = intelligence
	}
	return opts, nil
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
