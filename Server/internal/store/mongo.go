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

type Mongo struct {
	users *mongo.Collection
	now   func() time.Time
}

func NewMongo(users *mongo.Collection) *Mongo {
	return &Mongo{users: users, now: time.Now}
}

// EnsureIndexes creates the index backing FindByRefreshToken. Safe to call on every start.
func (m *Mongo) EnsureIndexes(ctx context.Context) error {
	_, err := m.users.Indexes().CreateOne(ctx, mongo.IndexModel{
		Keys:    bson.D{{Key: "refreshTokens.token", Value: 1}},
		Options: options.Index().SetName("refreshTokens_token"),
	})
	return err
}

func (m *Mongo) FindByUsername(ctx context.Context, username string) (*User, error) {
	return m.findOne(ctx, bson.M{"_id": username})
}

func (m *Mongo) FindByRefreshToken(ctx context.Context, token string) (*User, error) {
	return m.findOne(ctx, bson.M{"refreshTokens.token": token})
}

func (m *Mongo) findOne(ctx context.Context, filter bson.M) (*User, error) {
	var u User
	err := m.users.FindOne(ctx, filter).Decode(&u)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &u, nil
}

func (m *Mongo) Create(ctx context.Context, user *User) error {
	doc := *user
	if doc.Roles == nil {
		doc.Roles = []string{}
	}
	if doc.RefreshTokens == nil {
		doc.RefreshTokens = []RefreshToken{}
	}
	_, err := m.users.InsertOne(ctx, doc)
	if mongo.IsDuplicateKeyError(err) {
		return ErrDuplicate
	}
	return err
}

func (m *Mongo) UpdateRefreshTokens(ctx context.Context, username string,
	mutate func([]RefreshToken) ([]RefreshToken, bool)) error {
	for range maxUpdateAttempts {
		var current struct {
			Tokens  []RefreshToken `bson:"refreshTokens"`
			Version int64          `bson:"version"`
		}
		err := m.users.FindOne(ctx, bson.M{"_id": username},
			options.FindOne().SetProjection(bson.M{"refreshTokens": 1, "version": 1})).Decode(&current)
		if errors.Is(err, mongo.ErrNoDocuments) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}

		tokens, changed := mutate(current.Tokens)
		if !changed {
			return nil
		}
		if tokens == nil {
			tokens = []RefreshToken{}
		}

		res, err := m.users.UpdateOne(ctx, versionFilter(username, current.Version), bson.M{
			"$set": bson.M{"refreshTokens": tokens},
			"$inc": bson.M{"version": 1},
		})
		if err != nil {
			return err
		}
		if res.MatchedCount == 1 {
			return nil
		}
		// A concurrent write bumped the version first: re-read and retry.
	}
	return fmt.Errorf("updating refresh tokens of %q: %w", username, ErrConflict)
}

// versionFilter matches the document only if nobody wrote it since it was read. Documents
// imported without a version field count as version 0.
func versionFilter(username string, version int64) bson.M {
	if version == 0 {
		return bson.M{"_id": username, "version": bson.M{"$in": bson.A{0, nil}}}
	}
	return bson.M{"_id": username, "version": version}
}

func (m *Mongo) TryConsumeAICall(ctx context.Context, username string, limit int, round time.Duration) (bool, error) {
	now := m.now().UTC()
	roundStartedAfter := now.Add(-round)

	// A round is running and still has room: count this call.
	res, err := m.users.UpdateOne(ctx, bson.M{
		"_id":                username,
		"startRoundTime":     bson.M{"$gt": roundStartedAfter},
		"aiCallCountInRound": bson.M{"$lt": limit},
	}, bson.M{"$inc": bson.M{"aiCallCountInRound": 1}})
	if err != nil {
		return false, err
	}
	if res.MatchedCount == 1 {
		return true, nil
	}

	// No round running (never started, or the last one ended): this call starts a new one.
	res, err = m.users.UpdateOne(ctx, bson.M{
		"_id": username,
		"$or": bson.A{
			bson.M{"startRoundTime": nil},
			bson.M{"startRoundTime": bson.M{"$lte": roundStartedAfter}},
		},
	}, bson.M{"$set": bson.M{"aiCallCountInRound": 1, "startRoundTime": now}})
	if err != nil {
		return false, err
	}
	return res.MatchedCount == 1, nil
}
