package store

import (
	"context"
	"errors"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

type MongoQuestionBank struct {
	questions *mongo.Collection
}

func NewMongoQuestionBank(questions *mongo.Collection) *MongoQuestionBank {
	return &MongoQuestionBank{questions: questions}
}

// EnsureIndexes creates the index behind Pool and the one that keeps a book's fingerprints unique. Like the other
// stores' it is not called on start; create them once by hand (see Server/AGENTS.md) or from a one-off tool.
func (m *MongoQuestionBank) EnsureIndexes(ctx context.Context) error {
	_, err := m.questions.Indexes().CreateMany(ctx, []mongo.IndexModel{
		{
			Keys:    bson.D{{Key: "book", Value: 1}, {Key: "language", Value: 1}, {Key: "maxLesson", Value: 1}},
			Options: options.Index().SetName("book_language_maxLesson"),
		},
		{
			Keys:    bson.D{{Key: "book", Value: 1}, {Key: "fingerprint", Value: 1}},
			Options: options.Index().SetName("book_fingerprint").SetUnique(true),
		},
	})
	return err
}

func (m *MongoQuestionBank) Pool(ctx context.Context, language int, book string, maxLesson int) ([]Question, error) {
	cursor, err := m.questions.Find(ctx, bson.M{
		"book": book, "language": language, "maxLesson": bson.M{"$lte": maxLesson}, "status": QuestionActive,
	})
	if err != nil {
		return nil, err
	}
	questions := []Question{}
	if err := cursor.All(ctx, &questions); err != nil {
		return nil, err
	}
	return questions, nil
}

func (m *MongoQuestionBank) Insert(ctx context.Context, questions []Question) ([]string, error) {
	fresh, err := m.unknown(ctx, questions)
	if err != nil || len(fresh) == 0 {
		return nil, err
	}
	docs := make([]any, len(fresh))
	for i := range fresh {
		docs[i] = fresh[i]
	}
	// Unordered, so a duplicate (another server storing the same question meanwhile, caught by the unique
	// index) skips only itself.
	_, err = m.questions.InsertMany(ctx, docs, options.InsertMany().SetOrdered(false))
	skipped := map[int]bool{}
	var bulk mongo.BulkWriteException
	if errors.As(err, &bulk) && bulk.WriteConcernError == nil {
		for _, writeErr := range bulk.WriteErrors {
			if !mongo.IsDuplicateKeyError(writeErr.WriteError) {
				return nil, err
			}
			skipped[writeErr.Index] = true
		}
		err = nil
	}
	if err != nil {
		return nil, err
	}
	ids := make([]string, 0, len(fresh))
	for i, q := range fresh {
		if !skipped[i] {
			ids = append(ids, q.ID)
		}
	}
	return ids, nil
}

// unknown is questions without the ones whose fingerprint their book already holds or an earlier one repeats.
// It keeps the bank free of repeats where the unique index has not been created.
func (m *MongoQuestionBank) unknown(ctx context.Context, questions []Question) ([]Question, error) {
	byBook := map[string][]string{}
	for _, q := range questions {
		byBook[q.Book] = append(byBook[q.Book], q.Fingerprint)
	}
	held := map[string]bool{}
	for book, fingerprints := range byBook {
		cursor, err := m.questions.Find(ctx, bson.M{"book": book, "fingerprint": bson.M{"$in": fingerprints}},
			options.Find().SetProjection(bson.M{"fingerprint": 1}))
		if err != nil {
			return nil, err
		}
		var found []struct {
			Fingerprint string `bson:"fingerprint"`
		}
		if err := cursor.All(ctx, &found); err != nil {
			return nil, err
		}
		for _, f := range found {
			held[book+"\x00"+f.Fingerprint] = true
		}
	}
	var fresh []Question
	for _, q := range questions {
		key := q.Book + "\x00" + q.Fingerprint
		if !held[key] {
			held[key] = true
			fresh = append(fresh, q)
		}
	}
	return fresh, nil
}

func (m *MongoQuestionBank) MarkServed(ctx context.Context, ids []string, at time.Time) error {
	if len(ids) == 0 {
		return nil
	}
	_, err := m.questions.UpdateMany(ctx, bson.M{"_id": bson.M{"$in": ids}},
		bson.M{"$inc": bson.M{"servedCount": 1}, "$set": bson.M{"lastServedAt": storedTime(at)}})
	return err
}
