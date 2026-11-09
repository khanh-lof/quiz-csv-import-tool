package store

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

func TestMemoryRadicalDetails(t *testing.T) {
	testRadicalDetails(t, NewMemoryRadicalDetails())
}

func TestMongoRadicalDetails(t *testing.T) {
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
	testRadicalDetails(t, NewMongoRadicalDetails(db.Collection("RadicalDetails")))
}

func testRadicalDetails(t *testing.T, details RadicalDetails) {
	ctx := context.Background()
	detail := func(kind, key, meaning string) RadicalDetail {
		return RadicalDetail{ID: RadicalDetailID(kind, key), Kind: kind, Key: key, Meaning: meaning, Status: RadicalActive, CreatedAt: time.Now()}
	}
	if err := details.Save(ctx, []RadicalDetail{detail(RadicalChar, "借", "mượn"), detail(RadicalComponent, "亻", "người")}); err != nil {
		t.Fatal(err)
	}
	// A second answer for a stored id is ignored; a new one is stored.
	if err := details.Save(ctx, []RadicalDetail{detail(RadicalChar, "借", "vay"), detail(RadicalWord, "图书馆|túshūguǎn", "thư viện")}); err != nil {
		t.Fatal(err)
	}
	if err := details.Save(ctx, nil); err != nil {
		t.Fatal(err)
	}
	found, err := details.Lookup(ctx, []string{"char:借", "word:图书馆|túshūguǎn", "char:讲"})
	if err != nil {
		t.Fatal(err)
	}
	if len(found) != 2 || found["char:借"].Meaning != "mượn" || found["word:图书馆|túshūguǎn"].Meaning != "thư viện" {
		t.Fatalf("Lookup = %+v", found)
	}
	if found, err = details.Lookup(ctx, nil); err != nil || len(found) != 0 {
		t.Fatalf("empty Lookup = %v, %v", found, err)
	}
}
