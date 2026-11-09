package store

import (
	"context"
	"errors"
	"slices"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// MongoRadicalDetails keys every detail by its id, so it needs no index of its own.
type MongoRadicalDetails struct {
	details *mongo.Collection
}

func NewMongoRadicalDetails(details *mongo.Collection) *MongoRadicalDetails {
	return &MongoRadicalDetails{details: details}
}

func (m *MongoRadicalDetails) Lookup(ctx context.Context, ids []string) (map[string]RadicalDetail, error) {
	found := map[string]RadicalDetail{}
	if len(ids) == 0 {
		return found, nil
	}
	filter := bson.M{"_id": bson.M{"$in": ids}, "status": RadicalActive}
	cursor, err := m.details.Find(ctx, filter)
	if err != nil {
		return nil, err
	}
	var details []RadicalDetail
	if err := cursor.All(ctx, &details); err != nil {
		return nil, err
	}
	hit := make(bson.A, 0, len(details))
	for _, d := range details {
		found[d.ID] = d
		hit = append(hit, d.ID)
	}
	if len(hit) > 0 {
		// Counting is a help for the admin, not worth failing the lookup over.
		_, _ = m.details.UpdateMany(ctx, bson.M{"_id": bson.M{"$in": hit}}, bson.M{"$inc": bson.M{"uses": 1}})
	}
	return found, nil
}

func (m *MongoRadicalDetails) Save(ctx context.Context, details []RadicalDetail) error {
	if len(details) == 0 {
		return nil
	}
	models := make([]mongo.WriteModel, len(details))
	for i, d := range details {
		d.CreatedAt = storedTime(d.CreatedAt)
		// $setOnInsert: the first answer stays, so an exercise never changes under a teacher's feet.
		models[i] = mongo.NewUpdateOneModel().SetFilter(bson.M{"_id": d.ID}).
			SetUpdate(bson.M{"$setOnInsert": d}).SetUpsert(true)
	}
	_, err := m.details.BulkWrite(ctx, models, options.BulkWrite().SetOrdered(false))
	// Two exercises storing the same new note at once race on the upsert; the loser's duplicate key means the
	// note is stored, which is all Save promises.
	var bulk mongo.BulkWriteException
	if errors.As(err, &bulk) && bulk.WriteConcernError == nil &&
		!slices.ContainsFunc(bulk.WriteErrors, func(e mongo.BulkWriteError) bool { return !mongo.IsDuplicateKeyError(e.WriteError) }) {
		return nil
	}
	return err
}
