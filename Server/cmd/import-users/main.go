// Command import-users copies users exported from the old Cosmos DB container into MongoDB.
//
// Export the container as a JSON array (e.g. run `SELECT * FROM c` in Cosmos Data Explorer and
// save the results), then:
//
//	MONGODB_URI=... go run ./cmd/import-users users.json
//
// Username, password hash, roles and creation date are imported; password hashes use the same
// format, so existing passwords keep working. Refresh tokens and rate-limit state are dropped
// (everyone logs in again). Users that already exist in MongoDB are skipped.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"quiz-csv-import-tool/server/internal/config"
	"quiz-csv-import-tool/server/internal/store"
)

type cosmosUser struct {
	ID           string   `json:"id"`
	Username     string   `json:"username"`
	PasswordHash string   `json:"passwordHash"`
	Roles        []string `json:"roles"`
	CreatedAt    string   `json:"createdAt"`
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "import-users:", err)
		os.Exit(1)
	}
}

func run() error {
	if len(os.Args) != 2 {
		return errors.New("usage: import-users <cosmos-export.json>")
	}
	raw, err := os.ReadFile(os.Args[1])
	if err != nil {
		return err
	}
	var docs []cosmosUser
	if err := json.Unmarshal(raw, &docs); err != nil {
		return fmt.Errorf("parsing %s (expected a JSON array of user documents): %w", os.Args[1], err)
	}

	if err := config.LoadDotEnv(".env"); err != nil {
		return err
	}
	// Only the MongoDB settings matter here; other missing settings are not an error.
	cfg, _ := config.FromEnv()
	if cfg.MongoURI == "" {
		return errors.New("MONGODB_URI is required")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	client, err := mongo.Connect(options.Client().ApplyURI(cfg.MongoURI))
	if err != nil {
		return err
	}
	defer func() { _ = client.Disconnect(context.Background()) }()
	users := store.NewMongo(client.Database(cfg.MongoDatabase).Collection(cfg.MongoCollection))
	if err := users.EnsureIndexes(ctx); err != nil {
		return err
	}

	var imported, skipped int
	for _, d := range docs {
		username := d.Username
		if username == "" {
			username = d.ID
		}
		if username == "" || d.PasswordHash == "" {
			fmt.Printf("skip: document without username or password hash (id %q)\n", d.ID)
			skipped++
			continue
		}
		err := users.Create(ctx, &store.User{
			Username:     username,
			PasswordHash: d.PasswordHash,
			Roles:        d.Roles,
			CreatedAt:    parseTime(d.CreatedAt),
		})
		switch {
		case errors.Is(err, store.ErrDuplicate):
			fmt.Printf("skip: %s already exists\n", username)
			skipped++
		case err != nil:
			return fmt.Errorf("importing %s: %w", username, err)
		default:
			fmt.Printf("imported: %s (roles: %s)\n", username, strings.Join(d.Roles, ", "))
			imported++
		}
	}
	fmt.Printf("done: %d imported, %d skipped\n", imported, skipped)
	return nil
}

// parseTime reads the ISO-8601 dates .NET wrote (up to 7 fractional digits, usually with a Z).
func parseTime(s string) time.Time {
	for _, layout := range []string{time.RFC3339Nano, "2006-01-02T15:04:05.9999999"} {
		if t, err := time.Parse(layout, s); err == nil {
			return t.UTC()
		}
	}
	return time.Now().UTC()
}
