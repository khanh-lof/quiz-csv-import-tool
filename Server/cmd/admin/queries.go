package main

import (
	"context"
	"errors"
	"fmt"
	"math"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"quiz-csv-import-tool/server/internal/config"
	"quiz-csv-import-tool/server/internal/store"
)

const pageSize = 50

// queries are what only the admin needs: reads across every user, and the few writes the stores do not
// offer. Everything the stores already do goes through them instead.
type queries struct {
	users         *mongo.Collection
	jobs          *mongo.Collection
	assignments   *mongo.Collection
	players       *mongo.Collection
	questions     *mongo.Collection
	loginAttempts *mongo.Collection
}

func newQueries(db *mongo.Database, cfg config.Config) *queries {
	return &queries{
		users:         db.Collection(cfg.MongoCollection),
		jobs:          db.Collection(cfg.MongoJobsCollection),
		assignments:   db.Collection(cfg.MongoAssignmentsCollection),
		players:       db.Collection(cfg.MongoPlayersCollection),
		questions:     db.Collection(cfg.MongoQuestionsCollection),
		loginAttempts: db.Collection(cfg.MongoLoginAttemptsCollection),
	}
}

func findAll[T any](ctx context.Context, coll *mongo.Collection, filter any, opts ...options.Lister[options.FindOptions]) ([]T, error) {
	cursor, err := coll.Find(ctx, filter, opts...)
	if err != nil {
		return nil, err
	}
	var out []T
	if err := cursor.All(ctx, &out); err != nil {
		return nil, err
	}
	return out, nil
}

func aggregate[T any](ctx context.Context, coll *mongo.Collection, pipeline any) ([]T, error) {
	cursor, err := coll.Aggregate(ctx, pipeline)
	if err != nil {
		return nil, err
	}
	var out []T
	if err := cursor.All(ctx, &out); err != nil {
		return nil, err
	}
	return out, nil
}

func findOne[T any](ctx context.Context, coll *mongo.Collection, filter any, opts ...options.Lister[options.FindOneOptions]) (*T, error) {
	var out T
	err := coll.FindOne(ctx, filter, opts...).Decode(&out)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, store.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &out, nil
}

func distinctStrings(ctx context.Context, coll *mongo.Collection, field string) ([]string, error) {
	var values []string
	if err := coll.Distinct(ctx, field, bson.M{}).Decode(&values); err != nil {
		return nil, err
	}
	slices.Sort(values)
	return values, nil
}

func containsInsensitive(q string) bson.M {
	return bson.M{"$regex": regexp.QuoteMeta(q), "$options": "i"}
}

func pageOptions(page int) *options.FindOptionsBuilder {
	return options.Find().SetSkip(int64((page - 1) * pageSize)).SetLimit(pageSize)
}

func requireMatch(res *mongo.UpdateResult, err error) error {
	if err != nil {
		return err
	}
	if res.MatchedCount == 0 {
		return store.ErrNotFound
	}
	return nil
}

func countIf(field string, value any) bson.M {
	return bson.M{"$sum": bson.M{"$cond": bson.A{bson.M{"$eq": bson.A{"$" + field, value}}, 1, 0}}}
}

var totalTokens = bson.M{"$sum": bson.M{"$add": bson.A{
	bson.M{"$ifNull": bson.A{"$usage.inputTokens", 0}},
	bson.M{"$ifNull": bson.A{"$usage.outputTokens", 0}},
}}}

// Users

func (q *queries) ListUsers(ctx context.Context) ([]store.User, error) {
	return findAll[store.User](ctx, q.users, bson.M{}, options.Find().
		SetSort(bson.D{{Key: "_id", Value: 1}}).
		SetProjection(bson.M{"passwordHash": 0, "spentRefreshTokens": 0}))
}

type userStats struct {
	Jobs        int        `bson:"jobs"`
	Running     int        `bson:"running"`
	Failed      int        `bson:"failed"`
	LastJobAt   *time.Time `bson:"lastJobAt"`
	Tokens      int64      `bson:"tokens"`
	Assignments int        `bson:"-"`
}

