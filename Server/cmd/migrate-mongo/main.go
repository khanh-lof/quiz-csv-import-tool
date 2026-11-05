// Command migrate-mongo copies the data of the MongoDB the server used before into PostgreSQL: users (with
// their sessions and AI rate-limit state), AI jobs, assignments and their players. Login attempts are not
// copied; they only last a few minutes.
//
// Stop the old deployment first, so nothing changes during the copy, then:
//
//	MONGODB_URI=mongodb+srv://... DATABASE_URL=postgres://... go run ./cmd/migrate-mongo
//
// MONGODB_DATABASE defaults to QuizDb, and the flags name the collections when they are not the defaults. A row
// that already exists in PostgreSQL is skipped, so the copy can be run again after a failure; it does not
// update a row that changed in MongoDB since. Delete this command, the bson tags of the store types and the
// MongoDB driver once the data is moved.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"strings"

	"github.com/jackc/pgx/v5/pgconn"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"quiz-csv-import-tool/server/internal/config"
	"quiz-csv-import-tool/server/internal/store"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "migrate-mongo:", err)
		os.Exit(1)
	}
}

func run() error {
	usersCollection := flag.String("users", "Users", "the users collection")
	jobsCollection := flag.String("jobs", "Jobs", "the AI jobs collection")
	assignmentsCollection := flag.String("assignments", "Assignments", "the assignments collection")
	playersCollection := flag.String("players", "AssignmentPlayers", "the assignment players collection")
	flag.Parse()

	if err := config.LoadDotEnv(".env"); err != nil {
		return err
	}
	mongoURI := strings.TrimSpace(os.Getenv("MONGODB_URI"))
	databaseURL := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	if mongoURI == "" || databaseURL == "" {
		return errors.New("MONGODB_URI and DATABASE_URL are required")
	}
	mongoDatabase := strings.TrimSpace(os.Getenv("MONGODB_DATABASE"))
	if mongoDatabase == "" {
		mongoDatabase = "QuizDb"
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()

	client, err := mongo.Connect(options.Client().ApplyURI(mongoURI))
	if err != nil {
		return fmt.Errorf("connecting to MongoDB: %w", err)
	}
	defer func() { _ = client.Disconnect(context.Background()) }()
	if err := client.Ping(ctx, nil); err != nil {
		return fmt.Errorf("pinging MongoDB: %w", err)
	}
	db := client.Database(mongoDatabase)

	pool, err := store.OpenPostgres(ctx, databaseURL)
	if err != nil {
		return fmt.Errorf("connecting to PostgreSQL: %w", err)
	}
	defer pool.Close()
	if err := store.Migrate(ctx, pool); err != nil {
		return fmt.Errorf("creating the tables: %w", err)
	}
	users := store.NewPostgresUsers(pool)
	jobs := store.NewPostgresJobs(pool)
	assignments := store.NewPostgresAssignments(pool)

	// Assignments go before their players, which reference them.
	steps := []func() error{
		func() error { return copyCollection(ctx, db.Collection(*usersCollection), "users", users.Create) },
		func() error { return copyCollection(ctx, db.Collection(*jobsCollection), "jobs", jobs.Create) },
		func() error {
			return copyCollection(ctx, db.Collection(*assignmentsCollection), "assignments", assignments.Create)
		},
		func() error {
			return copyCollection(ctx, db.Collection(*playersCollection), "players", assignments.CreatePlayer)
		},
	}
	for _, step := range steps {
		if err := step(); err != nil {
			return err
		}
	}
	return nil
}

// copyCollection inserts every document of the collection with insert, skipping the ones already there and
// the players of an assignment that no longer exists.
func copyCollection[T any](ctx context.Context, coll *mongo.Collection, name string, insert func(context.Context, *T) error) error {
	total, err := coll.CountDocuments(ctx, bson.M{})
	if err != nil {
		return fmt.Errorf("counting %s: %w", name, err)
	}
	cursor, err := coll.Find(ctx, bson.M{})
	if err != nil {
		return fmt.Errorf("reading %s: %w", name, err)
	}
	defer func() { _ = cursor.Close(context.Background()) }()

	var copied, existing, orphans int
	for cursor.Next(ctx) {
		var doc T
		if err := cursor.Decode(&doc); err != nil {
			return fmt.Errorf("decoding %s document %v: %w", name, cursor.Current.Lookup("_id"), err)
		}
		err := insert(ctx, &doc)
		var pgErr *pgconn.PgError
		switch {
		case errors.Is(err, store.ErrDuplicate):
			existing++
		case errors.As(err, &pgErr) && pgErr.Code == "23503":
			orphans++
		case err != nil:
			return fmt.Errorf("copying %s document %v: %w", name, cursor.Current.Lookup("_id"), err)
		default:
			copied++
		}
	}
	if err := cursor.Err(); err != nil {
		return fmt.Errorf("reading %s: %w", name, err)
	}
	fmt.Printf("%s: %d in MongoDB, %d copied, %d already there", name, total, copied, existing)
	if orphans > 0 {
		fmt.Printf(", %d skipped (their assignment is gone)", orphans)
	}
	fmt.Println()
	return nil
}
