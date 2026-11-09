package store

import (
	"context"
	"time"
)

// RadicalDetail is a note the model wrote once for a Radicals exercise ("Ghép bộ thủ") and that every later
// exercise reuses instead of asking again: a word's or a character's Vietnamese meaning, or a component's
// Sino-Vietnamese name, pinyin and meaning. The curated pools of package radicals come first; this only holds what
// they lack. Like the question bank it belongs to no user.
type RadicalDetail struct {
	// ID is Kind and Key joined by a colon, e.g. "char:借", "component:亻", "word:图书馆|túshūguǎn".
	ID   string `bson:"_id"`
	Kind string `bson:"kind"`
	Key  string `bson:"key"`
	// Meaning is Vietnamese; Name and Pinyin are a component's only.
	Meaning   string    `bson:"meaning"`
	Name      string    `bson:"name,omitempty"`
	Pinyin    string    `bson:"pinyin,omitempty"`
	Model     string    `bson:"model,omitempty"`
	Status    string    `bson:"status"`
	Uses      int       `bson:"uses"`
	CreatedAt time.Time `bson:"createdAt"`
}

// The kinds of a radical detail.
const (
	RadicalWord      = "word"
	RadicalChar      = "char"
	RadicalComponent = "component"
	// RadicalActive is the status of a detail in use; any other (say "retired") hides it.
	RadicalActive = "active"
)

// RadicalDetailID is the id of the detail of that kind and key.
func RadicalDetailID(kind, key string) string { return kind + ":" + key }

// RadicalDetails is implemented by MongoRadicalDetails (production) and MemoryRadicalDetails (tests).
type RadicalDetails interface {
	// Lookup returns the active details of those ids that are stored, keyed by id, and counts a use of each.
	Lookup(ctx context.Context, ids []string) (map[string]RadicalDetail, error)
	// Save stores the details whose id is not stored yet; one already stored is kept as it is.
	Save(ctx context.Context, details []RadicalDetail) error
}