func (q *queries) UserStats(ctx context.Context) (map[string]*userStats, error) {
	jobRows, err := aggregate[struct {
		Username string    `bson:"_id"`
		Stats    userStats `bson:",inline"`
	}](ctx, q.jobs, bson.A{bson.M{"$group": bson.M{
		"_id":       "$username",
		"jobs":      bson.M{"$sum": 1},
		"running":   countIf("status", store.JobRunning),
		"failed":    countIf("status", store.JobFailed),
		"lastJobAt": bson.M{"$max": "$createdAt"},
		"tokens":    totalTokens,
	}}})
	if err != nil {
		return nil, err
	}
	stats := map[string]*userStats{}
	for _, row := range jobRows {
		stats[row.Username] = &row.Stats
	}

	assignmentRows, err := aggregate[struct {
		Username string `bson:"_id"`
		Count    int    `bson:"count"`
	}](ctx, q.assignments, bson.A{bson.M{"$group": bson.M{"_id": "$username", "count": bson.M{"$sum": 1}}}})
	if err != nil {
		return nil, err
	}
	for _, row := range assignmentRows {
		if stats[row.Username] == nil {
			stats[row.Username] = &userStats{}
		}
		stats[row.Username].Assignments = row.Count
	}
	return stats, nil
}

func (q *queries) SetPasswordHash(ctx context.Context, username, hash string) error {
	return requireMatch(q.users.UpdateOne(ctx, bson.M{"_id": username}, bson.M{"$set": bson.M{"passwordHash": hash}}))
}

func (q *queries) SetRoles(ctx context.Context, username string, roles []string) error {
	if roles == nil {
		roles = []string{}
	}
	return requireMatch(q.users.UpdateOne(ctx, bson.M{"_id": username}, bson.M{"$set": bson.M{"roles": roles}}))
}

func (q *queries) ResetRateLimit(ctx context.Context, username string) error {
	return requireMatch(q.users.UpdateOne(ctx, bson.M{"_id": username},
		bson.M{"$set": bson.M{"aiCallCountInRound": 0}, "$unset": bson.M{"startRoundTime": ""}}))
}

func (q *queries) DeleteUser(ctx context.Context, username string) error {
	res, err := q.users.DeleteOne(ctx, bson.M{"_id": username})
	if err != nil {
		return err
	}
	if res.DeletedCount == 0 {
		return store.ErrNotFound
	}
	return nil
}

// loginAttempt is a document of store.MongoLoginAttempts.
type loginAttempt struct {
	Key         string    `bson:"_id"`
	Count       int       `bson:"count"`
	WindowStart time.Time `bson:"windowStart"`
	ExpiresAt   time.Time `bson:"expiresAt"`
}

func (q *queries) LoginAttempts(ctx context.Context) ([]loginAttempt, error) {
	return findAll[loginAttempt](ctx, q.loginAttempts, bson.M{"expiresAt": bson.M{"$gt": time.Now()}},
		options.Find().SetSort(bson.D{{Key: "windowStart", Value: -1}}))
}

// Jobs

type jobFilter struct {
	User     string
	Status   string
	Platform string
	Q        string
	Page     int
}

func (f jobFilter) bson() bson.M {
	filter := bson.M{}
	if f.User != "" {
		filter["username"] = f.User
	}
	if f.Status != "" {
		filter["status"] = f.Status
	}
	switch f.Platform {
	case "":
	case "formatted":
		filter["creative"] = false
	default:
		if n, err := strconv.Atoi(f.Platform); err == nil {
			filter["exportType"] = n
		}
	}
	if q := strings.TrimSpace(f.Q); q != "" {
		filter["$or"] = bson.A{
			bson.M{"title": containsInsensitive(q)},
			bson.M{"errorMessage": containsInsensitive(q)},
			bson.M{"_id": q},
		}
	}
	return filter
}

var jobListProjection = bson.M{"csv": 0, "source": 0, "images": 0, "bankQuestions": 0}

