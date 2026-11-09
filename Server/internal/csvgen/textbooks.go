package csvgen

import (
	"embed"
	"fmt"
	"io/fs"
	"slices"
	"strings"

	"golang.org/x/text/unicode/norm"
)

// The curated lesson documents of the textbooks QuizTool knows, one markdown file per lesson in
// textbooks/<dir>/lesson-NN.md, in the format pinned by Textbooks/LESSON_DOC_FORMAT.md. A quiz request
// for one of these lessons carries its document as the LESSON MATERIAL, so the model builds the quiz
// from the book instead of rebuilding the lesson from memory.
//
//go:embed textbooks
var textbookFiles embed.FS

// bookSpec is one textbook of the registry. The registry is hand-kept, and the client mirrors it in
// Client/src/models/textbook.ts: adding a book or a lesson means changing both and the folder.
type bookSpec struct {
	// dir is the folder under textbooks/.
	dir string
	// title is the short Chinese title, named in error messages; english completes the full name.
	title, english string
	// course is the course as the model is told about it ("HSK 3.0", "YCT").
	course     string
	courseType CourseType
	// standard is the HSK standard of an HSK book and zero for the other courses.
	standard HskStandard
	level    int
	// lessons is how many lesson files the folder must hold, no more and no fewer.
	lessons int
	// series names the books that form one series: a learner of level N knows the books of the lower
	// levels of the same series. Empty for a book that stands alone.
	series string
	// alsoKnown is a sentence for the learner's knowledge outside the material, if any.
	alsoKnown string
	// quizGuidance is an instruction for the quiz built from the book, sent with the lesson, if any.
	quizGuidance string
}

// fullName is the title with its English name, as the model is told about the textbook.
func (b bookSpec) fullName() string {
	return fmt.Sprintf("%s (%s)", b.title, b.english)
}

var textbookRegistry = []bookSpec{
	{dir: "hsk3-1", title: "《新HSK教程1》", english: "New HSK Course 1", course: "HSK 3.0", courseType: Hsk, standard: Hsk3, level: 1, lessons: 15, series: "hsk3"},
	{dir: "hsk3-2", title: "《新HSK教程2》", english: "New HSK Course 2", course: "HSK 3.0", courseType: Hsk, standard: Hsk3, level: 2, lessons: 15, series: "hsk3"},
	{dir: "hsk3-3", title: "《新HSK教程3》", english: "New HSK Course 3", course: "HSK 3.0", courseType: Hsk, standard: Hsk3, level: 3, lessons: 18, series: "hsk3"},
	{dir: "hsk2-1", title: "《HSK标准教程1》", english: "HSK Standard Course 1", course: "HSK 2.0", courseType: Hsk, standard: Hsk2, level: 1, lessons: 15, series: "hsk2"},
	{dir: "hsk2-2", title: "《HSK标准教程2》", english: "HSK Standard Course 2", course: "HSK 2.0", courseType: Hsk, standard: Hsk2, level: 2, lessons: 15, series: "hsk2"},
	{dir: "hsk2-3", title: "《HSK标准教程3》", english: "HSK Standard Course 3", course: "HSK 2.0", courseType: Hsk, standard: Hsk2, level: 3, lessons: 20, series: "hsk2"},
	// YCT 1 to 5 have no material here; the learner is assumed to know them.
	{dir: "yct-6", title: "《YCT标准教程6》", english: "YCT Standard Course 6", course: "YCT", courseType: Yct, level: 6, lessons: 15,
		alsoKnown: "The learner also knows the words of YCT levels 1 to 5."},
	// A single English book with no levels: its level is zero and a request for it carries none.
	{dir: "vocab10", title: "Ôn tập từ vựng lớp 10", english: "Grade 10 Vocabulary Review", course: "Ôn tập từ vựng lớp 10", courseType: VocabReview10, lessons: 8,
		quizGuidance: "Keep the quiz easy, for a Vietnamese grade 10 learner. Use only simple question types: what an English word or phrase means (and the reverse), filling the blank in a short sentence with the right word, putting the words of a short simple sentence in order, a short question answered with the word, and finding the word that does not belong to a topic's vocabulary group. Keep every question and sentence short and plain, make the wrong answers clearly different from the right one and take them from other words of the material, and ask no trick questions."},
}

