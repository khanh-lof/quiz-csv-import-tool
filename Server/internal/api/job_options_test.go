package api

import (
	"reflect"
	"testing"

	"quiz-csv-import-tool/server/internal/csvgen"
	"quiz-csv-import-tool/server/internal/store"
)

func TestJobOptionsRoundTrip(t *testing.T) {
	level := 3
	cases := map[string]struct {
		creative bool
		opts     csvgen.Options
	}{
		"formatted": {false, csvgen.Options{Language: csvgen.English}},
		"hsk wayground": {true, csvgen.Options{
			ExportType: csvgen.Wayground, CourseType: csvgen.Hsk, HskStandard: csvgen.Hsk3, Level: &level,
			LessonNumbers: []int{2, 3},
		}},
		"other blooket": {true, csvgen.Options{
			Language: csvgen.English, ExportType: csvgen.Blooket, CourseType: csvgen.Other, CourseName: "Unit book",
			LessonNumbers: []int{1},
		}},
		"yct game": {true, csvgen.Options{
			ExportType: csvgen.GestureQuiz, CourseType: csvgen.Yct, Level: &level, LessonNumbers: []int{4},
			GestureStages: []int{4, 6}, QuestionsPerStage: 7,
		}},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			got, ok := retryOptions(newJob("title", c.creative, 0, c.opts))
			if !ok {
				t.Fatal("retryOptions refused a job newJob made")
			}
			if !reflect.DeepEqual(got, c.opts) {
				t.Errorf("round trip gave %+v, want %+v", got, c.opts)
			}
		})
	}
}

func TestRetryOptionsRefusesJobsMissingTheirRequest(t *testing.T) {
	game := int(csvgen.GestureQuiz)
	course := int(csvgen.Hsk)
	cases := map[string]*store.Job{
		"no lesson":            {Creative: true, ExportType: &game, CourseType: &course},
		"no games of the game": {Creative: true, ExportType: &game, CourseType: &course, LessonNumbers: []int{1}},
	}
	for name, job := range cases {
		if _, ok := retryOptions(job); ok {
			t.Errorf("%s: retryOptions took the job", name)
		}
	}
}