func (q *queries) ListJobs(ctx context.Context, f jobFilter) ([]store.Job, int64, error) {
	filter := f.bson()
	total, err := q.jobs.CountDocuments(ctx, filter)
	if err != nil {
		return nil, 0, err
	}
	jobs, err := findAll[store.Job](ctx, q.jobs, filter,
		pageOptions(f.Page).SetSort(bson.D{{Key: "createdAt", Value: -1}}).SetProjection(jobListProjection))
	return jobs, total, err
}

func (q *queries) RunningJobs(ctx context.Context) ([]store.Job, error) {
	return findAll[store.Job](ctx, q.jobs, bson.M{"status": store.JobRunning},
		options.Find().SetSort(bson.D{{Key: "createdAt", Value: 1}}).SetProjection(jobListProjection))
}

func (q *queries) RecentFailures(ctx context.Context, limit int64) ([]store.Job, error) {
	return findAll[store.Job](ctx, q.jobs, bson.M{"status": store.JobFailed},
		options.Find().SetSort(bson.D{{Key: "createdAt", Value: -1}}).SetLimit(limit).SetProjection(jobListProjection))
}

// Job returns the job, whoever owns it, and the rest of its document without the answer and the source.
func (q *queries) Job(ctx context.Context, id string) (*store.Job, bson.M, error) {
	job, err := findOne[store.Job](ctx, q.jobs, bson.M{"_id": id})
	if err != nil {
		return nil, nil, err
	}
	raw, err := findOne[bson.M](ctx, q.jobs, bson.M{"_id": id}, options.FindOne().SetProjection(bson.M{"csv": 0, "source": 0, "images": 0}))
	if err != nil {
		return nil, nil, err
	}
	return job, *raw, nil
}

func (q *queries) JobUsernames(ctx context.Context) ([]string, error) {
	return distinctStrings(ctx, q.jobs, "username")
}

func (q *queries) RunningJobUsernames(ctx context.Context) ([]string, error) {
	var values []string
	err := q.jobs.Distinct(ctx, "username", bson.M{"status": store.JobRunning}).Decode(&values)
	return values, err
}

// Assignments

type assignmentFilter struct {
	User  string
	State string
	Q     string
	Page  int
}

func (f assignmentFilter) bson(now time.Time) bson.M {
	var and bson.A
	if f.User != "" {
		and = append(and, bson.M{"username": f.User})
	}
	switch f.State {
	case "open":
		and = append(and, bson.M{"closedAt": nil, "$or": bson.A{bson.M{"closesAt": nil}, bson.M{"closesAt": bson.M{"$gt": now}}}})
	case "closed":
		and = append(and, bson.M{"$or": bson.A{bson.M{"closedAt": bson.M{"$ne": nil}}, bson.M{"closesAt": bson.M{"$lte": now}}}})
	}
	if q := strings.TrimSpace(f.Q); q != "" {
		and = append(and, bson.M{"$or": bson.A{
			bson.M{"title": containsInsensitive(q)},
			bson.M{"label": containsInsensitive(q)},
			bson.M{"code": strings.ToUpper(q)},
			bson.M{"_id": q},
		}})
	}
	if len(and) == 0 {
		return bson.M{}
	}
	return bson.M{"$and": and}
}

func (q *queries) ListAssignments(ctx context.Context, f assignmentFilter) ([]store.Assignment, int64, error) {
	filter := f.bson(time.Now())
	total, err := q.assignments.CountDocuments(ctx, filter)
	if err != nil {
		return nil, 0, err
	}
	list, err := findAll[store.Assignment](ctx, q.assignments, filter,
		pageOptions(f.Page).SetSort(bson.D{{Key: "createdAt", Value: -1}}).SetProjection(bson.M{"csv": 0}))
	return list, total, err
}

// Assignment returns the assignment, whoever owns it, without its CSV.
func (q *queries) Assignment(ctx context.Context, id string) (*store.Assignment, error) {
	return findOne[store.Assignment](ctx, q.assignments, bson.M{"_id": id}, options.FindOne().SetProjection(bson.M{"csv": 0}))
}

func (q *queries) AssignmentUsernames(ctx context.Context) ([]string, error) {
	return distinctStrings(ctx, q.assignments, "username")
}

