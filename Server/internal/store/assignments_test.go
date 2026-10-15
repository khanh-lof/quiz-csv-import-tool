package store

import (
	"context"
	"errors"
	"fmt"
	"maps"
	"os"
	"slices"
	"sync"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// The same contract runs against both implementations; the Mongo one is skipped unless
// MONGODB_TEST_URI is set, like the other integration tests.
func TestMemoryAssignments(t *testing.T) { testAssignments(t, NewMemoryAssignments()) }

func newTestMongoAssignments(t *testing.T) (*MongoAssignments, *mongo.Database) {
	t.Helper()
	uri := os.Getenv("MONGODB_TEST_URI")
	if uri == "" {
		t.Skip("MONGODB_TEST_URI not set")
	}
	client, err := mongo.Connect(options.Client().ApplyURI(uri))
	if err != nil {
		t.Fatal(err)
	}
	db := client.Database(fmt.Sprintf("quiztool_test_%d", time.Now().UnixNano()))
	t.Cleanup(func() {
		_ = db.Drop(context.Background())
		_ = client.Disconnect(context.Background())
	})
	a := NewMongoAssignments(db.Collection("Assignments"), db.Collection("AssignmentPlayers"))
	if err := a.EnsureIndexes(context.Background()); err != nil {
		t.Fatal(err)
	}
	return a, db
}

func TestMongoAssignments(t *testing.T) {
	a, _ := newTestMongoAssignments(t)
	testAssignments(t, a)
}

// Without EnsureIndexes (the server never calls it) a taken code or name must still be refused.
func TestMongoAssignmentsWithoutIndexes(t *testing.T) {
	_, db := newTestMongoAssignments(t)
	ctx := context.Background()
	a := NewMongoAssignments(db.Collection("NoIndexAssignments"), db.Collection("NoIndexPlayers"))
	now := time.Now()
	if err := a.Create(ctx, &Assignment{ID: "a1", Code: "CODE", Username: "alice", CreatedAt: now}); err != nil {
		t.Fatal(err)
	}
	if err := a.Create(ctx, &Assignment{ID: "a2", Code: "CODE", Username: "alice", CreatedAt: now}); !errors.Is(err, ErrDuplicate) {
		t.Fatalf("duplicate code: %v", err)
	}
	if err := a.CreatePlayer(ctx, &Player{ID: "p1", AssignmentID: "a1", Name: "Lan", NameKey: "lan", JoinedAt: now}); err != nil {
		t.Fatal(err)
	}
	if err := a.CreatePlayer(ctx, &Player{ID: "p2", AssignmentID: "a1", Name: "LAN", NameKey: "lan", JoinedAt: now}); !errors.Is(err, ErrDuplicate) {
		t.Fatalf("duplicate name: %v", err)
	}
}

// The stored documents are what the field names in the tags promise: camelCase, optional times
// absent rather than null, empty collections as {} and [].
func TestMongoAssignmentDocuments(t *testing.T) {
	a, db := newTestMongoAssignments(t)
	ctx := context.Background()
	now := time.Now()
	if err := a.Create(ctx, &Assignment{ID: "a1", Code: "CODE", Username: "alice", JobID: "j", Title: "T", TimeMode: "extra", CreatedAt: now}); err != nil {
		t.Fatal(err)
	}
	if err := a.CreatePlayer(ctx, &Player{ID: "p1", AssignmentID: "a1", Name: "Lan", NameKey: "lan", TokenHash: "h", JoinedAt: now}); err != nil {
		t.Fatal(err)
	}

	var raw bson.M
	if err := db.Collection("Assignments").FindOne(ctx, bson.M{"_id": "a1"}).Decode(&raw); err != nil {
		t.Fatal(err)
	}
	for _, field := range []string{"code", "username", "jobId", "title", "label", "csv", "timeMode", "stageCounts", "createdAt"} {
		if _, ok := raw[field]; !ok {
			t.Errorf("stored assignment lacks %q: %v", field, raw)
		}
	}
	// An assignment that shows its board stores no hideBoard, like one from before the setting.
	for _, field := range []string{"closesAt", "closedAt", "hideBoard"} {
		if _, ok := raw[field]; ok {
			t.Errorf("stored assignment has an unset %q: %v", field, raw)
		}
	}

	raw = nil
	if err := db.Collection("AssignmentPlayers").FindOne(ctx, bson.M{"_id": "p1"}).Decode(&raw); err != nil {
		t.Fatal(err)
	}
	for _, field := range []string{"assignmentId", "name", "nameKey", "tokenHash", "joinedAt", "stages", "version"} {
		if _, ok := raw[field]; !ok {
			t.Errorf("stored player lacks %q: %v", field, raw)
		}
	}
	if _, ok := raw["lastPlayedAt"]; ok {
		t.Errorf("stored player has an unset lastPlayedAt: %v", raw)
	}
	if _, ok := raw["runIds"]; ok {
		t.Errorf("stored player has the run ids of the removed results route: %v", raw)
	}
	// A player who has started no run has no started count and no run, like one from before runs.
	for _, field := range []string{"started", "run"} {
		if _, ok := raw[field]; ok {
			t.Errorf("stored player has an unset %q: %v", field, raw)
		}
	}
	// A player who picked no avatar has no field for it, like a player from before avatars.
	if _, ok := raw["avatar"]; ok {
		t.Errorf("stored player has an unset avatar: %v", raw)
	}

	if err := a.SetPlayerAvatar(ctx, "a1", "p1", "panda"); err != nil {
		t.Fatal(err)
	}
	raw = nil
	if err := db.Collection("AssignmentPlayers").FindOne(ctx, bson.M{"_id": "p1"}).Decode(&raw); err != nil {
		t.Fatal(err)
	}
	if raw["avatar"] != "panda" {
		t.Errorf("stored avatar = %#v", raw["avatar"])
	}
	// Setting it is a write of that one field: the version UpdatePlayer guards stays where it was.
	if got := fmt.Sprint(raw["version"]); got != "0" {
		t.Errorf("version = %#v after setting the avatar", raw["version"])
	}

	// A run is stored under the field names the tags promise, and an update moves the version by one.
	served := now.Add(time.Second)
	if _, err := a.UpdatePlayer(ctx, "a1", "p1", func(p *Player) error {
		p.Started["2"] = 1
		p.Run = &Run{ID: "run-1", Stage: "2", StartedAt: now, Questions: []RunQuestion{
			{Item: 3, Options: []string{"A", "B"}, ServedAt: &served},
			{Item: 0, Chunks: []string{"x", "y"}},
		}}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	raw = nil
	if err := db.Collection("AssignmentPlayers").FindOne(ctx, bson.M{"_id": "p1"}).Decode(&raw); err != nil {
		t.Fatal(err)
	}
	if got := fmt.Sprint(raw["version"]); got != "1" {
		t.Errorf("version = %#v after an update", raw["version"])
	}
	// Nested documents decode as bson.D or bson.M depending on the driver's defaults; look at either.
	asDoc := func(v any) bson.M {
		data, err := bson.Marshal(v)
		if err != nil {
			return nil
		}
		var doc bson.M
		_ = bson.Unmarshal(data, &doc)
		return doc
	}
	if started := asDoc(raw["started"]); fmt.Sprint(started["2"]) != "1" {
		t.Errorf("started = %#v", raw["started"])
	}
	run := asDoc(raw["run"])
	if run == nil {
		t.Fatalf("run = %#v", raw["run"])
	}
	for _, field := range []string{"id", "stage", "startedAt", "questions"} {
		if _, ok := run[field]; !ok {
			t.Errorf("stored run lacks %q: %v", field, run)
		}
	}
	if _, ok := run["finishedAt"]; ok {
		t.Errorf("stored run has an unset finishedAt: %v", run)
	}
	questions, _ := run["questions"].(bson.A)
	if len(questions) != 2 {
		t.Fatalf("questions = %#v", run["questions"])
	}
	first := asDoc(questions[0])
	for _, field := range []string{"item", "options", "servedAt", "correct", "timedOut"} {
		if _, ok := first[field]; !ok {
			t.Errorf("stored question lacks %q: %v", field, first)
		}
	}
	second := asDoc(questions[1])
	for _, field := range []string{"options", "servedAt", "answeredAt"} {
		if _, ok := second[field]; ok {
			t.Errorf("stored question has an unset %q: %v", field, second)
		}
	}
}

func timeIs(got *time.Time, want time.Time) bool {
	return got != nil && got.Equal(want) && got.Location() == time.UTC
}

func testAssignments(t *testing.T, store Assignments) {
	ctx := context.Background()
	base := time.Now().UTC().Truncate(time.Millisecond)
	newAssignment := func(id, username string, age time.Duration) *Assignment {
		return &Assignment{ID: id, Code: "CODE-" + id, Username: username, JobID: "job-" + id, Title: "Title " + id,
			CSV: "1,Q,Đúng,,,,E", TimeMode: "standard", StageCounts: map[string]int{"1": 5, "2": 5, "3": 5},
			CreatedAt: base.Add(-age)}
	}
	newPlayer := func(id, assignmentID, name string, joined time.Time) *Player {
		return &Player{ID: id, AssignmentID: assignmentID, Name: name, NameKey: "key-" + name,
			TokenHash: "hash-" + id, JoinedAt: joined}
	}
	getPlayer := func(assignmentID, id string) Player {
		t.Helper()
		players, err := store.ListPlayers(ctx, assignmentID)
		if err != nil {
			t.Fatal(err)
		}
		for _, p := range players {
			if p.ID == id {
				return p
			}
		}
		t.Fatalf("player %s not in %s: %+v", id, assignmentID, players)
		return Player{}
	}

	// Create, duplicate ids and codes, and what is stored is the caller's value, not its memory.
	closes := base.Add(time.Hour)
	bobsCloses := closes
	bobs := newAssignment("b1", "bob", 0)
	bobs.ClosesAt = &bobsCloses
	for _, a := range []*Assignment{newAssignment("a1", "alice", 3*time.Minute), newAssignment("a2", "alice", 2*time.Minute),
		newAssignment("a3", "alice", time.Minute), bobs} {
		if err := store.Create(ctx, a); err != nil {
			t.Fatal(err)
		}
	}
	if err := store.Create(ctx, newAssignment("a1", "alice", 0)); !errors.Is(err, ErrDuplicate) {
		t.Fatalf("duplicate id: want ErrDuplicate, got %v", err)
	}
	clash := newAssignment("a9", "alice", 0)
	clash.Code = "CODE-a2"
	if err := store.Create(ctx, clash); !errors.Is(err, ErrDuplicate) {
		t.Fatalf("duplicate code: want ErrDuplicate, got %v", err)
	}
	if err := store.Create(ctx, newAssignment("a9", "bob", 0)); err != nil { // the id a9 was not used up by the clash
		t.Fatalf("create after a clash: %v", err)
	}
	if err := store.Delete(ctx, "bob", "a9"); err != nil {
		t.Fatal(err)
	}
	bobs.StageCounts["1"] = 99
	later := base.Add(5 * time.Hour)
	*bobs.ClosesAt = later
	if got, err := store.Get(ctx, "bob", "b1"); err != nil || got.StageCounts["1"] != 5 || !timeIs(got.ClosesAt, closes) {
		t.Fatalf("store aliases the caller's value: %+v %v", got, err)
	}

	// Get is scoped to the owner; GetByCode is not, and both return the CSV.
	got, err := store.Get(ctx, "alice", "a1")
	if err != nil || got.Code != "CODE-a1" || got.JobID != "job-a1" || got.Title != "Title a1" || got.CSV != "1,Q,Đúng,,,,E" ||
		got.TimeMode != "standard" || got.Username != "alice" || len(got.StageCounts) != 3 || got.StageCounts["2"] != 5 ||
		!got.CreatedAt.Equal(base.Add(-3*time.Minute)) || got.ClosesAt != nil || got.ClosedAt != nil {
		t.Fatalf("Get: %+v %v", got, err)
	}
	if _, err := store.Get(ctx, "bob", "a1"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Get of another user's assignment: %v", err)
	}
	if _, err := store.Get(ctx, "alice", "missing"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Get of a missing assignment: %v", err)
	}
	byCode, err := store.GetByCode(ctx, "CODE-a1")
	if err != nil || byCode.ID != "a1" || byCode.CSV != "1,Q,Đúng,,,,E" || byCode.Username != "alice" {
		t.Fatalf("GetByCode: %+v %v", byCode, err)
	}
	if _, err := store.GetByCode(ctx, "code-a1"); !errors.Is(err, ErrNotFound) { // matched as stored
		t.Fatalf("GetByCode with another case: %v", err)
	}
	if _, err := store.GetByCode(ctx, "NOPE"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("GetByCode of an unknown code: %v", err)
	}
	// What Get returns is the caller's own copy.
	got.StageCounts["1"] = 42
	got.Label = "changed"
	if again, _ := store.Get(ctx, "alice", "a1"); again.StageCounts["1"] != 5 || again.Label != "" {
		t.Fatalf("Get returns the store's own memory: %+v", again)
	}

	// List: the user's own, newest first, without the CSV, and limited.
	list, err := store.List(ctx, "alice", 10)
	if err != nil || len(list) != 3 || list[0].ID != "a3" || list[1].ID != "a2" || list[2].ID != "a1" {
		t.Fatalf("List: %+v %v", list, err)
	}
	for _, a := range list {
		if a.CSV != "" || a.Title != "Title "+a.ID || a.StageCounts["3"] != 5 || a.Username != "alice" {
			t.Fatalf("List item: %+v", a)
		}
	}
	if list, _ = store.List(ctx, "alice", 2); len(list) != 2 || list[0].ID != "a3" {
		t.Fatalf("List with limit: %+v", list)
	}
	if list, _ = store.List(ctx, "alice", 0); len(list) != 0 {
		t.Fatalf("List with limit 0: %+v", list)
	}
	if list, _ = store.List(ctx, "nobody", 10); list == nil || len(list) != 0 {
		t.Fatalf("List of unknown user: %#v", list)
	}
	for user, want := range map[string]int{"alice": 3, "bob": 1, "nobody": 0} {
		if n, err := store.Count(ctx, user); err != nil || n != want {
			t.Fatalf("Count(%s) = %d %v, want %d", user, n, err, want)
		}
	}

	// Update: nothing to change, set and clear the times and the label, and only for the owner.
	if cur, err := store.Update(ctx, "alice", "a1", AssignmentUpdate{}); err != nil || cur.ID != "a1" || cur.CSV == "" || cur.Label != "" {
		t.Fatalf("empty Update: %+v %v", cur, err)
	}
	if _, err := store.Update(ctx, "bob", "a1", AssignmentUpdate{}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("empty Update of another user's assignment: %v", err)
	}
	label := "Lớp 6A"
	if _, err := store.Update(ctx, "bob", "a1", AssignmentUpdate{Label: &label}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Update of another user's assignment: %v", err)
	}
	if _, err := store.Update(ctx, "alice", "missing", AssignmentUpdate{Label: &label}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Update of a missing assignment: %v", err)
	}
	if a, _ := store.Get(ctx, "alice", "a1"); a.Label != "" {
		t.Fatalf("a refused Update changed the assignment: %+v", a)
	}
	// Times are kept as UTC milliseconds, whatever the caller passes.
	zone := time.FixedZone("UTC+7", 7*3600)
	closesAt := base.Add(time.Hour + 123*time.Microsecond).In(zone)
	upd, err := store.Update(ctx, "alice", "a1", AssignmentUpdate{Label: &label, ClosesAt: TimeChange{Set: true, Value: &closesAt}})
	if err != nil || upd.Label != label || !timeIs(upd.ClosesAt, base.Add(time.Hour)) || upd.ClosedAt != nil || upd.CSV == "" {
		t.Fatalf("Update (label, closesAt): %+v %v", upd, err)
	}
	closedAt := base.Add(-time.Minute)
	upd, err = store.Update(ctx, "alice", "a1", AssignmentUpdate{ClosedAt: TimeChange{Set: true, Value: &closedAt}})
	if err != nil || upd.Label != label || !timeIs(upd.ClosesAt, base.Add(time.Hour)) || !timeIs(upd.ClosedAt, closedAt) {
		t.Fatalf("Update (closedAt): %+v %v", upd, err)
	}
	upd, err = store.Update(ctx, "alice", "a1", AssignmentUpdate{ClosesAt: TimeChange{Set: true}})
	if err != nil || upd.ClosesAt != nil || !timeIs(upd.ClosedAt, closedAt) || upd.Label != label {
		t.Fatalf("Update (clear closesAt): %+v %v", upd, err)
	}
	upd, err = store.Update(ctx, "alice", "a1", AssignmentUpdate{ClosedAt: TimeChange{Set: true}})
	if err != nil || upd.ClosesAt != nil || upd.ClosedAt != nil {
		t.Fatalf("Update (clear closedAt): %+v %v", upd, err)
	}
	empty := ""
	upd, err = store.Update(ctx, "alice", "a1", AssignmentUpdate{Label: &empty})
	if err != nil || upd.Label != "" {
		t.Fatalf("Update (clear label): %+v %v", upd, err)
	}
	if a, _ := store.Get(ctx, "alice", "a1"); a.Label != "" || a.ClosesAt != nil || a.ClosedAt != nil || a.CSV == "" {
		t.Fatalf("Get after the updates: %+v", a)
	}
	// An update does not alias the caller's time either.
	closesAt = base.Add(2 * time.Hour)
	if _, err = store.Update(ctx, "alice", "a2", AssignmentUpdate{ClosesAt: TimeChange{Set: true, Value: &closesAt}}); err != nil {
		t.Fatal(err)
	}
	closesAt = base
	if a, _ := store.Get(ctx, "alice", "a2"); !timeIs(a.ClosesAt, base.Add(2*time.Hour)) {
		t.Fatalf("Update aliases the caller's time: %+v", a)
	}

	// Players: unique name keys per assignment, listed in the order they joined.
	if err := store.CreatePlayer(ctx, newPlayer("p-1", "a1", "Lan", base.Add(-2*time.Minute))); err != nil {
		t.Fatal(err)
	}
	if err := store.CreatePlayer(ctx, newPlayer("p-3", "a1", "Nam", base.Add(-3*time.Minute))); err != nil {
		t.Fatal(err)
	}
	if err := store.CreatePlayer(ctx, newPlayer("p-2", "a1", "Năm", base.Add(-3*time.Minute))); err != nil {
		t.Fatal(err)
	}
	if err := store.CreatePlayer(ctx, newPlayer("p-4", "a2", "Lan", base)); err != nil { // the same name in another assignment
		t.Fatal(err)
	}
	if err := store.CreatePlayer(ctx, newPlayer("p-5", "a1", "Lan", base)); !errors.Is(err, ErrDuplicate) {
		t.Fatalf("duplicate name: want ErrDuplicate, got %v", err)
	}
	if err := store.CreatePlayer(ctx, newPlayer("p-1", "a3", "Other", base)); !errors.Is(err, ErrDuplicate) {
		t.Fatalf("duplicate player id: want ErrDuplicate, got %v", err)
	}
	players, err := store.ListPlayers(ctx, "a1")
	if err != nil || len(players) != 3 || players[0].ID != "p-2" || players[1].ID != "p-3" || players[2].ID != "p-1" {
		t.Fatalf("ListPlayers: %+v %v", players, err)
	}
	if p := players[2]; p.Name != "Lan" || p.NameKey != "key-Lan" || p.TokenHash != "hash-p-1" || p.AssignmentID != "a1" ||
		!p.JoinedAt.Equal(base.Add(-2*time.Minute)) || p.LastPlayedAt != nil || p.Stages == nil || len(p.Stages) != 0 ||
		p.Started != nil || p.Run != nil || p.Version != 0 || p.Avatar != "" {
		t.Fatalf("a new player: %+v", p)
	}
	if players, err = store.ListPlayers(ctx, "nothing"); err != nil || players == nil || len(players) != 0 {
		t.Fatalf("ListPlayers of an assignment without players: %#v %v", players, err)
	}
	counts, err := store.CountPlayers(ctx, []string{"a1", "a2", "a3", "ghost"})
	if err != nil || len(counts) != 4 || counts["a1"] != 3 || counts["a2"] != 1 || counts["a3"] != 0 || counts["ghost"] != 0 {
		t.Fatalf("CountPlayers: %v %v", counts, err)
	}
	if counts, err = store.CountPlayers(ctx, nil); err != nil || counts == nil || len(counts) != 0 {
		t.Fatalf("CountPlayers of nothing: %#v %v", counts, err)
	}
	if p, err := store.PlayerByToken(ctx, "a1", "hash-p-1"); err != nil || p.ID != "p-1" || p.Name != "Lan" {
		t.Fatalf("PlayerByToken: %+v %v", p, err)
	}
	if _, err := store.PlayerByToken(ctx, "a2", "hash-p-1"); !errors.Is(err, ErrNotFound) { // a token is good for its own assignment only
		t.Fatalf("PlayerByToken in another assignment: %v", err)
	}
	if _, err := store.PlayerByToken(ctx, "a1", "unknown"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("PlayerByToken with an unknown token: %v", err)
	}

	// SetPlayerAvatar: a player is created with the avatar it carries, and the avatar can be replaced,
	// for that assignment's player only. Every way of reading a player sees it.
	withAvatar := newPlayer("p-7", "a3", "Hoa", base)
	withAvatar.Avatar = "owl"
	if err := store.CreatePlayer(ctx, withAvatar); err != nil {
		t.Fatal(err)
	}
	if p := getPlayer("a3", "p-7"); p.Avatar != "owl" {
		t.Fatalf("a player created with an avatar: %+v", p)
	}
	if err := store.SetPlayerAvatar(ctx, "a1", "p-1", "panda"); err != nil {
		t.Fatal(err)
	}
	if p := getPlayer("a1", "p-1"); p.Avatar != "panda" || p.Name != "Lan" || p.TokenHash != "hash-p-1" || p.Version != 0 {
		t.Fatalf("after setting an avatar: %+v", p)
	}
	if p, err := store.PlayerByToken(ctx, "a1", "hash-p-1"); err != nil || p.Avatar != "panda" {
		t.Fatalf("PlayerByToken after setting an avatar: %+v %v", p, err)
	}
	if err := store.SetPlayerAvatar(ctx, "a1", "p-1", "fox"); err != nil { // replaced, not added
		t.Fatal(err)
	}
	if p := getPlayer("a1", "p-1"); p.Avatar != "fox" {
		t.Fatalf("after replacing the avatar: %+v", p)
	}
	for _, other := range []struct{ assignment, id string }{{"a1", "p-2"}, {"a1", "p-3"}, {"a2", "p-4"}, {"a3", "p-7"}} {
		want := ""
		if other.id == "p-7" {
			want = "owl"
		}
		if p := getPlayer(other.assignment, other.id); p.Avatar != want {
			t.Fatalf("setting an avatar reached %s: %+v", other.id, p)
		}
	}
	if err := store.SetPlayerAvatar(ctx, "a2", "p-1", "cat"); !errors.Is(err, ErrNotFound) { // another assignment's id
		t.Fatalf("SetPlayerAvatar in another assignment: %v", err)
	}
	if err := store.SetPlayerAvatar(ctx, "a1", "ghost", "cat"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("SetPlayerAvatar of an unknown player: %v", err)
	}
	if err := store.SetPlayerAvatar(ctx, "nothing", "p-1", "cat"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("SetPlayerAvatar in an unknown assignment: %v", err)
	}
	if p := getPlayer("a1", "p-1"); p.Avatar != "fox" {
		t.Fatalf("a refused SetPlayerAvatar changed the player: %+v", p)
	}

	// UpdatePlayer: the best run per stage, a pass that sticks, attempts, as one finished run after another.
	// finish plays the part of the handler, which starts a run (counting it in Started) and later merges its
	// score; here both happen in one update.
	updates := 0
	finish := func(player, stage string, correct int, passed bool, at time.Duration) {
		t.Helper()
		_, err := store.UpdatePlayer(ctx, "a1", player, func(p *Player) error {
			p.Started[stage]++
			MergeRun(p, stage, correct, 5, passed, base.Add(at))
			now := base.Add(at)
			p.LastPlayedAt = &now
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
		updates++
	}
	check := func(what string, p Player, stage string, want StageResult) {
		t.Helper()
		got := p.Stages[stage]
		if got.Correct != want.Correct || got.Total != want.Total || got.Attempts != want.Attempts ||
			got.Passed != want.Passed || !got.BestAt.Equal(want.BestAt) {
			t.Fatalf("%s: stage %s = %+v, want %+v", what, stage, got, want)
		}
	}
	at := func(d time.Duration) time.Time { return base.Add(d) }
	finish("p-1", "1", 3, false, time.Second)
	p := getPlayer("a1", "p-1")
	check("first run", p, "1", StageResult{Correct: 3, Total: 5, Attempts: 1, BestAt: at(time.Second)})
	if !timeIs(p.LastPlayedAt, at(time.Second)) || p.Version != 1 || p.Started["1"] != 1 || p.Run != nil {
		t.Fatalf("after the first run: %+v", p)
	}
	finish("p-1", "1", 4, true, 2*time.Second)
	check("a better run that passes", getPlayer("a1", "p-1"), "1", StageResult{Correct: 4, Total: 5, Attempts: 2, Passed: true, BestAt: at(2 * time.Second)})
	finish("p-1", "1", 2, false, 3*time.Second)
	p = getPlayer("a1", "p-1")
	check("a worse run", p, "1", StageResult{Correct: 4, Total: 5, Attempts: 3, Passed: true, BestAt: at(2 * time.Second)})
	if !timeIs(p.LastPlayedAt, at(3*time.Second)) {
		t.Fatalf("a worse run still counts as played: %+v", p.LastPlayedAt)
	}
	finish("p-1", "1", 4, true, 4*time.Second)
	check("an equal run", getPlayer("a1", "p-1"), "1", StageResult{Correct: 4, Total: 5, Attempts: 4, Passed: true, BestAt: at(2 * time.Second)})

	// A stage played for the first time takes its result even at 0; a pass made with the same
	// score as before still moves BestAt, because that is when the player passed.
	finish("p-1", "2", 0, false, 5*time.Second)
	check("first run with no right answer", getPlayer("a1", "p-1"), "2", StageResult{Correct: 0, Total: 5, Attempts: 1, BestAt: at(5 * time.Second)})
	finish("p-1", "3", 4, false, 6*time.Second)
	finish("p-1", "3", 4, true, 7*time.Second)
	check("a pass at the same score", getPlayer("a1", "p-1"), "3", StageResult{Correct: 4, Total: 5, Attempts: 2, Passed: true, BestAt: at(7 * time.Second)})
	finish("p-1", "3", 5, true, 8*time.Second)
	check("a better run after a pass", getPlayer("a1", "p-1"), "3", StageResult{Correct: 5, Total: 5, Attempts: 3, Passed: true, BestAt: at(8 * time.Second)})
	p = getPlayer("a1", "p-1")
	if len(p.Stages) != 3 || p.Version != updates || !maps.Equal(p.Started, map[string]int{"1": 4, "2": 1, "3": 3}) {
		t.Fatalf("after the runs: stages %d, version %d, started %v, want 3, %d, 1:4 2:1 3:3", len(p.Stages), p.Version, p.Started, updates)
	}
	// The updates left the avatar alone, and setting it did not count as one of the writes the version guards.
	if p.Avatar != "fox" {
		t.Fatalf("updating a player changed the avatar: %+v", p)
	}
	// Another player of the assignment is untouched.
	if other := getPlayer("a1", "p-2"); len(other.Stages) != 0 || other.Started != nil || other.Version != 0 || other.LastPlayedAt != nil {
		t.Fatalf("an update reached another player: %+v", other)
	}

	// The change function sees non-nil maps, even for a player that has never played, and the player
	// that comes back is the one as written: its version moved, and it shares nothing with the store.
	fresh := newPlayer("p-8", "a3", "Cúc", base)
	if err := store.CreatePlayer(ctx, fresh); err != nil {
		t.Fatal(err)
	}
	written, err := store.UpdatePlayer(ctx, "a3", "p-8", func(p *Player) error {
		if p.Stages == nil || p.Started == nil || p.Run != nil {
			t.Errorf("a fresh player as change sees it: %+v", p)
		}
		p.Started["4"] = 1
		return nil
	})
	if err != nil || written.Version != 1 || written.Started["4"] != 1 || written.ID != "p-8" || written.Name != "Cúc" {
		t.Fatalf("UpdatePlayer returned %+v, %v", written, err)
	}
	written.Started["4"] = 1000
	written.Stages["9"] = StageResult{Correct: 1}
	if p := getPlayer("a3", "p-8"); p.Started["4"] != 1 || len(p.Stages) != 0 {
		t.Fatalf("the returned player aliases the store's: %+v", p)
	}

	// What change does to anything but the four fields is not written.
	if _, err := store.UpdatePlayer(ctx, "a1", "p-1", func(p *Player) error {
		p.Avatar, p.Name, p.TokenHash, p.Version = "hacked", "Hacked", "hacked", 999
		p.Started["1"]++
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if p = getPlayer("a1", "p-1"); p.Avatar != "fox" || p.Name != "Lan" || p.TokenHash != "hash-p-1" || p.Version != updates+1 || p.Started["1"] != 5 {
		t.Fatalf("an update wrote more than it should: %+v", p)
	}
	updates++

	// An error from change writes nothing and comes back as it is, with the player as it was.
	errStop := errors.New("stop")
	before := getPlayer("a1", "p-1")
	calls := 0
	if _, err := store.UpdatePlayer(ctx, "a1", "p-1", func(p *Player) error {
		calls++
		p.Started["1"] = 99
		p.Stages["1"] = StageResult{Correct: 5}
		now := base.Add(time.Hour)
		p.LastPlayedAt = &now
		return errStop
	}); err != errStop || calls != 1 {
		t.Fatalf("an error from change: got %v after %d calls, want %v after 1", err, calls, errStop)
	}
	if after := getPlayer("a1", "p-1"); after.Version != before.Version || after.Started["1"] != before.Started["1"] ||
		after.Stages["1"] != before.Stages["1"] || !timeIs(after.LastPlayedAt, *before.LastPlayedAt) {
		t.Fatalf("a refused update changed the player: %+v -> %+v", before, after)
	}

	// An update needs its player to be in that assignment, and does not call change for one that is not.
	for _, other := range []struct{ assignment, id string }{{"a2", "p-1"}, {"a1", "ghost"}, {"nothing", "p-1"}} {
		_, err := store.UpdatePlayer(ctx, other.assignment, other.id, func(*Player) error {
			t.Errorf("change called for %s of %s", other.id, other.assignment)
			return nil
		})
		if !errors.Is(err, ErrNotFound) {
			t.Fatalf("update of %s in %s: %v", other.id, other.assignment, err)
		}
	}
	if after := getPlayer("a1", "p-1"); after.Version != updates {
		t.Fatalf("a refused update changed the player: %+v", after)
	}

	// A run is stored whole, with its times in milliseconds, and read back by the token but not by the
	// listing, which leaves it out. Starting another run replaces it.
	served := base.Add(time.Minute + 1500*time.Microsecond)
	servedAt := served
	run := &Run{ID: "run-A", Stage: "2", StartedAt: served, Questions: []RunQuestion{
		{Item: 2, Options: []string{"Đúng", "Sai"}, ServedAt: &servedAt},
		{Item: 0, Chunks: []string{"a", "b"}},
		{Item: 1, Options: []string{"x", "y", "z"}},
	}}
	if _, err := store.UpdatePlayer(ctx, "a1", "p-3", func(p *Player) error {
		p.Run, p.Started["2"], p.LastPlayedAt = run, 1, &served
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	// Changing what was handed in afterwards changes nothing that is stored.
	run.Questions[0].Options[0] = "changed"
	*run.Questions[0].ServedAt = base
	run.Questions = run.Questions[:1]

	byToken, err := store.PlayerByToken(ctx, "a1", "hash-p-3")
	if err != nil || byToken.Run == nil || byToken.Run.ID != "run-A" || byToken.Run.Stage != "2" || len(byToken.Run.Questions) != 3 ||
		!timeIs(&byToken.Run.StartedAt, served.Truncate(time.Millisecond)) || byToken.Run.FinishedAt != nil {
		t.Fatalf("PlayerByToken after starting a run: %+v %v", byToken, err)
	}
	q := byToken.Run.Questions
	if q[0].Item != 2 || !slices.Equal(q[0].Options, []string{"Đúng", "Sai"}) || q[0].Chunks != nil || !timeIs(q[0].ServedAt, served.Truncate(time.Millisecond)) ||
		q[0].AnsweredAt != nil || q[0].Correct || q[0].TimedOut {
		t.Fatalf("question 0 of the stored run: %+v", q[0])
	}
	if q[1].Item != 0 || q[1].Options != nil || !slices.Equal(q[1].Chunks, []string{"a", "b"}) || q[1].ServedAt != nil {
		t.Fatalf("question 1 of the stored run: %+v", q[1])
	}
	if q[2].Item != 1 || !slices.Equal(q[2].Options, []string{"x", "y", "z"}) {
		t.Fatalf("question 2 of the stored run: %+v", q[2])
	}
	// What PlayerByToken returns is the caller's own copy.
	byToken.Run.Questions[0].Options[0] = "mutated"
	byToken.Started["2"] = 50
	if again, _ := store.PlayerByToken(ctx, "a1", "hash-p-3"); again.Run.Questions[0].Options[0] != "Đúng" || again.Started["2"] != 1 {
		t.Fatalf("PlayerByToken returns the store's own memory: %+v", again.Run)
	}
	if p = getPlayer("a1", "p-3"); p.Run != nil || p.Started["2"] != 1 || p.Version != 1 || !timeIs(p.LastPlayedAt, served.Truncate(time.Millisecond)) {
		t.Fatalf("ListPlayers shows a run, or lost the rest: %+v", p)
	}

	// Answering and finishing is another update of the same run; a finished run stays.
	answered := served.Add(3 * time.Second)
	if _, err := store.UpdatePlayer(ctx, "a1", "p-3", func(p *Player) error {
		p.Run.Questions[0].AnsweredAt, p.Run.Questions[0].Correct = &answered, true
		p.Run.FinishedAt = &answered
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if byToken, err = store.PlayerByToken(ctx, "a1", "hash-p-3"); err != nil || byToken.Run.FinishedAt == nil ||
		!timeIs(byToken.Run.FinishedAt, answered.Truncate(time.Millisecond)) || !byToken.Run.Questions[0].Correct ||
		!timeIs(byToken.Run.Questions[0].AnsweredAt, answered.Truncate(time.Millisecond)) || byToken.Run.Questions[0].TimedOut || byToken.Version != 2 {
		t.Fatalf("the finished run: %+v %v", byToken, err)
	}
	if _, err := store.UpdatePlayer(ctx, "a1", "p-3", func(p *Player) error {
		p.Run = &Run{ID: "run-B", Stage: "2", StartedAt: answered, Questions: []RunQuestion{{Item: 0}}}
		p.Started["2"]++
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if byToken, err = store.PlayerByToken(ctx, "a1", "hash-p-3"); err != nil || byToken.Run.ID != "run-B" || len(byToken.Run.Questions) != 1 ||
		byToken.Run.FinishedAt != nil || byToken.Run.Questions[0].ServedAt != nil || byToken.Started["2"] != 2 {
		t.Fatalf("a new run did not replace the old one: %+v %v", byToken, err)
	}
	// A run that is cleared, and the other fields with it, is gone from the document, not stored as null.
	if _, err := store.UpdatePlayer(ctx, "a1", "p-3", func(p *Player) error {
		p.Run, p.Started, p.LastPlayedAt = nil, nil, nil
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if byToken, err = store.PlayerByToken(ctx, "a1", "hash-p-3"); err != nil || byToken.Run != nil || byToken.Started != nil || byToken.LastPlayedAt != nil || byToken.Stages == nil {
		t.Fatalf("a cleared run: %+v %v", byToken, err)
	}

	// Updates made at the same moment are all applied: each one that finds another got there first
	// reads again and tries again.
	const writers = 4
	var wg sync.WaitGroup
	errs := make(chan error, writers)
	for i := range writers {
		wg.Go(func() {
			_, err := store.UpdatePlayer(ctx, "a1", "p-2", func(p *Player) error {
				p.Started["2"]++
				MergeRun(p, "2", i, 5, false, base.Add(time.Duration(i)*time.Second))
				return nil
			})
			errs <- err
		})
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	if p = getPlayer("a1", "p-2"); p.Stages["2"].Attempts != writers || p.Stages["2"].Correct != writers-1 || p.Started["2"] != writers || p.Version != writers {
		t.Fatalf("concurrent updates lost: %+v", p)
	}

	// DeletePlayer is scoped to the assignment.
	if err := store.DeletePlayer(ctx, "a2", "p-1"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("DeletePlayer in another assignment: %v", err)
	}
	if err := store.DeletePlayer(ctx, "a1", "p-3"); err != nil {
		t.Fatal(err)
	}
	if err := store.DeletePlayer(ctx, "a1", "p-3"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("DeletePlayer twice: %v", err)
	}
	if _, err := store.PlayerByToken(ctx, "a1", "hash-p-3"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("a deleted player's token still works: %v", err)
	}
	if err := store.SetPlayerAvatar(ctx, "a1", "p-3", "cat"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("SetPlayerAvatar of a deleted player: %v", err)
	}
	if counts, _ = store.CountPlayers(ctx, []string{"a1"}); counts["a1"] != 2 {
		t.Fatalf("CountPlayers after DeletePlayer: %v", counts)
	}
	if err := store.CreatePlayer(ctx, newPlayer("p-6", "a1", "Nam", base)); err != nil { // the removed player's name is free again
		t.Fatalf("reusing a removed player's name: %v", err)
	}

	// Delete is scoped to the owner and takes the players with it.
	if err := store.Delete(ctx, "bob", "a1"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Delete of another user's assignment: %v", err)
	}
	if counts, _ = store.CountPlayers(ctx, []string{"a1"}); counts["a1"] != 3 {
		t.Fatalf("a refused Delete removed players: %v", counts)
	}
	if err := store.Delete(ctx, "alice", "a1"); err != nil {
		t.Fatal(err)
	}
	if err := store.Delete(ctx, "alice", "a1"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Delete twice: %v", err)
	}
	if _, err := store.Get(ctx, "alice", "a1"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Get after Delete: %v", err)
	}
	if _, err := store.GetByCode(ctx, "CODE-a1"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("GetByCode after Delete: %v", err)
	}
	if players, _ = store.ListPlayers(ctx, "a1"); len(players) != 0 {
		t.Fatalf("players of a deleted assignment: %+v", players)
	}
	if _, err := store.PlayerByToken(ctx, "a1", "hash-p-1"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("a deleted assignment's token still works: %v", err)
	}
	if counts, _ = store.CountPlayers(ctx, []string{"a1", "a2"}); counts["a1"] != 0 || counts["a2"] != 1 {
		t.Fatalf("CountPlayers after Delete: %v", counts)
	}
	if n, _ := store.Count(ctx, "alice"); n != 2 {
		t.Fatalf("Count after Delete: %d", n)
	}
	if err := store.Create(ctx, newAssignment("a1", "alice", 0)); err != nil { // its id and code are free again
		t.Fatalf("Create after Delete: %v", err)
	}
}

func TestAssignmentEffectiveClose(t *testing.T) {
	now := time.Date(2026, 3, 1, 10, 0, 0, 0, time.UTC)
	earlier, later := now.Add(-time.Hour), now.Add(time.Hour)
	cases := []struct {
		name           string
		closes, closed *time.Time
		want           time.Time
		ok             bool
	}{
		{"never closes", nil, nil, time.Time{}, false},
		{"scheduled", &later, nil, later, true},
		{"closed by hand", nil, &earlier, earlier, true},
		{"closed before the schedule", &later, &earlier, earlier, true},
		{"scheduled before the manual close", &earlier, &later, earlier, true},
	}
	for _, c := range cases {
		a := &Assignment{ClosesAt: c.closes, ClosedAt: c.closed}
		if got, ok := a.EffectiveClose(); ok != c.ok || !got.Equal(c.want) {
			t.Errorf("%s: EffectiveClose = %v, %v; want %v, %v", c.name, got, ok, c.want, c.ok)
		}
	}
}

func TestAssignmentOpenAt(t *testing.T) {
	now := time.Date(2026, 3, 1, 10, 0, 0, 0, time.UTC)
	past, future := now.Add(-time.Second), now.Add(time.Second)
	cases := []struct {
		name           string
		closes, closed *time.Time
		open           bool
	}{
		{"no closing time", nil, nil, true},
		{"closing time ahead", &future, nil, true},
		{"closing time exactly now", &now, nil, false},
		{"closing time past", &past, nil, false},
		{"closed by hand", nil, &past, false},
		{"closed by hand before its schedule", &future, &past, false},
		{"closed by hand with a time still ahead", nil, &future, false},
	}
	for _, c := range cases {
		a := &Assignment{ClosesAt: c.closes, ClosedAt: c.closed}
		if got := a.OpenAt(now); got != c.open {
			t.Errorf("%s: OpenAt = %v, want %v", c.name, got, c.open)
		}
	}
}

func TestAssignmentAcceptsResultsAt(t *testing.T) {
	closed := time.Date(2026, 3, 1, 10, 0, 0, 0, time.UTC)
	byHand := &Assignment{ClosedAt: &closed}
	scheduled := &Assignment{ClosesAt: &closed}
	both := &Assignment{ClosesAt: &closed, ClosedAt: ptr(closed.Add(-time.Hour))}
	cases := []struct {
		name string
		a    *Assignment
		now  time.Time
		want bool
	}{
		{"open", &Assignment{}, closed.Add(100 * time.Hour), true},
		{"before the scheduled close", scheduled, closed.Add(-time.Second), true},
		{"just after the close", byHand, closed.Add(time.Millisecond), true},
		{"just after a scheduled close", scheduled, closed.Add(time.Millisecond), true},
		{"on the grace boundary", byHand, closed.Add(ResultGrace), true},
		{"just past the grace", byHand, closed.Add(ResultGrace + time.Millisecond), false},
		{"just past the grace of a schedule", scheduled, closed.Add(ResultGrace + time.Millisecond), false},
		{"the grace runs from the earlier close", both, closed.Add(-time.Hour + ResultGrace + time.Millisecond), false},
		{"the grace runs from the earlier close, inside it", both, closed.Add(-time.Hour + ResultGrace), true},
	}
	for _, c := range cases {
		if got := c.a.AcceptsResultsAt(c.now); got != c.want {
			t.Errorf("%s: AcceptsResultsAt = %v, want %v", c.name, got, c.want)
		}
	}
}

func ptr[T any](v T) *T { return &v }

func TestMergeRun(t *testing.T) {
	zone := time.FixedZone("UTC+7", 7*3600)
	now := time.Date(2026, 3, 1, 10, 0, 0, 123456789, zone)
	want := now.UTC().Truncate(time.Millisecond)

	// A first run, on a player with no results map at all.
	p := &Player{Started: map[string]int{"1": 1}}
	MergeRun(p, "1", 3, 5, false, now)
	if r := p.Stages["1"]; r.Correct != 3 || r.Total != 5 || r.Attempts != 1 || r.Passed || !r.BestAt.Equal(want) || r.BestAt.Location() != time.UTC {
		t.Fatalf("stage after the first run: %+v", r)
	}
	if p.LastPlayedAt != nil {
		t.Errorf("MergeRun set LastPlayedAt: %v", p.LastPlayedAt)
	}

	// A worse run keeps the best and its time; the attempts follow what was started.
	p.Started["1"] = 2
	MergeRun(p, "1", 2, 5, false, now.Add(time.Minute))
	if r := p.Stages["1"]; r.Correct != 3 || r.Attempts != 2 || r.Passed || !r.BestAt.Equal(want) {
		t.Fatalf("after a worse run: %+v", r)
	}
	// An equal run changes neither the best nor when it was reached.
	p.Started["1"] = 3
	MergeRun(p, "1", 3, 5, false, now.Add(2*time.Minute))
	if r := p.Stages["1"]; r.Correct != 3 || r.Attempts != 3 || !r.BestAt.Equal(want) {
		t.Fatalf("after an equal run: %+v", r)
	}
	// A pass at the same score moves BestAt, because that is when the player passed.
	p.Started["1"] = 4
	MergeRun(p, "1", 3, 5, true, now.Add(3*time.Minute))
	passedAt := now.Add(3 * time.Minute).UTC().Truncate(time.Millisecond)
	if r := p.Stages["1"]; r.Correct != 3 || !r.Passed || !r.BestAt.Equal(passedAt) {
		t.Fatalf("after the pass: %+v", r)
	}
	// A later run, worse and not passing, takes nothing back: not the pass, not the score, not the time.
	p.Started["1"] = 5
	MergeRun(p, "1", 0, 5, false, now.Add(4*time.Minute))
	if r := p.Stages["1"]; r.Correct != 3 || !r.Passed || !r.BestAt.Equal(passedAt) || r.Attempts != 5 {
		t.Fatalf("after a failing run: %+v", r)
	}
	// A better run raises the score and moves the time again, and a second pass leaves the time alone.
	p.Started["1"] = 6
	MergeRun(p, "1", 5, 5, true, now.Add(5*time.Minute))
	if r := p.Stages["1"]; r.Correct != 5 || !r.Passed || !r.BestAt.Equal(now.Add(5*time.Minute).UTC().Truncate(time.Millisecond)) {
		t.Fatalf("after the best run: %+v", r)
	}

	// A first run that gets nothing right is still the player's result for the stage.
	MergeRun(p, "2", 0, 5, false, now)
	if r, ok := p.Stages["2"]; !ok || r.Correct != 0 || r.Total != 5 || r.Attempts != 0 || !r.BestAt.Equal(want) {
		t.Fatalf("stage 2: %+v %v", r, ok)
	}

	// Attempts never go down: a player from before the server dealt the runs has its count in Attempts and
	// nothing in Started, and one whose Started is ahead takes that.
	legacy := &Player{Stages: map[string]StageResult{"3": {Correct: 4, Total: 5, Attempts: 7, Passed: true, BestAt: want}}}
	MergeRun(legacy, "3", 2, 5, false, now.Add(time.Hour))
	if r := legacy.Stages["3"]; r.Attempts != 7 || r.Correct != 4 || !r.BestAt.Equal(want) {
		t.Fatalf("legacy player, nothing started: %+v", r)
	}
	legacy.Started = map[string]int{"3": 8}
	MergeRun(legacy, "3", 2, 5, false, now.Add(time.Hour))
	if r := legacy.Stages["3"]; r.Attempts != 8 {
		t.Fatalf("legacy player, 8 started: %+v", r)
	}
	legacy.Started["3"] = 3
	MergeRun(legacy, "3", 2, 5, false, now.Add(time.Hour))
	if r := legacy.Stages["3"]; r.Attempts != 8 {
		t.Fatalf("a lower Started lowered the attempts: %+v", r)
	}
}

func TestPlayerStoredCopiesTheRun(t *testing.T) {
	served := time.Date(2026, 3, 1, 10, 0, 0, 123456789, time.FixedZone("UTC+7", 7*3600))
	p := Player{
		Started: map[string]int{"1": 2},
		Run: &Run{ID: "r", Stage: "1", StartedAt: served, Questions: []RunQuestion{
			{Item: 1, Options: []string{"a", "b"}, ServedAt: &served},
			{Item: 0, Options: []string{}, Chunks: []string{}},
		}},
	}
	got := p.stored()

	// Times are UTC milliseconds, empty slices read as nil, and nothing is shared with the original.
	want := served.UTC().Truncate(time.Millisecond)
	if !got.Run.StartedAt.Equal(want) || got.Run.StartedAt.Location() != time.UTC || !got.Run.Questions[0].ServedAt.Equal(want) {
		t.Fatalf("times: %+v", got.Run)
	}
	if got.Run.Questions[1].Options != nil || got.Run.Questions[1].Chunks != nil {
		t.Fatalf("empty slices: %+v", got.Run.Questions[1])
	}
	got.Run.Questions[0].Options[0] = "changed"
	*got.Run.Questions[0].ServedAt = served.Add(time.Hour)
	got.Run.ID = "other"
	got.Started["1"] = 9
	if p.Run.Questions[0].Options[0] != "a" || !p.Run.Questions[0].ServedAt.Equal(served) || p.Run.ID != "r" || p.Started["1"] != 2 {
		t.Fatalf("stored() aliases the original: %+v", p.Run)
	}
	// Doing it again changes nothing, and an empty Started and a missing Run stay as they are.
	if again := got.stored(); again.Run.ID != "other" || again.Started["1"] != 9 {
		t.Fatalf("stored() twice: %+v", again)
	}
	if empty := (Player{Started: map[string]int{}}).stored(); empty.Started != nil || empty.Run != nil || empty.Stages == nil {
		t.Fatalf("an empty player: %+v", empty)
	}
}