// textbook is a book of the registry with its loaded lessons.
type textbook struct {
	bookSpec
	// docs holds the normalized document of each lesson, docs[0] being lesson 1.
	docs []string
	// words holds the Word column of each lesson's New words table, words[0] being lesson 1.
	words [][]string
	// rows holds the whole rows of each lesson's New words table, rows[0] being lesson 1.
	rows [][]LessonWord
}

// library is the loaded registry, in registry order.
type library []*textbook

var (
	// books is the library of the embedded documents, loaded when the package is. A document that does
	// not load leaves it empty and its error in booksError instead of panicking, so a half-written
	// folder cannot break every test: cmd/server refuses to start on it, through TextbooksError.
	books      library
	booksError error
)

func init() {
	embedded, err := fs.Sub(textbookFiles, "textbooks")
	if err != nil {
		booksError = fmt.Errorf("textbooks: %w", err)
		return
	}
	books, booksError = loadLibrary(embedded)
}

// TextbooksError is why the embedded lesson documents did not load, nil when they did. Until they do,
// no request has any LESSON MATERIAL, so the server checks it on start.
func TextbooksError() error {
	return booksError
}

// loadLibrary reads and checks the lesson documents of every registered book in fsys, laid out as
// <dir>/lesson-NN.md. It stops at the first problem, naming the book and the lesson.
func loadLibrary(fsys fs.FS) (library, error) {
	return loadBooks(fsys, textbookRegistry)
}

func loadBooks(fsys fs.FS, specs []bookSpec) (library, error) {
	lib := make(library, 0, len(specs))
	for _, spec := range specs {
		book := &textbook{bookSpec: spec}
		wanted := make(map[string]bool, spec.lessons)
		for n := 1; n <= spec.lessons; n++ {
			name := lessonFileName(n)
			wanted[name] = true
			raw, err := fs.ReadFile(fsys, spec.dir+"/"+name)
			if err != nil {
				return nil, fmt.Errorf("textbook %s lesson %d: %w", spec.dir, n, err)
			}
			doc := normalizePrompt(string(raw))
			rows, err := parseNewWordRows(doc, n)
			if err != nil {
				return nil, fmt.Errorf("textbook %s lesson %d: %w", spec.dir, n, err)
			}
			book.docs = append(book.docs, doc)
			book.words = append(book.words, wordCells(rows))
			book.rows = append(book.rows, rows)
		}
		// The count is pinned, so a stray file is a lesson the registry does not know about.
		entries, err := fs.ReadDir(fsys, spec.dir)
		if err != nil {
			return nil, fmt.Errorf("textbook %s: %w", spec.dir, err)
		}
		for _, entry := range entries {
			if name := entry.Name(); strings.HasPrefix(name, "lesson-") && !wanted[name] {
				return nil, fmt.Errorf("textbook %s: unexpected file %s, the book has %d lessons", spec.dir, name, spec.lessons)
			}
		}
		lib = append(lib, book)
	}
	return lib, nil
}

func lessonFileName(lesson int) string {
	return fmt.Sprintf("lesson-%02d.md", lesson)
}

// The two word tables of a lesson document. New words has Word, Pinyin, POS, English, Tiếng Việt and Note
// (where ★ marks a word beyond the syllabus); Proper nouns has four columns, the meaning last.
const (
	newWordsHeading    = "## New words"
	properNounsHeading = "## Proper nouns"
	newWordsColumns    = 6
	newWordsNoteColumn = 5
	properNounsColumns = 4
)

// LessonWord is one row of a lesson's New words table: the word as the book writes it, its pinyin (empty in
// an English book), its part of speech (empty in YCT), its English and Vietnamese meanings, and Star when the
// Note marks it ★, beyond the syllabus. Lesson is the lesson whose table holds the row.
type LessonWord struct {
	Lesson     int
	Word       string
	Pinyin     string
	POS        string
	English    string
	Vietnamese string
	Star       bool
}

