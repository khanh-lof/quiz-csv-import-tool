package store

import (
	"context"
	"errors"
	"fmt"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// MongoAssignments keeps assignments and their players in two collections. Players are a collection
// of their own, not an array on the assignment, so many students finishing a stage at the same
// moment write different documents.
type MongoAssignments struct {
	assignments *mongo.Collection
	players     *mongo.Collection
}

func NewMongoAssignments(assignments, players *mongo.Collection) *MongoAssignments {
	return &MongoAssignments{assignments: assignments, players: players}
}

// EnsureIndexes creates the indexes behind the lookups by code, by owner and by a player's token, and
// the uniqueness of a code and of a name within an assignment (a token needs no unique index: it is 256
// random bits). Like MongoJobs.EnsureIndexes, the server does not call it on
// start (it would slow every cold start); create them once by hand or from a one-off tool.
func (m *MongoAssignments) EnsureIndexes(ctx context.Context) error {
	if _, err := m.assignments.Indexes().CreateMany(ctx, []mongo.IndexModel{
		{
			Keys:    bson.D{{Key: "code", Value: 1}},
			Options: options.Index().SetName("code").SetUnique(true),
		},
		{
			Keys:    bson.D{{Key: "username", Value: 1}, {Key: "createdAt", Value: -1}},
			Options: options.Index().SetName("username_createdAt"),
		},
	}); err != nil {
		return err
	}
	_, err := m.players.Indexes().CreateMany(ctx, []mongo.IndexModel{
		{
			Keys:    bson.D{{Key: "assignmentId", Value: 1}, {Key: "nameKey", Value: 1}},
			Options: options.Index().SetName("assignmentId_nameKey").SetUnique(true),
		},
		{
			Keys:    bson.D{{Key: "assignmentId", Value: 1}, {Key: "tokenHash", Value: 1}},
			Options: options.Index().SetName("assignmentId_tokenHash"),
		},
	})
	return err
}

// Create checks the code before inserting, so a clash is reported even where EnsureIndexes was never
// run (the unique index still closes the race between two simultaneous creates).
func (m *MongoAssignments) Create(ctx context.Context, a *Assignment) error {
	err := m.assignments.FindOne(ctx, bson.M{"code": a.Code},
		options.FindOne().SetProjection(bson.M{"_id": 1})).Err()
	if err == nil {
		return ErrDuplicate
	}
	if !errors.Is(err, mongo.ErrNoDocuments) {
		return err
	}
	doc := a.stored()
	_, err = m.assignments.InsertOne(ctx, doc)
	if mongo.IsDuplicateKeyError(err) {
		return ErrDuplicate
	}
	return err
}

func (m *MongoAssignments) Get(ctx context.Context, username, id string) (*Assignment, error) {
	return m.findOne(ctx, bson.M{"_id": id, "username": username})
}

func (m *MongoAssignments) GetByCode(ctx context.Context, code string) (*Assignment, error) {
	return m.findOne(ctx, bson.M{"code": code})
}

func (m *MongoAssignments) findOne(ctx context.Context, filter bson.M) (*Assignment, error) {
	var a Assignment
	err := m.assignments.FindOne(ctx, filter).Decode(&a)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &a, nil
}

func (m *MongoAssignments) List(ctx context.Context, username string, limit int) ([]Assignment, error) {
	if limit <= 0 {
		// Mongo reads a limit of 0 as "no limit"; the memory store returns nothing.
		return []Assignment{}, nil
	}
	cursor, err := m.assignments.Find(ctx, bson.M{"username": username},
		options.Find().SetSort(bson.D{{Key: "createdAt", Value: -1}}).SetLimit(int64(limit)).
			SetProjection(bson.M{"csv": 0}))
	if err != nil {
		return nil, err
	}
	list := []Assignment{}
	if err := cursor.All(ctx, &list); err != nil {
		return nil, err
	}
	return list, nil
}

func (m *MongoAssignments) Count(ctx context.Context, username string) (int, error) {
	n, err := m.assignments.CountDocuments(ctx, bson.M{"username": username})
	return int(n), err
}

func (m *MongoAssignments) Update(ctx context.Context, username, id string, u AssignmentUpdate) (*Assignment, error) {
	if u.isEmpty() {
		return m.Get(ctx, username, id)
	}
	set, unset := bson.M{}, bson.M{}
	if u.Label != nil {
		set["label"] = *u.Label
	}
	for field, change := range map[string]TimeChange{"closesAt": u.ClosesAt, "closedAt": u.ClosedAt} {
		switch {
		case !change.Set:
		case change.Value == nil:
			unset[field] = ""
		default:
			set[field] = storedTime(*change.Value)
		}
	}
	// MongoDB rejects an empty $set or $unset, so only the operators in use are sent.
	update := bson.M{}
	if len(set) > 0 {
		update["$set"] = set
	}
	if len(unset) > 0 {
		update["$unset"] = unset
	}
	var a Assignment
	err := m.assignments.FindOneAndUpdate(ctx, bson.M{"_id": id, "username": username}, update,
		options.FindOneAndUpdate().SetReturnDocument(options.After)).Decode(&a)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &a, nil
}

// Delete removes the players only after the assignment itself went, so a delete for somebody else's
// assignment cannot wipe its players.
func (m *MongoAssignments) Delete(ctx context.Context, username, id string) error {
	res, err := m.assignments.DeleteOne(ctx, bson.M{"_id": id, "username": username})
	if err != nil {
		return err
	}
	if res.DeletedCount == 0 {
		return ErrNotFound
	}
	_, err = m.players.DeleteMany(ctx, bson.M{"assignmentId": id})
	return err
}

// CreatePlayer checks the name before inserting, like Create does for the code, so a taken name is
// reported even where EnsureIndexes was never run.
func (m *MongoAssignments) CreatePlayer(ctx context.Context, p *Player) error {
	err := m.players.FindOne(ctx, bson.M{"assignmentId": p.AssignmentID, "nameKey": p.NameKey},
		options.FindOne().SetProjection(bson.M{"_id": 1})).Err()
	if err == nil {
		return ErrDuplicate
	}
	if !errors.Is(err, mongo.ErrNoDocuments) {
		return err
	}
	_, err = m.players.InsertOne(ctx, p.stored())
	if mongo.IsDuplicateKeyError(err) {
		return ErrDuplicate
	}
	return err
}

func (m *MongoAssignments) CountPlayers(ctx context.Context, assignmentIDs []string) (map[string]int, error) {
	counts := make(map[string]int, len(assignmentIDs))
	if len(assignmentIDs) == 0 {
		return counts, nil
	}
	for _, id := range assignmentIDs {
		counts[id] = 0
	}
	cursor, err := m.players.Aggregate(ctx, bson.A{
		bson.M{"$match": bson.M{"assignmentId": bson.M{"$in": assignmentIDs}}},
		bson.M{"$group": bson.M{"_id": "$assignmentId", "n": bson.M{"$sum": 1}}},
	})
	if err != nil {
		return nil, err
	}
	var groups []struct {
		AssignmentID string `bson:"_id"`
		N            int    `bson:"n"`
	}
	if err := cursor.All(ctx, &groups); err != nil {
		return nil, err
	}
	for _, g := range groups {
		counts[g.AssignmentID] = g.N
	}
	return counts, nil
}

// ListPlayers leaves out each player's run: it is the bulk of a document that is being written all the
// time, and the leaderboard it is read for never needs it.
func (m *MongoAssignments) ListPlayers(ctx context.Context, assignmentID string) ([]Player, error) {
	cursor, err := m.players.Find(ctx, bson.M{"assignmentId": assignmentID},
		options.Find().SetSort(bson.D{{Key: "joinedAt", Value: 1}, {Key: "_id", Value: 1}}).
			SetProjection(bson.M{"run": 0}))
	if err != nil {
		return nil, err
	}
	players := []Player{}
	if err := cursor.All(ctx, &players); err != nil {
		return nil, err
	}
	return players, nil
}

func (m *MongoAssignments) PlayerByToken(ctx context.Context, assignmentID, tokenHash string) (*Player, error) {
	var p Player
	err := m.players.FindOne(ctx, bson.M{"assignmentId": assignmentID, "tokenHash": tokenHash}).Decode(&p)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &p, nil
}

// UpdatePlayer follows UpdateSessions: read the player, let change work on a copy, and write back only if
// the version is still the one that was read, so two requests of one player at the same moment (two tabs,
// a double tap, an answer racing the next question) cannot overwrite each other's run. Only stages,
// started, run and lastPlayedAt are written, and a field that came out empty is $unset, so the document
// never holds a null where a reader expects a map or a run.
func (m *MongoAssignments) UpdatePlayer(ctx context.Context, assignmentID, playerID string, change func(p *Player) error) (*Player, error) {
	for range maxUpdateAttempts {
		var read Player
		err := m.players.FindOne(ctx, bson.M{"_id": playerID, "assignmentId": assignmentID}).Decode(&read)
		if errors.Is(err, mongo.ErrNoDocuments) {
			return nil, ErrNotFound
		}
		if err != nil {
			return nil, err
		}

		p := read.stored()
		if p.Started == nil {
			p.Started = map[string]int{}
		}
		if err := change(&p); err != nil {
			return nil, err
		}
		p = p.stored()

		set, unset := bson.M{"stages": p.Stages}, bson.M{}
		if len(p.Started) > 0 {
			set["started"] = p.Started
		} else {
			unset["started"] = ""
		}
		if p.Run != nil {
			set["run"] = p.Run
		} else {
			unset["run"] = ""
		}
		if p.LastPlayedAt != nil {
			set["lastPlayedAt"] = *p.LastPlayedAt
		} else {
			unset["lastPlayedAt"] = ""
		}
		update := bson.M{"$set": set, "$inc": bson.M{"version": 1}}
		if len(unset) > 0 {
			// MongoDB rejects an empty $unset, so the operator is only sent when there is something to remove.
			update["$unset"] = unset
		}

		res, err := m.players.UpdateOne(ctx,
			bson.M{"_id": playerID, "assignmentId": assignmentID, "version": read.Version}, update)
		if err != nil {
			return nil, err
		}
		if res.MatchedCount == 1 {
			p.Version = read.Version + 1
			return &p, nil
		}
		// A concurrent write bumped the version first: re-read and retry.
	}
	return nil, fmt.Errorf("updating player %q: %w", playerID, ErrConflict)
}

// SetPlayerAvatar is a plain $set of the one field. UpdatePlayer $sets only the results and the run,
// never the avatar, so the two writes cannot undo each other and the version needs no bump.
func (m *MongoAssignments) SetPlayerAvatar(ctx context.Context, assignmentID, playerID, avatar string) error {
	res, err := m.players.UpdateOne(ctx, bson.M{"_id": playerID, "assignmentId": assignmentID},
		bson.M{"$set": bson.M{"avatar": avatar}})
	if err != nil {
		return err
	}
	if res.MatchedCount == 0 {
		return ErrNotFound
	}
	return nil
}

func (m *MongoAssignments) DeletePlayer(ctx context.Context, assignmentID, playerID string) error {
	res, err := m.players.DeleteOne(ctx, bson.M{"_id": playerID, "assignmentId": assignmentID})
	if err != nil {
		return err
	}
	if res.DeletedCount == 0 {
		return ErrNotFound
	}
	return nil
}
