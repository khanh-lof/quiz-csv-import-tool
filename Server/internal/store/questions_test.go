package store

import (
	"context"
	"fmt"
	"os"
	"slices"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

func TestMemoryQuestionBank(t *testing.T) {
	testQuestionBank(t, NewMemoryQuestionBank())
}

func TestMongoQuestionBank(t *testing.T) {
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
	bank := NewMongoQuestionBank(db.Collection("QuestionBank"))
	if err := bank.EnsureIndexes(context.Background()); err != nil {
		t.Fatal(err)
	}
	testQuestionBank(t, bank)
}

func testQuestionBank(t *testing.T, bank QuestionBank) {
	ctx := context.Background()
	question := func(id, book, fingerprint string, maxLesson int) Question {
		return Question{
			ID: id, Book: book, Lessons: []int{maxLesson}, MaxLesson: maxLesson, Targets: []string{"你|nǐ|pron."},
			Format: "mc", Skill: "meaning", Difficulty: 1, Stem: Text{Text: "你"}, Answer: Text{Text: "bạn"},
			Distractors: []Text{{Text: "tôi"}, {Text: "nó"}, {Text: "họ"}}, Explanation: "e",
			Fingerprint: fingerprint, Status: QuestionActive, CreatedAt: time.Now(),
		}
	}

	// Insert leaves out a fingerprint the book holds, or one repeated in the list, but not the same one in
	// another book.
	ids, err := bank.Insert(ctx, []Question{
		question("a", "hsk3-1", "f1", 3), question("b", "hsk3-1", "f2", 5), question("c", "hsk3-1", "f1", 3),
		question("d", "hsk3-2", "f1", 3),
	})
	if err != nil || !slices.Equal(ids, []string{"a", "b", "d"}) {
		t.Fatalf("Insert = %v, %v", ids, err)
	}
	if ids, err = bank.Insert(ctx, []Question{question("e", "hsk3-1", "f2", 2), question("f", "hsk3-1", "f3", 2)}); err != nil ||
		!slices.Equal(ids, []string{"f"}) {
		t.Fatalf("second Insert = %v, %v", ids, err)
	}
	if ids, err = bank.Insert(ctx, nil); err != nil || len(ids) != 0 {
		t.Fatalf("empty Insert = %v, %v", ids, err)
	}

	// Pool keeps to the book, the language and the highest lesson.
	poolIDs := func(language int, book string, maxLesson int) []string {
		t.Helper()
		pool, err := bank.Pool(ctx, language, book, maxLesson)
		if err != nil {
			t.Fatal(err)
		}
		var got []string
		for _, q := range pool {
			got = append(got, q.ID)
		}
		slices.Sort(got)
		return got
	}
	if got := poolIDs(0, "hsk3-1", 3); !slices.Equal(got, []string{"a", "f"}) {
		t.Errorf("pool up to lesson 3 = %v", got)
	}
	if got := poolIDs(0, "hsk3-1", 5); !slices.Equal(got, []string{"a", "b", "f"}) {
		t.Errorf("pool up to lesson 5 = %v", got)
	}
	if got := poolIDs(1, "hsk3-1", 5); len(got) != 0 {
		t.Errorf("pool in English = %v", got)
	}

	// MarkServed counts each question once per call; the documents keep their content.
	at := time.Date(2026, 11, 9, 8, 0, 0, 0, time.UTC)
	if err := bank.MarkServed(ctx, []string{"a", "f"}, at); err != nil {
		t.Fatal(err)
	}
	if err := bank.MarkServed(ctx, []string{"a"}, at.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	pool, err := bank.Pool(ctx, 0, "hsk3-1", 3)
	if err != nil {
		t.Fatal(err)
	}
	for _, q := range pool {
		switch q.ID {
		case "a":
			if q.ServedCount != 2 || q.LastServedAt == nil || !q.LastServedAt.Equal(at.Add(time.Minute)) {
				t.Errorf("a served %d, last %v", q.ServedCount, q.LastServedAt)
			}
			if len(q.Distractors) != 3 || q.Stem.Text != "你" || q.Targets[0] != "你|nǐ|pron." {
				t.Errorf("a = %+v", q)
			}
		case "f":
			if q.ServedCount != 1 {
				t.Errorf("f served %d", q.ServedCount)
			}
		}
	}
	if err := bank.MarkServed(ctx, nil, at); err != nil {
		t.Fatal(err)
	}
}