// Key names the word within its book: the word, its pinyin and its part of speech, which is how the lesson
// documents tell homographs apart (上 n. "trên" and 上 v. "lên"), in Unicode NFC. A word repeated by a later
// lesson, a review lesson's above all, has the same key there.
func (w LessonWord) Key() string {
	return norm.NFC.String(w.Word + "|" + w.Pinyin + "|" + w.POS)
}

// Vocabulary is what a quiz request asks to be tested: the testable words of the lessons it names (every New
// words row but the ★ ones, each key once, in lesson and table order) and the book they come from, named by
// its folder, which is also the question bank's name for it.
type Vocabulary struct {
	Book    string
	Lessons []int
	Words   []LessonWord
}

// MaxLesson is the highest lesson asked for: the learner knows every word up to it.
func (v Vocabulary) MaxLesson() int {
	return v.Lessons[len(v.Lessons)-1]
}

// LessonVocabulary is the Vocabulary of a creative request, false when its course has no embedded textbook
// or it names a lesson the book does not have.
func LessonVocabulary(opts Options) (Vocabulary, bool) {
	book := textbookFor(opts)
	if book == nil || len(opts.LessonNumbers) == 0 {
		return Vocabulary{}, false
	}
	vocabulary := Vocabulary{Book: book.dir, Lessons: slices.Clone(opts.LessonNumbers)}
	seen := map[string]bool{}
	for _, lesson := range opts.LessonNumbers {
		if lesson < 1 || lesson > book.lessons {
			return Vocabulary{}, false
		}
		for _, word := range book.rows[lesson-1] {
			if word.Star || seen[word.Key()] {
				continue
			}
			seen[word.Key()] = true
			vocabulary.Words = append(vocabulary.Words, word)
		}
	}
	return vocabulary, len(vocabulary.Words) > 0
}

// parseNewWords returns the Word cell of every row of the "## New words" table of a normalized lesson
// document (see parseNewWordRows).
func parseNewWords(doc string) ([]string, error) {
	rows, err := parseNewWordRows(doc, 0)
	if err != nil {
		return nil, err
	}
	return wordCells(rows), nil
}

func wordCells(rows []LessonWord) []string {
	words := make([]string, len(rows))
	for i, row := range rows {
		words[i] = row.Word
	}
	return words
}

// parseNewWordRows returns every row of the "## New words" table of a normalized lesson document: the rows
// between that heading and the next "## " heading, without the header and its separator. lesson is the
// lesson the document is, written on each row.
func parseNewWordRows(doc string, lesson int) ([]LessonWord, error) {
	inSection, found := false, false
	var rows []LessonWord
	seenHeader := false
	for _, line := range strings.Split(doc, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "## ") {
			if inSection {
				break
			}
			inSection = line == newWordsHeading
			found = found || inSection
			continue
		}
		if !inSection || !strings.HasPrefix(line, "|") {
			continue
		}
		if !seenHeader {
			seenHeader = true
			continue
		}
		cells := splitTableRow(line)
		if joined := strings.Join(cells, ""); strings.Contains(joined, "-") && strings.Trim(joined, "-:") == "" {
			continue // the |---| separator
		}
		if len(cells) != newWordsColumns {
			return nil, fmt.Errorf("New words row %q has %d cells, want %d", line, len(cells), newWordsColumns)
		}
		if cells[0] == "" || strings.Contains(cells[0], "★") {
			return nil, fmt.Errorf("New words row %q has an empty Word or one marked with ★", line)
		}
		rows = append(rows, LessonWord{
			Lesson: lesson, Word: cells[0], Pinyin: cells[1], POS: cells[2], English: cells[3], Vietnamese: cells[4],
			Star: strings.Contains(cells[newWordsNoteColumn], "★"),
		})
	}
	if !found {
		return nil, fmt.Errorf("no \"## New words\" section")
	}
	if len(rows) == 0 {
		return nil, fmt.Errorf("the New words table has no rows")
	}
	return rows, nil
}

