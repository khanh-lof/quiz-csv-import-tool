package store

import (
	"context"
	"time"
)

// Question is one question of the shared question bank: written once by the AI for a lesson of an embedded
// textbook, then picked into the quizzes of every teacher who asks for that lesson (package bank builds the
// quizzes). Unlike jobs and assignments, the bank belongs to no user.
type Question struct {
	ID string `bson:"_id"`
	// Language is the csvgen.Language ordinal; Book the textbook's folder, e.g. "hsk3-1".
	Language int    `bson:"language"`
	Book     string `bson:"book"`
	// Lessons are the lessons of the words it tests, ascending.
	Lessons []int `bson:"lessons"`
	// MaxLesson is the highest lesson of the request it was written for: its sentences and wrong answers may use
	// any word up to that lesson, so it is only picked for a request whose highest lesson is at least as high.
	MaxLesson int `bson:"maxLesson"`
	// Targets are the keys (csvgen.LessonWord.Key) of the words it tests, at least one.
	Targets []string `bson:"targets"`
	// Format, Skill and Difficulty are package bank's: the shape of the question (which platforms can show it),
	// what it practises, and 1 (easy) to 3 (hard).
	Format     string `bson:"format"`
	Skill      string `bson:"skill"`
	Difficulty int    `bson:"difficulty"`
	Stem       Text   `bson:"stem"`
	Answer     Text   `bson:"answer"`
	// Distractors are the wrong answers, the most plausible first.
	Distractors []Text `bson:"distractors,omitempty"`
	// Chunks are a sentence-ordering question's pieces, in the right order.
	Chunks      []Text `bson:"chunks,omitempty"`
	Explanation string `bson:"explanation"`
	ImageURL    string `bson:"imageUrl,omitempty"`
	// Fingerprint identifies the question's content (package bank's Fingerprint); a book holds each one once.
	Fingerprint string `bson:"fingerprint"`
	// Model and JobID say where it came from.
	Model string `bson:"model,omitempty"`
	JobID string `bson:"jobId,omitempty"`
	// Status is QuestionActive or QuestionRetired; only active questions are picked.
	Status string `bson:"status"`
	// ServedCount is how many quizzes picked it, and LastServedAt when the last did: the least used go first.
	ServedCount  int        `bson:"servedCount"`
	LastServedAt *time.Time `bson:"lastServedAt,omitempty"`
	CreatedAt    time.Time  `bson:"createdAt"`
}

// Text is a text of a question with its pinyin, empty when it has no Chinese.
type Text struct {
	Text   string `bson:"text"`
	Pinyin string `bson:"pinyin,omitempty"`
}

// The statuses of a question.
const (
	QuestionActive  = "active"
	QuestionRetired = "retired"
)

// QuestionBank is implemented by MongoQuestionBank (production) and MemoryQuestionBank (tests).
type QuestionBank interface {
	// Pool returns the active questions of a book in a language whose MaxLesson is at most maxLesson.
	Pool(ctx context.Context, language int, book string, maxLesson int) ([]Question, error)
	// Insert stores new questions, leaving out those whose fingerprint the book already holds (or that repeat
	// one earlier in the list), and returns the ids of the ones it stored.
	Insert(ctx context.Context, questions []Question) ([]string, error)
	// MarkServed counts one more quiz for each question.
	MarkServed(ctx context.Context, ids []string, at time.Time) error
}
