package store

import (
	"context"
	"errors"
	"fmt"
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
	for _, field := range []string{"closesAt", "closedAt"} {
		if _, ok := raw[field]; ok {
			t.Errorf("stored assignment has an unset %q: %v", field, raw)
		}
	}

	raw = nil
	if err := db.Collection("AssignmentPlayers").FindOne(ctx, bson.M{"_id": "p1"}).Decode(&raw); err != nil {
		t.Fatal(err)
	}
	for _, field := range []string{"assignmentId", "name", "nameKey", "tokenHash", "joinedAt", "stages", "runIds", "version"} {
		if _, ok := raw[field]; !ok {
			t.Errorf("stored player lacks %q: %v", field, raw)
		}
	}
	if _, ok := raw["lastPlayedAt"]; ok {
		t.Errorf("stored player has an unset lastPlayedAt: %v", raw)
	}
	if arr, ok := raw["runIds"].(bson.A); !ok || len(arr) != 0 {
		t.Errorf("runIds = %#v", raw["runIds"])
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
	// Setting it is a write of that one field: the version RecordResult guards stays where it was.
	if got := fmt.Sprint(raw["version"]); got != "0" {
		t.Errorf("version = %#v after setting the avatar", raw["version"])
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
		p.RunIDs == nil || len(p.RunIDs) != 0 || p.Version != 0 || p.Avatar != "" {
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

	// RecordResult: the best run per stage, a pass that sticks, attempts, resent runs.
	merges := 0
	record := func(player, runID, stage string, correct int, passed bool, at time.Duration) {
		t.Helper()
		if err := store.RecordResult(ctx, "a1", player, runID, stage, correct, 5, passed, base.Add(at)); err != nil {
			t.Fatal(err)
		}
		merges++
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
	record("p-1", "run-0001", "1", 3, false, time.Second)
	p := getPlayer("a1", "p-1")
	check("first run", p, "1", StageResult{Correct: 3, Total: 5, Attempts: 1, BestAt: at(time.Second)})
	if !timeIs(p.LastPlayedAt, at(time.Second)) || p.Version != 1 || !slices.Equal(p.RunIDs, []string{"run-0001"}) {
		t.Fatalf("after the first run: %+v", p)
	}
	record("p-1", "run-0002", "1", 4, true, 2*time.Second)
	check("a better run that passes", getPlayer("a1", "p-1"), "1", StageResult{Correct: 4, Total: 5, Attempts: 2, Passed: true, BestAt: at(2 * time.Second)})
	record("p-1", "run-0003", "1", 2, false, 3*time.Second)
	p = getPlayer("a1", "p-1")
	check("a worse run", p, "1", StageResult{Correct: 4, Total: 5, Attempts: 3, Passed: true, BestAt: at(2 * time.Second)})
	if !timeIs(p.LastPlayedAt, at(3*time.Second)) {
		t.Fatalf("a worse run still counts as played: %+v", p.LastPlayedAt)
	}
	record("p-1", "run-0004", "1", 4, true, 4*time.Second)
	check("an equal run", getPlayer("a1", "p-1"), "1", StageResult{Correct: 4, Total: 5, Attempts: 4, Passed: true, BestAt: at(2 * time.Second)})

	// A run id that was already recorded changes nothing, whatever it carries now.
	before := getPlayer("a1", "p-1")
	if err := store.RecordResult(ctx, "a1", "p-1", "run-0002", "1", 5, 5, true, at(time.Hour)); err != nil {
		t.Fatalf("resent run: %v", err)
	}
	if after := getPlayer("a1", "p-1"); after.Version != before.Version || after.Stages["1"] != before.Stages["1"] ||
		!timeIs(after.LastPlayedAt, *before.LastPlayedAt) || !slices.Equal(after.RunIDs, before.RunIDs) {
		t.Fatalf("a resent run changed the player: %+v -> %+v", before, after)
	}

	// A stage played for the first time takes its result even at 0; a pass made with the same
	// score as before still moves BestAt, because that is when the player passed.
	record("p-1", "run-0005", "2", 0, false, 5*time.Second)
	check("first run with no right answer", getPlayer("a1", "p-1"), "2", StageResult{Correct: 0, Total: 5, Attempts: 1, BestAt: at(5 * time.Second)})
	record("p-1", "run-0006", "3", 4, false, 6*time.Second)
	record("p-1", "run-0007", "3", 4, true, 7*time.Second)
	check("a pass at the same score", getPlayer("a1", "p-1"), "3", StageResult{Correct: 4, Total: 5, Attempts: 2, Passed: true, BestAt: at(7 * time.Second)})
	record("p-1", "run-0008", "3", 5, true, 8*time.Second)
	check("a better run after a pass", getPlayer("a1", "p-1"), "3", StageResult{Correct: 5, Total: 5, Attempts: 3, Passed: true, BestAt: at(8 * time.Second)})
	p = getPlayer("a1", "p-1")
	if len(p.Stages) != 3 || p.Version != merges || len(p.RunIDs) != merges {
		t.Fatalf("after the runs: stages %d, version %d, runIds %d, want 3, %d, %d", len(p.Stages), p.Version, len(p.RunIDs), merges, merges)
	}
	// The results left the avatar alone, and setting it did not count as one of the writes the version guards.
	if p.Avatar != "fox" {
		t.Fatalf("recording results changed the avatar: %+v", p)
	}
	// Another player of the assignment is untouched.
	if other := getPlayer("a1", "p-2"); len(other.Stages) != 0 || other.Version != 0 || other.LastPlayedAt != nil {
		t.Fatalf("a result reached another player: %+v", other)
	}

	// A result needs its player to be in that assignment.
	if err := store.RecordResult(ctx, "a2", "p-1", "run-0009", "1", 5, 5, true, base); !errors.Is(err, ErrNotFound) {
		t.Fatalf("result for a player of another assignment: %v", err)
	}
	if err := store.RecordResult(ctx, "a1", "ghost", "run-0009", "1", 5, 5, true, base); !errors.Is(err, ErrNotFound) {
		t.Fatalf("result for an unknown player: %v", err)
	}
	if after := getPlayer("a1", "p-1"); after.Version != merges {
		t.Fatalf("a refused result changed the player: %+v", after)
	}

	// Only the last 50 run ids are kept.
	for i := range 60 {
		if err := store.RecordResult(ctx, "a1", "p-3", fmt.Sprintf("cap-%04d", i), "1", i%6, 5, false, base.Add(time.Duration(i)*time.Second)); err != nil {
			t.Fatal(err)
		}
	}
	p = getPlayer("a1", "p-3")
	if len(p.RunIDs) != 50 || p.RunIDs[0] != "cap-0010" || p.RunIDs[49] != "cap-0059" || p.Stages["1"].Attempts != 60 || p.Version != 60 {
		t.Fatalf("run ids not capped: %d kept, first %q, last %q, attempts %d, version %d",
			len(p.RunIDs), p.RunIDs[0], p.RunIDs[len(p.RunIDs)-1], p.Stages["1"].Attempts, p.Version)
	}
	if err := store.RecordResult(ctx, "a1", "p-3", "cap-0059", "1", 5, 5, true, base); err != nil {
		t.Fatal(err)
	}
	if again := getPlayer("a1", "p-3"); again.Stages["1"].Attempts != 60 || again.Stages["1"].Passed {
		t.Fatalf("a recent run id counted twice: %+v", again)
	}

	// Runs reported at the same moment are all merged.
	const writers = 4
	var wg sync.WaitGroup
	errs := make(chan error, writers)
	for i := range writers {
		wg.Go(func() {
			errs <- store.RecordResult(ctx, "a1", "p-2", fmt.Sprintf("par-%04d", i), "2", i, 5, false, base.Add(time.Duration(i)*time.Second))
		})
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	if p = getPlayer("a1", "p-2"); p.Stages["2"].Attempts != writers || p.Stages["2"].Correct != writers-1 || len(p.RunIDs) != writers || p.Version != writers {
		t.Fatalf("concurrent results lost: %+v", p)
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

func TestMergeResult(t *testing.T) {
	now := time.Date(2026, 3, 1, 10, 0, 0, 123456789, time.FixedZone("UTC+7", 7*3600))
	p := &Player{}
	if !mergeResult(p, "run-0001", "1", 3, 5, false, now) {
		t.Fatal("the first run was not merged")
	}
	want := now.UTC().Truncate(time.Millisecond)
	if r := p.Stages["1"]; r.Correct != 3 || r.Total != 5 || r.Attempts != 1 || r.Passed || !r.BestAt.Equal(want) || r.BestAt.Location() != time.UTC {
		t.Fatalf("stage after the first run: %+v", r)
	}
	if !timeIs(p.LastPlayedAt, want) || !slices.Equal(p.RunIDs, []string{"run-0001"}) {
		t.Fatalf("player after the first run: %+v", p)
	}

	// A run id already seen changes nothing.
	snapshot := *p
	if mergeResult(p, "run-0001", "1", 5, 5, true, now.Add(time.Hour)) {
		t.Fatal("a resent run was merged")
	}
	if p.Stages["1"].Attempts != 1 || p.LastPlayedAt != snapshot.LastPlayedAt || len(p.RunIDs) != 1 {
		t.Fatalf("a resent run changed the player: %+v", p)
	}

	// The window of remembered runs slides.
	for i := range 2 * maxRunIDs {
		mergeResult(p, fmt.Sprintf("slide-%04d", i), "2", 0, 5, false, now)
	}
	if len(p.RunIDs) != maxRunIDs || p.RunIDs[0] != fmt.Sprintf("slide-%04d", maxRunIDs) || p.Stages["2"].Attempts != 2*maxRunIDs {
		t.Fatalf("run ids: %d kept, first %q, attempts %d", len(p.RunIDs), p.RunIDs[0], p.Stages["2"].Attempts)
	}
}