// splitTableRow cuts a markdown table row into its trimmed cells.
func splitTableRow(line string) []string {
	line = strings.TrimSuffix(strings.TrimPrefix(strings.TrimSpace(line), "|"), "|")
	cells := strings.Split(line, "|")
	for i, cell := range cells {
		cells[i] = strings.TrimSpace(cell)
	}
	return cells
}

// textbookFor returns the book the course and level of opts are taught from, nil when none of the
// embedded ones is: a free-form course (Other), HSK 2.0 and any level without material never match.
func textbookFor(opts Options) *textbook {
	for _, book := range books {
		if book.courseType != opts.CourseType {
			continue
		}
		if book.level != 0 && (opts.Level == nil || book.level != *opts.Level) {
			continue
		}
		if opts.CourseType == Hsk && book.standard != opts.HskStandard {
			continue
		}
		return book
	}
	return nil
}

// lessonMaterial is the message that carries the lessons of the book to the model: the document of each
// lesson, in the order given, and the vocabulary the learner already knows, which for a book of a series
// includes the lower books of the library. The lessons are ascending and unique, as Options.LessonNumbers
// is. It is empty when there are none or the book lacks one of them.
func lessonMaterial(book *textbook, lessons []int) string {
	if len(lessons) == 0 {
		return ""
	}
	docs := make([]string, len(lessons))
	for i, lesson := range lessons {
		if lesson < 1 || lesson > book.lessons {
			return ""
		}
		docs[i] = book.docs[lesson-1]
	}
	var out strings.Builder
	if len(lessons) == 1 {
		fmt.Fprintf(&out, "LESSON MATERIAL: %s, lesson %d of %d, taken from the textbook itself.\n\n", book.fullName(), lessons[0], book.lessons)
	} else {
		fmt.Fprintf(&out, "LESSON MATERIAL: %s, lessons %s of %d, taken from the textbook itself.\n\n",
			book.fullName(), joinWords(numberStrings(lessons), "and"), book.lessons)
	}
	out.WriteString(strings.Join(docs, "\n\n"))
	out.WriteString("\n\n")
	out.WriteString(knownVocabulary(book, lessons))
	return out.String()
}

// knownVocabulary is the last line of the material: the New words of the lower books of the series and of
// the lessons of the book that come before the highest lesson asked for and are not asked for themselves,
// deduplicated and in book order, as the learner knows them. The lessons asked for are the ones to learn.
func knownVocabulary(book *textbook, lessons []int) string {
	var words []string
	var sources []string
	if book.series != "" {
		lower := false
		for _, other := range books {
			if other.series != book.series || other.level >= book.level {
				continue
			}
			lower = true
			for _, lessonWords := range other.words {
				words = append(words, lessonWords...)
			}
		}
		if lower {
			sources = append(sources, "the lower levels of the series")
		}
	}
	earlier := false
	for lesson := 1; lesson < lessons[len(lessons)-1]; lesson++ {
		if !slices.Contains(lessons, lesson) {
			words = append(words, book.words[lesson-1]...)
			earlier = true
		}
	}
	if earlier {
		// Named first, although the lower levels come first in the list itself.
		sources = slices.Insert(sources, 0, "the earlier lessons of this book")
	}

	var line string
	if len(words) == 0 {
		line = "The learner knows no earlier words of this course."
	} else {
		var unique []string
		seen := make(map[string]bool, len(words))
		for _, word := range words {
			if !seen[word] {
				seen[word] = true
				unique = append(unique, word)
			}
		}
		separator := "、"
		if courseLanguages[book.courseType] == English {
			separator = ", "
		}
		line = fmt.Sprintf("Known vocabulary (words of %s, which the learner already knows; use them freely in sentences and distractors): %s",
			strings.Join(sources, " and of "), strings.Join(unique, separator))
	}
	if book.alsoKnown != "" {
		line += "\n" + book.alsoKnown
	}
	return line
}