// Question bank

type bookSummary struct {
	Book     string     `bson:"book"`
	Language int        `bson:"language"`
	Active   int        `bson:"active"`
	Retired  int        `bson:"retired"`
	Served   int        `bson:"served"`
	Lessons  []int      `bson:"lessons"`
	LastAt   *time.Time `bson:"lastAt"`
}

func (q *queries) BankSummary(ctx context.Context) ([]bookSummary, error) {
	return aggregate[bookSummary](ctx, q.questions, bson.A{
		bson.M{"$group": bson.M{
			"_id":     bson.M{"book": "$book", "language": "$language"},
			"active":  countIf("status", store.QuestionActive),
			"retired": bson.M{"$sum": bson.M{"$cond": bson.A{bson.M{"$eq": bson.A{"$status", store.QuestionActive}}, 0, 1}}},
			"served":  bson.M{"$sum": "$servedCount"},
			"lessons": bson.M{"$addToSet": "$maxLesson"},
			"lastAt":  bson.M{"$max": "$createdAt"},
		}},
		bson.M{"$project": bson.M{
			"_id": 0, "book": "$_id.book", "language": "$_id.language", "active": 1, "retired": 1, "served": 1, "lastAt": 1,
			"lessons": bson.M{"$sortArray": bson.M{"input": "$lessons", "sortBy": 1}},
		}},
		bson.M{"$sort": bson.D{{Key: "language", Value: 1}, {Key: "book", Value: 1}}},
	})
}

type questionFilter struct {
	Book   string
	Lesson int
	Status string
	Q      string
	Page   int
}

func (f questionFilter) bson() bson.M {
	filter := bson.M{}
	if f.Book != "" {
		filter["book"] = f.Book
	}
	if f.Lesson > 0 {
		filter["lessons"] = f.Lesson
	}
	if f.Status != "" {
		filter["status"] = f.Status
	}
	if q := strings.TrimSpace(f.Q); q != "" {
		filter["$or"] = bson.A{
			bson.M{"stem.text": containsInsensitive(q)},
			bson.M{"answer.text": containsInsensitive(q)},
			bson.M{"targets": containsInsensitive(q)},
			bson.M{"_id": q},
			bson.M{"jobId": q},
		}
	}
	return filter
}

func (q *queries) ListQuestions(ctx context.Context, f questionFilter) ([]store.Question, int64, error) {
	filter := f.bson()
	total, err := q.questions.CountDocuments(ctx, filter)
	if err != nil {
		return nil, 0, err
	}
	list, err := findAll[store.Question](ctx, q.questions, filter,
		pageOptions(f.Page).SetSort(bson.D{{Key: "book", Value: 1}, {Key: "maxLesson", Value: 1}, {Key: "createdAt", Value: -1}}))
	return list, total, err
}

func (q *queries) SetQuestionStatus(ctx context.Context, id, status string) error {
	return requireMatch(q.questions.UpdateOne(ctx, bson.M{"_id": id}, bson.M{"$set": bson.M{"status": status}}))
}

// Dashboard

type overview struct {
	Users           int64
	Jobs            int64
	Running         int64
	Done24h         int64
	Failed24h       int64
	Assignments     int64
	OpenAssignments int64
	Players         int64
	BankActive      int64
}

func (q *queries) Overview(ctx context.Context) (overview, error) {
	now := time.Now()
	dayAgo := now.Add(-24 * time.Hour)
	var o overview
	counts := []struct {
		target *int64
		coll   *mongo.Collection
		filter bson.M
	}{
		{&o.Users, q.users, bson.M{}},
		{&o.Jobs, q.jobs, bson.M{}},
		{&o.Running, q.jobs, bson.M{"status": store.JobRunning}},
		{&o.Done24h, q.jobs, bson.M{"status": store.JobDone, "createdAt": bson.M{"$gte": dayAgo}}},
		{&o.Failed24h, q.jobs, bson.M{"status": store.JobFailed, "createdAt": bson.M{"$gte": dayAgo}}},
		{&o.Assignments, q.assignments, bson.M{}},
		{&o.OpenAssignments, q.assignments, assignmentFilter{State: "open"}.bson(now)},
		{&o.Players, q.players, bson.M{}},
		{&o.BankActive, q.questions, bson.M{"status": store.QuestionActive}},
	}
	for _, c := range counts {
		n, err := c.coll.CountDocuments(ctx, c.filter)
		if err != nil {
			return o, fmt.Errorf("counting %s: %w", c.coll.Name(), err)
		}
		*c.target = n
	}
	return o, nil
}

