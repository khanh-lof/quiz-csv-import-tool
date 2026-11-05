package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// MongoLoginAttempts keeps one document per key: {_id: key, count, windowStart, expiresAt}.
type MongoLoginAttempts struct {
	attempts *mongo.Collection
	now      func() time.Time
}

func NewMongoLoginAttempts(attempts *mongo.Collection) *MongoLoginAttempts {
	return &MongoLoginAttempts{attempts: attempts, now: time.Now}
}

// EnsureIndexes creates the TTL index that deletes a window once it is over. Like the other
// EnsureIndexes, the server does not call it on start; without it the ended windows simply stay.
func (m *MongoLoginAttempts) EnsureIndexes(ctx context.Context) error {
	_, err := m.attempts.Indexes().CreateOne(ctx, mongo.IndexModel{
		Keys:    bson.D{{Key: "expiresAt", Value: 1}},
		Options: options.Index().SetName("expiresAt_ttl").SetExpireAfterSeconds(0),
	})
	return err
}

func (m *MongoLoginAttempts) TryConsume(ctx context.Context, key string, limit int, window time.Duration) (time.Time, bool, error) {
	for range maxUpdateAttempts {
		now := m.now().UTC().Truncate(time.Millisecond)
		windowStartedAfter := now.Add(-window)

		err := m.attempts.FindOneAndUpdate(ctx, bson.M{
			"_id":         key,
			"windowStart": bson.M{"$gt": windowStartedAfter},
			"count":       bson.M{"$lt": limit},
		}, bson.M{"$inc": bson.M{"count": 1}}).Err()
		if err == nil {
			return time.Time{}, true, nil
		}
		if !errors.Is(err, mongo.ErrNoDocuments) {
			return time.Time{}, false, err
		}

		// No window running for key: this attempt starts one. When a full window is running instead, the
		// filter misses it and the upsert collides with its _id.
		_, err = m.attempts.UpdateOne(ctx, bson.M{
			"_id":         key,
			"windowStart": bson.M{"$lte": windowStartedAfter},
		}, bson.M{"$set": bson.M{"count": 1, "windowStart": now, "expiresAt": now.Add(window)}},
			options.UpdateOne().SetUpsert(true))
		if err == nil {
			return time.Time{}, true, nil
		}
		if !mongo.IsDuplicateKeyError(err) {
			return time.Time{}, false, err
		}

		var current struct {
			Count       int       `bson:"count"`
			WindowStart time.Time `bson:"windowStart"`
		}
		err = m.attempts.FindOne(ctx, bson.M{"_id": key}).Decode(&current)
		if errors.Is(err, mongo.ErrNoDocuments) {
			continue
		}
		if err != nil {
			return time.Time{}, false, err
		}
		if current.Count >= limit && current.WindowStart.After(windowStartedAfter) {
			return current.WindowStart.UTC().Add(window), false, nil
		}
		// A concurrent attempt started the window between the two writes: count this one in it.
	}
	return time.Time{}, false, fmt.Errorf("counting a login attempt: %w", ErrConflict)
}

func (m *MongoLoginAttempts) Reset(ctx context.Context, key string) error {
	_, err := m.attempts.DeleteOne(ctx, bson.M{"_id": key})
	return err
}
