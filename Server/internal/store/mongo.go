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

// EnsureIndexes creates the indexes backing FindByRefreshTokenHash. Safe to call on every start.
func (m *Mongo) EnsureIndexes(ctx context.Context) error {
	_, err := m.users.Indexes().CreateMany(ctx, []mongo.IndexModel{
		{
			Keys:    bson.D{{Key: "refreshTokens.tokenHash", Value: 1}},
			Options: options.Index().SetName("refreshTokens_tokenHash"),
		},
		{
			Keys:    bson.D{{Key: "spentRefreshTokens.tokenHash", Value: 1}},
			Options: options.Index().SetName("spentRefreshTokens_tokenHash"),
		},
	})
	return err
}

func (m *Mongo) FindByUsername(ctx context.Context, username string) (*User, error) {
	return m.findOne(ctx, bson.M{"_id": username})
}

func (m *Mongo) FindByRefreshTokenHash(ctx context.Context, hash string) (*User, error) {
	return m.findOne(ctx, bson.M{"$or": bson.A{
		bson.M{"refreshTokens.tokenHash": hash},
		bson.M{"spentRefreshTokens.tokenHash": hash},
	}})
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
	if doc.SpentRefreshTokens == nil {
		doc.SpentRefreshTokens = []SpentRefreshToken{}
	}
	_, err := m.users.InsertOne(ctx, doc)
	if mongo.IsDuplicateKeyError(err) {
		return ErrDuplicate
	}
	return err
}

func (m *Mongo) UpdateSessions(ctx context.Context, username string, mutate func(*Sessions) bool) error {
	for range maxUpdateAttempts {
		var current struct {
			Sessions `bson:",inline"`
			Version  int64 `bson:"version"`
		}
		err := m.users.FindOne(ctx, bson.M{"_id": username}, options.FindOne().SetProjection(
			bson.M{"refreshTokens": 1, "spentRefreshTokens": 1, "version": 1})).Decode(&current)
		if errors.Is(err, mongo.ErrNoDocuments) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}

		s := current.Sessions
		if !mutate(&s) {
			return nil
		}
		// Store empty arrays, not null.
		if s.Active == nil {
			s.Active = []RefreshToken{}
		}
		if s.Spent == nil {
			s.Spent = []SpentRefreshToken{}
		}

		res, err := m.users.UpdateOne(ctx, versionFilter(username, current.Version), bson.M{
			"$set": bson.M{"refreshTokens": s.Active, "spentRefreshTokens": s.Spent},
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
	return fmt.Errorf("updating sessions of %q: %w", username, ErrConflict)
}

// versionFilter matches the document only if nobody wrote it since it was read. Documents
// imported without a version field count as version 0.
func versionFilter(username string, version int64) bson.M {
	if version == 0 {
		return bson.M{"_id": username, "version": bson.M{"$in": bson.A{0, nil}}}
	}
	return bson.M{"_id": username, "version": version}
}

func (m *Mongo) TryConsumeAICall(ctx context.Context, username string, limit int, round time.Duration) (time.Time, bool, error) {
	// BSON dates hold milliseconds; truncating keeps the returned round start equal to the stored one.
	now := m.now().UTC().Truncate(time.Millisecond)
	roundStartedAfter := now.Add(-round)

	// A round is running and still has room: count this call.
	var running struct {
		StartRoundTime time.Time `bson:"startRoundTime"`
	}
	err := m.users.FindOneAndUpdate(ctx, bson.M{
		"_id":                username,
		"startRoundTime":     bson.M{"$gt": roundStartedAfter},
		"aiCallCountInRound": bson.M{"$lt": limit},
	}, bson.M{"$inc": bson.M{"aiCallCountInRound": 1}},
		options.FindOneAndUpdate().SetProjection(bson.M{"startRoundTime": 1})).Decode(&running)
	if err == nil {
		return running.StartRoundTime.UTC(), true, nil
	}
	if !errors.Is(err, mongo.ErrNoDocuments) {
		return time.Time{}, false, err
	}

	// No round running (never started, or the last one ended): this call starts a new one.
	res, err := m.users.UpdateOne(ctx, bson.M{
		"_id": username,
		"$or": bson.A{
			bson.M{"startRoundTime": nil},
			bson.M{"startRoundTime": bson.M{"$lte": roundStartedAfter}},
		},
	}, bson.M{"$set": bson.M{"aiCallCountInRound": 1, "startRoundTime": now}})
	if err != nil {
		return time.Time{}, false, err
	}
	if res.MatchedCount != 1 {
		return time.Time{}, false, nil
	}
	return now, true, nil
}

func (m *Mongo) RefundAICall(ctx context.Context, username string, roundStart time.Time) error {
	_, err := m.users.UpdateOne(ctx, bson.M{
		"_id":                username,
		"startRoundTime":     roundStart,
		"aiCallCountInRound": bson.M{"$gt": 0},
	}, bson.M{"$inc": bson.M{"aiCallCountInRound": -1}})
	return err
}