type modelUsage struct {
	Model         string  `bson:"_id"`
	Jobs          int     `bson:"jobs"`
	Calls         int     `bson:"calls"`
	InputTokens   int64   `bson:"input"`
	CachedTokens  int64   `bson:"cached"`
	OutputTokens  int64   `bson:"output"`
	AvgDurationMs float64 `bson:"avgDuration"`
}

func (q *queries) UsageByModel(ctx context.Context, since time.Time) ([]modelUsage, error) {
	return aggregate[modelUsage](ctx, q.jobs, bson.A{
		bson.M{"$match": bson.M{"createdAt": bson.M{"$gte": since}, "usage": bson.M{"$ne": nil}}},
		bson.M{"$group": bson.M{
			"_id":         "$usage.model",
			"jobs":        bson.M{"$sum": 1},
			"calls":       bson.M{"$sum": "$usage.calls"},
			"input":       bson.M{"$sum": "$usage.inputTokens"},
			"cached":      bson.M{"$sum": "$usage.cachedTokens"},
			"output":      bson.M{"$sum": "$usage.outputTokens"},
			"avgDuration": bson.M{"$avg": "$usage.durationMs"},
		}},
		bson.M{"$sort": bson.M{"jobs": -1}},
	})
}

type userActivity struct {
	Username string `bson:"_id"`
	Jobs     int    `bson:"jobs"`
	Failed   int    `bson:"failed"`
	Tokens   int64  `bson:"tokens"`
}

func (q *queries) TopUsers(ctx context.Context, since time.Time, limit int) ([]userActivity, error) {
	return aggregate[userActivity](ctx, q.jobs, bson.A{
		bson.M{"$match": bson.M{"createdAt": bson.M{"$gte": since}}},
		bson.M{"$group": bson.M{"_id": "$username", "jobs": bson.M{"$sum": 1}, "failed": countIf("status", store.JobFailed), "tokens": totalTokens}},
		bson.M{"$sort": bson.D{{Key: "jobs", Value: -1}, {Key: "_id", Value: 1}}},
		bson.M{"$limit": limit},
	})
}

type dayCount struct {
	Day     time.Time
	Done    int
	Failed  int
	Running int
}

func (d dayCount) Total() int {
	return d.Done + d.Failed + d.Running
}

// JobsPerDay counts the jobs of the last days, newest day first. It buckets in Go rather than in MongoDB
// so the days follow this machine's time zone.
func (q *queries) JobsPerDay(ctx context.Context, days int) ([]dayCount, error) {
	now := time.Now()
	first := startOfDay(now).AddDate(0, 0, -(days - 1))
	rows, err := findAll[struct {
		Status    store.JobStatus `bson:"status"`
		CreatedAt time.Time       `bson:"createdAt"`
	}](ctx, q.jobs, bson.M{"createdAt": bson.M{"$gte": first}}, options.Find().SetProjection(bson.M{"status": 1, "createdAt": 1}))
	if err != nil {
		return nil, err
	}
	out := make([]dayCount, days)
	for i := range out {
		out[i].Day = first.AddDate(0, 0, i)
	}
	for _, r := range rows {
		index := int(math.Round(startOfDay(r.CreatedAt).Sub(first).Hours() / 24))
		if index < 0 || index >= days {
			continue
		}
		switch r.Status {
		case store.JobDone:
			out[index].Done++
		case store.JobFailed:
			out[index].Failed++
		default:
			out[index].Running++
		}
	}
	slices.Reverse(out)
	return out, nil
}

func startOfDay(t time.Time) time.Time {
	local := t.In(time.Local)
	return time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, time.Local)
}
