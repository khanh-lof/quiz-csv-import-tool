package csvgen

import (
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"testing"
)

// textbookSources is the repository's Textbooks folder, where each book's vocabulary-index.md (typed from
// the book's own word list) is the authority on which lesson a word belongs to, its pinyin and its ★.
var textbookSources = filepath.Join("..", "..", "..", "Textbooks")

// reviewLessons are lessons that introduce no words but review earlier ones: their New words table holds
// every word of the reviewed lessons.
var reviewLessons = map[string]map[int][2]int{
	"yct-6": {15: {1, 14}},
}

type indexEntry struct {
	word, pinyin string
	star         bool
}

// readVocabularyIndex returns a book's index entries by lesson. Only the alphabetical tables count: the
// part-of-speech key, the proper nouns and the "Quick lookup" summary are skipped. The lesson column is the
// third (HSK: 词语 | 拼音 | 课号) or the fourth of five (YCT: 词语 | 拼音 | meaning | 课号 | 书页).
func readVocabularyIndex(t *testing.T, dir string) map[int][]indexEntry {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(textbookSources, dir, "vocabulary-index.md"))
	if err != nil {
		t.Fatal(err)
	}
	number := regexp.MustCompile(`\d+`)
	byLesson := map[int][]indexEntry{}
	inTable := false
	for _, line := range strings.Split(normalizePrompt(string(raw)), "\n") {
		if strings.HasPrefix(line, "#") {
			skip := strings.Contains(line, "专有名词") || strings.Contains(line, "Quick lookup") || strings.Contains(line, "词性")
			inTable = strings.HasPrefix(line, "##") && !skip
			continue
		}
		if !inTable || !strings.HasPrefix(line, "|") || strings.Contains(line, "---") {
			continue
		}
		cells := splitTableRow(line)
		if len(cells) < 3 || cells[0] == "词语" {
			continue
		}
		lessonCell := cells[2]
		if len(cells) >= 5 {
			lessonCell = cells[3]
		}
		entry := indexEntry{word: strings.TrimLeft(cells[0], "★*"), pinyin: cells[1], star: strings.HasPrefix(cells[0], "★")}
		for _, n := range number.FindAllString(lessonCell, -1) {
			lesson, _ := strconv.Atoi(n)
			byLesson[lesson] = append(byLesson[lesson], entry)
		}
	}
	return byLesson
}

// TestTextbooksMatchVocabularyIndex pins the curated documents to the books: the New words table of each
// lesson holds exactly that lesson's words of the vocabulary index, with the index's pinyin and ★.
func TestTextbooksMatchVocabularyIndex(t *testing.T) {
	if err := TextbooksError(); err != nil {
		t.Fatalf("the embedded textbooks did not load: %v", err)
	}
	for _, book := range books {
		index := readVocabularyIndex(t, book.dir)
		for lesson := 1; lesson <= book.lessons; lesson++ {
			want := index[lesson]
			if span, ok := reviewLessons[book.dir][lesson]; ok {
				want = nil
				for reviewed := span[0]; reviewed <= span[1]; reviewed++ {
					want = append(want, index[reviewed]...)
				}
			}
			rows := newWordsRows(t, book.docs[lesson-1])
			got := map[string][]string{}
			for _, row := range rows {
				got[row[0]] = row
			}
			for _, entry := range want {
				row, ok := got[entry.word]
				switch {
				case !ok:
					t.Errorf("%s lesson %d: %s is in the index but not in the New words", book.dir, lesson, entry.word)
				case row[1] != entry.pinyin:
					t.Errorf("%s lesson %d: %s has pinyin %q, the index says %q", book.dir, lesson, entry.word, row[1], entry.pinyin)
				case strings.Contains(row[5], "★") != entry.star:
					t.Errorf("%s lesson %d: %s has Note %q, the index's ★ is %v", book.dir, lesson, entry.word, row[5], entry.star)
				}
			}
			for word := range got {
				if !slices.ContainsFunc(want, func(e indexEntry) bool { return e.word == word }) {
					t.Errorf("%s lesson %d: %s is in the New words but not in the index for this lesson", book.dir, lesson, word)
				}
			}
		}
	}
}

// newWordsRows returns the cells of every data row of a document's New words table; parseNewWords has
// already checked their shape when the library loaded.
func newWordsRows(t *testing.T, doc string) [][]string {
	t.Helper()
	var rows [][]string
	inSection := false
	for _, line := range strings.Split(doc, "\n") {
		if strings.HasPrefix(line, "## ") {
			inSection = line == "## New words"
			continue
		}
		if inSection && strings.HasPrefix(line, "|") && !strings.Contains(line, "---") {
			if cells := splitTableRow(line); cells[0] != "Word" {
				rows = append(rows, cells)
			}
		}
	}
	return rows
}
