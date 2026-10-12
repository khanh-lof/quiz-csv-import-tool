// Package csvgen turns lesson images into quiz CSV through an OpenAI-compatible vision model.
package csvgen

import (
	"errors"
	"fmt"
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
}

// CourseDisplayName is the course name handed to the model. For HSK and YCT it names the textbook,
// since lesson numbers only exist there (the exam syllabuses have levels but no lessons).
func (o Options) CourseDisplayName() string {
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
