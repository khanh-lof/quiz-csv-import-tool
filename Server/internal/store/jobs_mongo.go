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

func (m *MongoJobs) Progress(ctx context.Context, username, id string, rows int) error {
	_, err := m.jobs.UpdateOne(ctx,
		bson.M{"_id": id, "username": username, "status": JobRunning},
		bson.M{"$set": bson.M{"progressRows": rows}})
	return err
}

func (m *MongoJobs) Heartbeat(ctx context.Context, username, id string) error {
	_, err := m.jobs.UpdateOne(ctx,
		bson.M{"_id": id, "username": username, "status": JobRunning},
		bson.M{"$set": bson.M{"heartbeatAt": m.now().UTC()}})
	return err
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

func (m *MongoJobs) SetImages(ctx context.Context, username, id string, images []JobImage, storedAt time.Time) error {
	_, err := m.jobs.UpdateOne(ctx,
		bson.M{"_id": id, "username": username},
		bson.M{"$set": bson.M{"images": images, "imagesStoredAt": storedAt.UTC()}})
	return err
}

// lastSignBefore matches a job whose last sign of life, its heartbeat or before the first one its creation,
// is before t.
func lastSignBefore(t time.Time) bson.M {
	return bson.M{"$or": bson.A{
		bson.M{"heartbeatAt": bson.M{"$lt": t}},
		bson.M{"heartbeatAt": bson.M{"$exists": false}, "createdAt": bson.M{"$lt": t}},
	}}
}

// resumableJob matches a creative job at intelligence resumed fewer than maxResumes times ($not also
// matches a job without the field, never resumed).
func resumableJob(intelligence, maxResumes int) bson.M {
	return bson.M{"creative": true, "intelligence": intelligence, "resumes": bson.M{"$not": bson.M{"$gte": maxResumes}}}
}

func (m *MongoJobs) ExpireRunning(ctx context.Context, username string, cutoffs ExpiryCutoffs, message string) ([]Job, error) {
	stale := lastSignBefore(cutoffs.Before)
	if cutoffs.ResumableIntelligence != 0 {
		resumable := resumableJob(cutoffs.ResumableIntelligence, cutoffs.MaxResumes)
		stale = bson.M{"$or": bson.A{
			bson.M{"$and": bson.A{bson.M{"$nor": bson.A{resumable}}, lastSignBefore(cutoffs.Before)}},
			bson.M{"$and": bson.A{resumable, lastSignBefore(cutoffs.ResumableBefore)}},
		}}
	}
	var expired []Job
	for {
		var job Job
		err := m.jobs.FindOneAndUpdate(ctx,
			bson.M{"username": username, "status": JobRunning, "$and": bson.A{stale}},
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

func (m *MongoJobs) ClaimInterrupted(ctx context.Context, intelligence int, before time.Time, maxResumes int) (*Job, error) {
	var job Job
	err := m.jobs.FindOneAndUpdate(ctx,
		bson.M{"status": JobRunning, "$and": bson.A{resumableJob(intelligence, maxResumes), lastSignBefore(before)}},
		bson.M{"$set": bson.M{"heartbeatAt": m.now().UTC(), "progressRows": 0}, "$inc": bson.M{"resumes": 1}},
		options.FindOneAndUpdate().SetReturnDocument(options.After)).Decode(&job)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &job, nil
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
