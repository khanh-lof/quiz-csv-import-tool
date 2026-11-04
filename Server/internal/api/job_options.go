package api

import (
	"quiz-csv-import-tool/server/internal/csvgen"
	"quiz-csv-import-tool/server/internal/store"
)

// The two functions below are mirror images: what newJob keeps of the options is exactly what retryOptions
// reads back, and a new setting of a job is added to both (TestJobOptionsRoundTrip checks them together).

// newJob describes a job to start. Every job keeps its language, and a creative job its lesson, so the history
// can be filtered by them, and everything else retryOptions needs to ask for the same quiz again.
func newJob(title string, creative bool, imageCount int, opts csvgen.Options) *store.Job {
	job := &store.Job{Title: title, Creative: creative, ImageCount: imageCount, Language: int(opts.Language)}
	if !creative {
		return job
	}
	exportType := int(opts.ExportType)
	courseType := int(opts.CourseType)
	job.ExportType, job.Intelligence, job.CourseType = &exportType, opts.Intelligence, &courseType
	job.Level, job.LessonNumbers = opts.Level, opts.LessonNumbers
	if opts.CourseType == csvgen.Hsk {
		hskStandard := int(opts.HskStandard)
		job.HskStandard = &hskStandard
	}
	if opts.CourseType == csvgen.Other {
		job.CourseName = opts.CourseName
	}
	if opts.ExportType == csvgen.GestureQuiz {
		questionsPerStage := opts.GestureQuizQuestions()
		job.GestureStages, job.QuestionsPerStage = opts.GestureQuizStages(), &questionsPerStage
	}
	return job
}

// retryOptions rebuilds the options a job was generated with from what the job keeps. False for a creative
// job from before the lesson, or a Game's choice of games, was kept: sending it again would ask for another quiz.
func retryOptions(job *store.Job) (csvgen.Options, bool) {
	if !job.Creative {
		return csvgen.Options{Language: csvgen.Language(job.Language)}, true
	}
	if job.ExportType == nil || job.CourseType == nil || len(job.LessonNumbers) == 0 {
		return csvgen.Options{}, false
	}
	opts := csvgen.Options{
		Language:   csvgen.Language(job.Language),
		ExportType: csvgen.ExportType(*job.ExportType), CourseType: csvgen.CourseType(*job.CourseType),
		CourseName: job.CourseName, Level: job.Level, LessonNumbers: job.LessonNumbers, Intelligence: job.Intelligence,
	}
	if opts.CourseType == csvgen.Hsk {
		opts.HskStandard = csvgen.Hsk2
		if job.HskStandard != nil {
			opts.HskStandard = csvgen.HskStandard(*job.HskStandard)
		}
	}
	if opts.ExportType == csvgen.GestureQuiz {
		if job.GestureStages == nil || job.QuestionsPerStage == nil {
			return csvgen.Options{}, false
		}
		opts.GestureStages, opts.QuestionsPerStage = job.GestureStages, *job.QuestionsPerStage
	}
	return opts, true
}
