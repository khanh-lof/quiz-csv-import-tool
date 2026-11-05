package store

import (
	"context"
	"errors"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

type MongoJobs struct {
	jobs *mongo.Collection
	now  func() time.Time
}

func NewMongoJobs(jobs *mongo.Collection) *MongoJobs {
	return &MongoJobs{jobs: jobs, now: time.Now}
}

// EnsureIndexes creates the index behind List and Prune. Like Mongo.EnsureIndexes, the server does not
// call it on start (it would slow every cold start); create it once by hand or from a one-off tool.
func (m *MongoJobs) EnsureIndexes(ctx context.Context) error {
	_, err := m.jobs.Indexes().CreateOne(ctx, mongo.IndexModel{
		Keys:    bson.D{{Key: "username", Value: 1}, {Key: "createdAt", Value: -1}},
		Options: options.Index().SetName("username_createdAt"),
	})
	return err
}

func (m *MongoJobs) Create(ctx context.Context, job *Job) error {
	_, err := m.jobs.InsertOne(ctx, job)
	if mongo.IsDuplicateKeyError(err) {
		return ErrDuplicate
	}
	return err
}

func (m *MongoJobs) Complete(ctx context.Context, username, id, csv, source string, usage JobUsage) error {
	set := bson.M{"status": JobDone, "csv": csv, "usage": usage}
	if source != "" {
		set["source"] = source
	}
	return m.finish(ctx, username, id, set)
}

func (m *MongoJobs) Revise(ctx context.Context, username, id, csv, source string) error {
	res, err := m.jobs.UpdateOne(ctx,
		bson.M{"_id": id, "username": username, "status": JobDone},
		bson.M{"$set": bson.M{"csv": csv, "source": source}})
	if err != nil {
		return err
	}
	if res.MatchedCount == 0 {
		return ErrNotFound
	}
	return nil
}

func (m *MongoJobs) Fail(ctx context.Context, username, id string, failure JobFailure, usage JobUsage) error {
	return m.finish(ctx, username, id, bson.M{
		"status": JobFailed, "errorStatus": failure.Status, "errorCode": failure.Code, "errorMessage": failure.Message, "usage": usage,
	})
}

// finish only touches a job that is still running, so a job expired as abandoned is not revived by a
// late answer, and a finished one is never overwritten.
func (m *MongoJobs) finish(ctx context.Context, username, id string, set bson.M) error {
	set["finishedAt"] = m.now().UTC()
	_, err := m.jobs.UpdateOne(ctx,
		bson.M{"_id": id, "username": username, "status": JobRunning},
		bson.M{"$set": set})
	return err
}

func (m *MongoJobs) Get(ctx context.Context, username, id string) (*Job, error) {
	var job Job
	err := m.jobs.FindOne(ctx, bson.M{"_id": id, "username": username}).Decode(&job)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &job, nil
}

func (m *MongoJobs) List(ctx context.Context, username string, limit int) ([]Job, error) {
	if limit <= 0 {
		// Mongo reads a limit of 0 as "no limit"; the memory store returns nothing.
		return []Job{}, nil
	}
	// The source of a Radicals job is only read to rebuild it, never by the history the list feeds.
	cursor, err := m.jobs.Find(ctx, bson.M{"username": username},
		options.Find().SetSort(bson.D{{Key: "createdAt", Value: -1}}).SetLimit(int64(limit)).
			SetProjection(bson.M{"source": 0}))
	if err != nil {
		return nil, err
	}
	jobs := []Job{}
	if err := cursor.All(ctx, &jobs); err != nil {
		return nil, err
	}
	return jobs, nil
}

func (m *MongoJobs) Delete(ctx context.Context, username, id string) error {
	res, err := m.jobs.DeleteOne(ctx, bson.M{"_id": id, "username": username})
	if err != nil {
		return err
	}
	if res.DeletedCount == 0 {
		return ErrNotFound
	}
	return nil
}

func (m *MongoJobs) ExpireRunning(ctx context.Context, username string, before time.Time, message string) ([]Job, error) {
	var expired []Job
	for {
		var job Job
		err := m.jobs.FindOneAndUpdate(ctx,
			bson.M{"username": username, "status": JobRunning, "createdAt": bson.M{"$lt": before}},
			bson.M{"$set": bson.M{
				"status": JobFailed, "errorStatus": ExpiredJobStatus, "errorCode": ExpiredJobCode, "errorMessage": message,
				"finishedAt": m.now().UTC(),
			}},
			options.FindOneAndUpdate().SetReturnDocument(options.After)).Decode(&job)
		if errors.Is(err, mongo.ErrNoDocuments) {
			return expired, nil
		}
		if err != nil {
			return expired, err
		}
		expired = append(expired, job)
	}
}

func (m *MongoJobs) Prune(ctx context.Context, username string, keep int) error {
	cursor, err := m.jobs.Find(ctx, bson.M{"username": username},
		options.Find().SetSort(bson.D{{Key: "createdAt", Value: -1}}).SetSkip(int64(keep)).
			SetProjection(bson.M{"_id": 1}))
	if err != nil {
		return err
	}
	var old []struct {
		ID string `bson:"_id"`
	}
	if err := cursor.All(ctx, &old); err != nil || len(old) == 0 {
		return err
	}
	ids := make(bson.A, len(old))
	for i, j := range old {
		ids[i] = j.ID
	}
	// Never prune a running job: its answer would be written into nothing.
	_, err = m.jobs.DeleteMany(ctx, bson.M{"username": username, "_id": bson.M{"$in": ids}, "status": bson.M{"$ne": JobRunning}})
	return err
}
