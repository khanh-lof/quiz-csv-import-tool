// Command bank-questions adds questions to the question bank written by someone other than the server's model:
// Claude Code, through the add-bank-questions skill (.claude/skills/add-bank-questions), or a person. It takes the
// same steps as a creative job that fills the bank (package bank, Service.Fill), with the model call left to the
// writer:
//
//	go run ./cmd/bank-questions status --course hsk3 --level 1 --lessons 3,4
//	go run ./cmd/bank-questions prompt --course hsk3 --level 1 --lessons 3,4 --count 20 --out prompt.md
//	go run ./cmd/bank-questions insert --course hsk3 --level 1 --lessons 3,4 --file answer.json [--dry-run]
//
// status shows how many active questions the bank holds on each word of the lessons. prompt plans --count new
// questions for the least covered words (bank.TopUpSpecs, --visual of them with an image, for Wayground) and writes the exact request the model would get (the
// bank system prompt, the lesson material, the numbered WORD LIST and the REQUEST) to --out. insert reads an answer
// in the JSON the system prompt asks for, maps its W ids back to the words, checks every question with
// bank.Validate and stores the valid ones (store.QuestionBank.Insert skips any the book already holds); --dry-run
// checks and reports without writing. Both also load the image link of every visual question and reject the ones
// that do not answer with an image.
//
// Run it from Server/: it reads .env like the server. MONGODB_URI, MONGODB_DATABASE and
// MONGODB_QUESTIONS_COLLECTION name the bank, or --mongo-uri, --database and --collection.
package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"slices"
	"strconv"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"quiz-csv-import-tool/server/internal/bank"
	"quiz-csv-import-tool/server/internal/config"
	"quiz-csv-import-tool/server/internal/csvgen"
	"quiz-csv-import-tool/server/internal/store"
)

const usage = `usage:
  bank-questions status --course C [--level N] --lessons L
  bank-questions prompt --course C [--level N] --lessons L --count N [--visual N] --out FILE
  bank-questions insert --course C [--level N] --lessons L --file FILE [--dry-run] [--writer NAME]

  --course   hsk3 (HSK 3.0), hsk2 (HSK 2.0), yct or vocab10 (Ôn tập từ vựng lớp 10, no level)
  --lessons  the lesson numbers, e.g. 3 or 3,4 (comma-separated)
  database   --mongo-uri, --database, --collection; default from .env / MONGODB_*`

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "bank-questions:", err)
		os.Exit(1)
	}
}

// args are the settings every subcommand reads.
type args struct {
	course, lessons, level   string
	mongoURI, database, coll string
	count, visual            int
	out, file, writer        string
	dryRun                   bool
}

func run(argv []string) error {
	if len(argv) == 0 || !slices.Contains([]string{"status", "prompt", "insert"}, argv[0]) {
		return errors.New(usage)
	}
	if err := config.LoadDotEnv(".env"); err != nil {
		return err
	}
	// Only the MongoDB settings matter here; other missing settings are not an error.
	cfg, _ := config.FromEnv()

	var a args
	fs := flag.NewFlagSet(argv[0], flag.ContinueOnError)
	fs.StringVar(&a.course, "course", "", "hsk3, hsk2, yct or vocab10")
	fs.StringVar(&a.level, "level", "", "the book's level")
	fs.StringVar(&a.lessons, "lessons", "", "the lesson numbers, e.g. 3,4")
	fs.StringVar(&a.mongoURI, "mongo-uri", cfg.MongoURI, "MongoDB connection string")
	fs.StringVar(&a.database, "database", cfg.MongoDatabase, "database")
	fs.StringVar(&a.coll, "collection", cfg.MongoQuestionsCollection, "question bank collection")
	fs.IntVar(&a.count, "count", 0, "prompt: how many questions to plan")
	fs.IntVar(&a.visual, "visual", 0, "prompt: how many of them are visual questions with an image (Wayground only)")
	fs.StringVar(&a.out, "out", "", "prompt: the file the request is written to")
	fs.StringVar(&a.file, "file", "", "insert: the answer JSON")
	fs.StringVar(&a.writer, "writer", "claude-code", "insert: who wrote the questions, stored as their model")
	fs.BoolVar(&a.dryRun, "dry-run", false, "insert: check and report, store nothing")
	if err := fs.Parse(argv[1:]); err != nil {
		return err
	}
	if fs.NArg() > 0 {
		return fmt.Errorf("unexpected argument %q\n%s", fs.Arg(0), usage)
	}

	opts, err := optionsOf(a)
	if err != nil {
		return err
	}
	vocabulary, ok := csvgen.LessonVocabulary(opts)
	if !ok {
		return errors.New("those lessons have no testable words")
	}
	switch argv[0] {
	case "prompt":
		if a.count < 1 || a.out == "" {
			return errors.New("prompt needs --count (1 or more) and --out")
		}
	case "insert":
		if a.file == "" {
			return errors.New("insert needs --file")
		}
	}

	if a.mongoURI == "" {
		return errors.New("no MongoDB: set MONGODB_URI in .env or pass --mongo-uri")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	client, err := mongo.Connect(options.Client().ApplyURI(a.mongoURI).SetServerSelectionTimeout(10 * time.Second))
	if err != nil {
		return err
	}
	defer func() { _ = client.Disconnect(context.Background()) }()
	if err := client.Ping(ctx, nil); err != nil {
		return fmt.Errorf("cannot reach MongoDB at %s: %w", redact(a.mongoURI), err)
	}
	collection := client.Database(a.database).Collection(a.coll)
	questions := store.NewMongoQuestionBank(collection)
	fmt.Printf("Bank: %s, %s.%s\n", redact(a.mongoURI), a.database, a.coll)
	fmt.Printf("Book: %s, lessons %s, %d testable words\n", vocabulary.Book, joinInts(vocabulary.Lessons), len(vocabulary.Words))

	pool, err := questions.Pool(ctx, int(opts.Language), vocabulary.Book, vocabulary.MaxLesson())
	if err != nil {
		return fmt.Errorf("reading the bank: %w", err)
	}
	switch argv[0] {
	case "status":
		printCoverage(vocabulary, pool)
		return nil
	case "prompt":
		return writePrompt(a, opts, vocabulary, pool)
	}
	return insert(ctx, a, opts, vocabulary, questions, collection)
}

// optionsOf reads the course, level and lessons as the creative request would carry them, for any platform the
// bank serves (the questions are the same for all).
func optionsOf(a args) (csvgen.Options, error) {
	q := url.Values{"exportType": {"GimKit"}, "lessonNumbers": {a.lessons}}
	if a.level != "" {
		q.Set("level", a.level)
	}
	switch strings.ToLower(strings.TrimSpace(a.course)) {
	case "hsk3":
		q.Set("courseType", "Hsk")
		q.Set("hskStandard", "3")
	case "hsk2":
		q.Set("courseType", "Hsk")
		q.Set("hskStandard", "2")
	case "yct":
		q.Set("courseType", "Yct")
	case "vocab10":
		q.Set("courseType", "VocabReview10")
		q.Set("language", "English")
	default:
		return csvgen.Options{}, fmt.Errorf("unknown --course %q\n%s", a.course, usage)
	}
	opts, err := csvgen.ParseCreativeOptions(q)
	if err != nil {
		return csvgen.Options{}, errors.New(err.Error())
	}
	if _, ok := csvgen.LessonVocabulary(opts); !ok {
		return csvgen.Options{}, errors.New("no embedded textbook for that course and level, or no such lesson")
	}
	return opts, nil
}

func printCoverage(vocabulary csvgen.Vocabulary, pool []store.Question) {
	held := bank.Coverage(vocabulary, pool)
	total, none := 0, 0
	fmt.Println("\nActive questions per word (easy/medium/hard):")
	for i, w := range vocabulary.Words {
		c := held[w.Key()]
		total += c.Total()
		if c.Total() == 0 {
			none++
		}
		fmt.Printf("  W%-3d L%-2d %s %s (%s)  %d/%d/%d\n", i+1, w.Lesson, w.Word, w.Pinyin, w.Vietnamese, c[0], c[1], c[2])
	}
	fmt.Printf("%d word-question links in all; %d of %d words have no question.\n", total, none, len(vocabulary.Words))
}

func writePrompt(a args, opts csvgen.Options, vocabulary csvgen.Vocabulary, pool []store.Question) error {
	printCoverage(vocabulary, pool)
	if a.count > bank.MaxTopUp {
		fmt.Printf("\n--count %d is more than one request takes; planning %d. Run again for the rest.\n", a.count, bank.MaxTopUp)
	}
	specs := bank.TopUpSpecs(vocabulary, pool, a.count, a.visual)
	prompt, err := csvgen.NewBankPrompt(opts, vocabulary, specs)
	if err != nil {
		return err
	}
	var out strings.Builder
	out.WriteString("# SYSTEM PROMPT\n\n")
	out.WriteString(prompt.Instructions)
	out.WriteString("\n\n# USER MESSAGES\n")
	for _, m := range prompt.Messages {
		out.WriteString("\n---\n\n")
		out.WriteString(m)
		out.WriteString("\n")
	}
	if err := os.WriteFile(a.out, []byte(out.String()), 0o644); err != nil {
		return err
	}
	var levels [3]int
	visual := 0
	for _, s := range specs {
		levels[s.Difficulty-1]++
		if s.Visual {
			visual++
		}
	}
	fmt.Printf("\nPlanned %d questions (%d easy, %d medium, %d hard; %d visual). Request written to %s\n",
		len(specs), levels[0], levels[1], levels[2], visual, a.out)
	if visual < a.visual {
		fmt.Printf("Only %d of the --visual %d: visual questions are easy or medium multiple-choice ones.\n", visual, a.visual)
	}
	return nil
}

func insert(ctx context.Context, a args, opts csvgen.Options, vocabulary csvgen.Vocabulary, questions *store.MongoQuestionBank, collection *mongo.Collection) error {
	raw, err := os.ReadFile(a.file)
	if err != nil {
		return err
	}
	// The ids depend on the vocabulary alone, so they are those of the prompt.
	prompt, err := csvgen.NewBankPrompt(opts, vocabulary, nil)
	if err != nil {
		return err
	}
	drafts, dropped, err := csvgen.ParseBankAnswer(string(raw), prompt.IDs)
	for _, d := range dropped {
		fmt.Printf("  rejected #%d: targets %v name no word of the list\n", d.Index, d.Targets)
	}
	if err != nil {
		return fmt.Errorf("reading %s: %w", a.file, err)
	}
	origin := bank.Origin{Vocabulary: vocabulary, Language: opts.Language, Model: a.writer, Now: time.Now()}
	var valid []store.Question
	rejected := len(dropped)
	for _, d := range drafts {
		q, err := bank.Validate(d, origin, newID())
		if err == nil && q.ImageURL != "" {
			err = checkImage(ctx, q.ImageURL)
		}
		if err != nil {
			rejected++
			fmt.Printf("  rejected %q: %v\n", short(d.Stem), err)
			continue
		}
		valid = append(valid, q)
	}
	fmt.Printf("\n%d questions read, %d valid, %d rejected.\n", len(drafts)+len(dropped), len(valid), rejected)
	if len(valid) == 0 {
		return errors.New("nothing to store")
	}

	if a.dryRun {
		held, err := heldFingerprints(ctx, collection, vocabulary.Book, valid)
		if err != nil {
			return err
		}
		fresh := 0
		seen := map[string]bool{}
		for _, q := range valid {
			if !held[q.Fingerprint] && !seen[q.Fingerprint] {
				fresh++
			}
			seen[q.Fingerprint] = true
		}
		fmt.Printf("Dry run: %d would be stored, %d are already in the bank or repeated. Nothing written.\n", fresh, len(valid)-fresh)
		return nil
	}
	stored, err := questions.Insert(ctx, valid)
	if err != nil {
		return fmt.Errorf("storing: %w", err)
	}
	var levels [3]int
	formats := map[string]int{}
	for _, q := range valid {
		if slices.Contains(stored, q.ID) {
			levels[q.Difficulty-1]++
			formats[q.Format]++
		}
	}
	fmt.Printf("Stored %d (%d easy, %d medium, %d hard; formats %v); %d were already in the bank or repeated.\n",
		len(stored), levels[0], levels[1], levels[2], formats, len(valid)-len(stored))
	return nil
}

var imageClient = &http.Client{Timeout: 20 * time.Second}

// checkImage says why link does not load as an image, nil when it does. Quiz platforms load it in the learner's
// browser, so it is fetched as a browser would, without cookies.
func checkImage(ctx context.Context, link string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, link, nil)
	if err != nil {
		return fmt.Errorf("the image link %q: %w", link, err)
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (compatible; QuizTool-bank-questions)")
	req.Header.Set("Accept", "image/*")
	resp, err := imageClient.Do(req)
	if err != nil {
		return fmt.Errorf("the image %q does not load: %w", link, err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("the image link %q answers %s", link, resp.Status)
	}
	if contentType := resp.Header.Get("Content-Type"); !strings.HasPrefix(contentType, "image/") {
		return fmt.Errorf("the link %q is %q, not an image", link, contentType)
	}
	return nil
}

// heldFingerprints is which of the questions' fingerprints the book already holds.
func heldFingerprints(ctx context.Context, collection *mongo.Collection, book string, questions []store.Question) (map[string]bool, error) {
	fingerprints := make([]string, len(questions))
	for i, q := range questions {
		fingerprints[i] = q.Fingerprint
	}
	cursor, err := collection.Find(ctx, bson.M{"book": book, "fingerprint": bson.M{"$in": fingerprints}},
		options.Find().SetProjection(bson.M{"fingerprint": 1}))
	if err != nil {
		return nil, err
	}
	var found []struct {
		Fingerprint string `bson:"fingerprint"`
	}
	if err := cursor.All(ctx, &found); err != nil {
		return nil, err
	}
	held := map[string]bool{}
	for _, f := range found {
		held[f.Fingerprint] = true
	}
	return held, nil
}

// newID is a random 32-hex-digit id, as the server gives a new question.
func newID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

// redact is a connection string without its password, to print.
func redact(uri string) string {
	u, err := url.Parse(uri)
	if err != nil {
		return "(unparsable MongoDB URI)"
	}
	u.User = nil
	u.RawQuery = ""
	return u.String()
}

func joinInts(ns []int) string {
	parts := make([]string, len(ns))
	for i, n := range ns {
		parts[i] = strconv.Itoa(n)
	}
	return strings.Join(parts, ",")
}

func short(text string) string {
	if r := []rune(text); len(r) > 40 {
		return string(r[:40]) + "…"
	}
	return text
}
