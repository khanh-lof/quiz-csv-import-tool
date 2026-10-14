package csvgen

import (
	"fmt"
	"strings"
	"testing"
	"testing/fstest"
)

// useLibrary swaps the package library for the test and puts the embedded one back after it.
func useLibrary(t *testing.T, lib library) {
	t.Helper()
	old := books
	books = lib
	t.Cleanup(func() { books = old })
}

// fixtureDoc is a lesson document in the pinned format. Its New words are 词<dir><NN>a and
// 词<dir><NN>b, plus 共同, which every lesson lists so that the vocabulary of a series has a repeat.
func fixtureDoc(dir string, lesson int) string {
	return fmt.Sprintf(`# 《%[1]s》 Lesson %[2]d — 标题
English: Title · Tiếng Việt: Tiêu đề

## Objectives
- Say something.

## New words
| Word | Pinyin | POS | English | Tiếng Việt | Note |
|---|---|---|---|---|---|
| 词%[1]s%02[2]da | cí | n. | word | từ | |
| 词%[1]s%02[2]db | cí | n. | word | từ | |
| 共同 | gòngtóng | adj. | common | chung | |

## Proper nouns
| Word | Pinyin | English | Tiếng Việt |
|---|---|---|---|
| 安妮 | Ānnī | Annie | Anni |

## Language points
1. 句型 — a pattern. 例：他来了。
`, dir, lesson)
}

// fixtureFS holds a valid document for every lesson of every book of the registry.
func fixtureFS() fstest.MapFS {
	fsys := fstest.MapFS{}
	for _, spec := range textbookRegistry {
		for n := 1; n <= spec.lessons; n++ {
			fsys[spec.dir+"/"+lessonFileName(n)] = &fstest.MapFile{Data: []byte(fixtureDoc(spec.dir, n))}
		}
	}
	return fsys
}

func useFixtureLibrary(t *testing.T) library {
	t.Helper()
	lib, err := loadLibrary(fixtureFS())
	if err != nil {
		t.Fatal(err)
	}
	useLibrary(t, lib)
	return lib
}

func TestLoadLibrary(t *testing.T) {
	lib, err := loadLibrary(fixtureFS())
	if err != nil {
		t.Fatal(err)
	}
	if len(lib) != len(textbookRegistry) {
		t.Fatalf("want %d books, got %d", len(textbookRegistry), len(lib))
	}
	for i, book := range lib {
		if len(book.docs) != book.lessons || len(book.words) != book.lessons {
			t.Errorf("%s: %d docs and %d word lists, want %d", book.dir, len(book.docs), len(book.words), book.lessons)
		}
		if i == 0 {
			if got := strings.Join(book.words[2], ","); got != "词hsk3-103a,词hsk3-103b,共同" {
				t.Errorf("words of hsk3-1 lesson 3 = %q", got)
			}
		}
	}
}

func TestLoadLibraryNormalizesDocuments(t *testing.T) {
	fsys := fixtureFS()
	fsys["hsk3-1/lesson-01.md"] = &fstest.MapFile{Data: []byte("\r\n" + strings.ReplaceAll(fixtureDoc("hsk3-1", 1), "\n", "\r\n") + "\r\n\r\n")}
	lib, err := loadLibrary(fsys)
	if err != nil {
		t.Fatal(err)
	}
	if doc := lib[0].docs[0]; strings.Contains(doc, "\r") || doc != strings.TrimSpace(doc) || !strings.HasPrefix(doc, "# 《hsk3-1》 Lesson 1") {
		t.Errorf("document not normalized: %q", doc)
	}
	if got := strings.Join(lib[0].words[0], ","); got != "词hsk3-101a,词hsk3-101b,共同" {
		t.Errorf("words = %q", got)
	}
}

func TestLoadLibraryErrors(t *testing.T) {
	const table = "| Word | Pinyin | POS | English | Tiếng Việt | Note |\n|---|---|---|---|---|---|\n"
	tests := []struct {
		name   string
		change func(fstest.MapFS)
		want   string
	}{
		{"missing lesson", func(f fstest.MapFS) { delete(f, "hsk3-2/lesson-07.md") }, "textbook hsk3-2 lesson 7"},
		{"missing book", func(f fstest.MapFS) {
			for n := 1; n <= 15; n++ {
				delete(f, "yct-6/"+lessonFileName(n))
			}
		}, "textbook yct-6 lesson 1"},
		{"extra lesson", func(f fstest.MapFS) {
			f["hsk3-3/lesson-19.md"] = &fstest.MapFile{Data: []byte(fixtureDoc("hsk3-3", 19))}
		},
			"textbook hsk3-3: unexpected file lesson-19.md"},
		{"extra lesson past the count of a short book", func(f fstest.MapFS) { f["hsk3-1/lesson-16.md"] = &fstest.MapFile{Data: []byte("x")} },
			"textbook hsk3-1: unexpected file lesson-16.md"},
		{"no New words section", func(f fstest.MapFS) {
			f["hsk3-1/lesson-04.md"] = &fstest.MapFile{Data: []byte("# t\n\n## Texts\n" + table + "| 你 | nǐ | pron. | you | bạn | |\n")}
		}, `textbook hsk3-1 lesson 4: no "## New words" section`},
		{"no rows", func(f fstest.MapFS) {
			f["hsk3-1/lesson-05.md"] = &fstest.MapFile{Data: []byte("# t\n\n## New words\n" + table + "\n## Texts\n| 你 | nǐ | pron. | you | bạn | |\n")}
		}, "textbook hsk3-1 lesson 5: the New words table has no rows"},
		{"a star in the Word cell", func(f fstest.MapFS) {
			f["yct-6/lesson-03.md"] = &fstest.MapFile{Data: []byte("# t\n\n## New words\n" + table + "| 你 | nǐ | pron. | you | bạn | |\n| 爱情片★ | àiqíngpiàn | n. | film | phim | ★ |\n")}
		}, "textbook yct-6 lesson 3"},
		{"an empty Word cell", func(f fstest.MapFS) {
			f["yct-6/lesson-03.md"] = &fstest.MapFile{Data: []byte("# t\n\n## New words\n" + table + "|  | nǐ | pron. | you | bạn | |\n")}
		}, "textbook yct-6 lesson 3"},
		{"a row too narrow", func(f fstest.MapFS) {
			f["hsk3-3/lesson-18.md"] = &fstest.MapFile{Data: []byte("# t\n\n## New words\n" + table + "| 你 | nǐ | pron. | you | bạn |\n")}
		}, "textbook hsk3-3 lesson 18: New words row"},
		{"a row too wide", func(f fstest.MapFS) {
			f["hsk3-3/lesson-18.md"] = &fstest.MapFile{Data: []byte("# t\n\n## New words\n" + table + "| 你 | nǐ | pron. | you | bạn | | x |\n")}
		}, "textbook hsk3-3 lesson 18: New words row"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			fsys := fixtureFS()
			tt.change(fsys)
			lib, err := loadLibrary(fsys)
			if err == nil || !strings.Contains(err.Error(), tt.want) || lib != nil {
				t.Errorf("want an error containing %q and no library, got %v, %v", tt.want, lib, err)
			}
		})
	}
}

func TestParseNewWordsStopsAtTheNextHeading(t *testing.T) {
	doc := "## Objectives\n| a | b | c | d | e | f |\n\n## New words\n\n| Word | Pinyin | POS | English | Tiếng Việt | Note |\n|:---|---|---|---|---|---|\n| 你 | nǐ | | you | bạn | |\n| 好 | hǎo | adj. | good | tốt | ★ |\n\n## Proper nouns\n| Word | Pinyin | English | Tiếng Việt |\n|---|---|---|---|\n| 安妮 | Ānnī | Annie | Anni |\n"
	words, err := parseNewWords(doc)
	if err != nil || strings.Join(words, ",") != "你,好" {
		t.Errorf("got %q, %v", words, err)
	}
}

func TestKnownVocabulary(t *testing.T) {
	useFixtureLibrary(t)
	find := func(dir string) *textbook {
		for _, book := range books {
			if book.dir == dir {
				return book
			}
		}
		t.Fatalf("no book %s", dir)
		return nil
	}
	known := func(dir string, lesson int) string {
		t.Helper()
		msg := lessonMaterial(find(dir), lesson)
		_, line, ok := strings.Cut(msg, "\n\n"+find(dir).docs[lesson-1]+"\n\n")
		if !ok {
			t.Fatalf("%s lesson %d: material is not header, document, vocabulary:\n%s", dir, lesson, msg)
		}
		return line
	}

	// The first lesson of the first book of a series knows nothing.
	if got := known("hsk3-1", 1); got != "The learner knows no earlier words of this course." {
		t.Errorf("hsk3-1 lesson 1: %q", got)
	}
	// Earlier lessons of the book, in order, each word once.
	want := "Known vocabulary (words of the earlier lessons of this book, which the learner already knows; use them freely in sentences and distractors): " +
		"词hsk3-101a、词hsk3-101b、共同、词hsk3-102a、词hsk3-102b"
	if got := known("hsk3-1", 3); got != want {
		t.Errorf("hsk3-1 lesson 3:\n got %q\nwant %q", got, want)
	}
	// The lower levels of the series come first, all their lessons, and the repeated word stays once.
	got := known("hsk3-3", 2)
	if !strings.HasPrefix(got, "Known vocabulary (words of the earlier lessons of this book and of the lower levels of the series, which the learner already knows; use them freely in sentences and distractors): 词hsk3-101a、") {
		t.Errorf("hsk3-3 lesson 2: %q", got)
	}
	list := strings.Split(got[strings.Index(got, "): ")+3:], "、")
	// Two words of each lesson of the two lower books and of lesson 1, and 共同 once.
	if want := 2*(15+15+1) + 1; len(list) != want {
		t.Errorf("hsk3-3 lesson 2: %d known words, want %d", len(list), want)
	}
	seen := map[string]bool{}
	for _, word := range list {
		if seen[word] {
			t.Errorf("hsk3-3 lesson 2: %s is listed twice", word)
		}
		seen[word] = true
	}
	if list[0] != "词hsk3-101a" || list[len(list)-1] != "词hsk3-301b" {
		t.Errorf("hsk3-3 lesson 2: lower levels must come before the book's own lessons: %q ... %q", list[0], list[len(list)-1])
	}
	if !seen["共同"] || seen["词hsk3-302a"] {
		t.Errorf("hsk3-3 lesson 2: the current lesson's words are not known yet, 共同 is")
	}
	// The second book's first lesson knows only the lower level.
	if got := known("hsk3-2", 1); !strings.HasPrefix(got, "Known vocabulary (words of the lower levels of the series, which") || strings.Contains(got, "hsk3-2") {
		t.Errorf("hsk3-2 lesson 1: %q", got)
	}
	// A book that stands alone knows its own earlier lessons, and the YCT sentence closes the message.
	if got := known("yct-6", 1); got != "The learner knows no earlier words of this course.\nThe learner also knows the words of YCT levels 1 to 5." {
		t.Errorf("yct-6 lesson 1: %q", got)
	}
	if got := known("yct-6", 2); !strings.HasPrefix(got, "Known vocabulary (words of the earlier lessons of this book, which") ||
		strings.Contains(got, "hsk3") || !strings.HasSuffix(got, "\nThe learner also knows the words of YCT levels 1 to 5.") {
		t.Errorf("yct-6 lesson 2: %q", got)
	}
}

func TestLessonMaterial(t *testing.T) {
	useFixtureLibrary(t)
	book := textbookFor(Options{CourseType: Hsk, HskStandard: Hsk3, Level: intPtr(2)})
	msg := lessonMaterial(book, 7)
	if !strings.HasPrefix(msg, "LESSON MATERIAL: 《新HSK教程2》 (New HSK Course 2), lesson 7 of 15, taken from the textbook itself.\n\n# 《hsk3-2》 Lesson 7") {
		t.Errorf("unexpected start: %q", msg)
	}
	if !strings.Contains(msg, "\n\n## New words\n| Word") && !strings.Contains(msg, "## New words\n| Word") {
		t.Errorf("document missing: %q", msg)
	}
	if lessonMaterial(book, 0) != "" || lessonMaterial(book, 16) != "" {
		t.Error("a lesson the book does not have has no material")
	}
}

func intPtr(n int) *int { return &n }

func TestTextbookFor(t *testing.T) {
	useFixtureLibrary(t)
	tests := []struct {
		name string
		opts Options
		want string // the book's dir, empty for none
	}{
		{"HSK 3.0 level 1", Options{CourseType: Hsk, HskStandard: Hsk3, Level: intPtr(1)}, "hsk3-1"},
		{"HSK 3.0 level 2", Options{CourseType: Hsk, HskStandard: Hsk3, Level: intPtr(2)}, "hsk3-2"},
		{"HSK 3.0 level 3", Options{CourseType: Hsk, HskStandard: Hsk3, Level: intPtr(3)}, "hsk3-3"},
		{"YCT level 6", Options{CourseType: Yct, Level: intPtr(6)}, "yct-6"},
		{"HSK 2.0 level 2", Options{CourseType: Hsk, HskStandard: Hsk2, Level: intPtr(2)}, ""},
		{"HSK with no standard", Options{CourseType: Hsk, Level: intPtr(2)}, ""},
		{"HSK 3.0 level 4", Options{CourseType: Hsk, HskStandard: Hsk3, Level: intPtr(4)}, ""},
		{"YCT level 5", Options{CourseType: Yct, Level: intPtr(5)}, ""},
		{"no level", Options{CourseType: Hsk, HskStandard: Hsk3}, ""},
		{"Other with a matching level", Options{CourseType: Other, CourseName: "Boya", Level: intPtr(2)}, ""},
		{"Other", Options{CourseType: Other, CourseName: "Boya"}, ""},
	}
	for _, tt := range tests {
		got := textbookFor(tt.opts)
		if tt.want == "" && got != nil || tt.want != "" && (got == nil || got.dir != tt.want) {
			t.Errorf("%s: got %v, want %q", tt.name, got, tt.want)
		}
	}
}

func TestTextbookForWithoutALibrary(t *testing.T) {
	useLibrary(t, nil) // what a failed load leaves
	opts := Options{CourseType: Yct, Level: intPtr(6)}
	if textbookFor(opts) != nil || !strings.HasPrefix(opts.CourseDisplayName(), "YCT (Youth Chinese Test)") {
		t.Error("without a loaded library nothing matches")
	}
}

// The embedded documents themselves: they are written apart from the code, so this is what notices a
// folder that is incomplete or does not follow Textbooks/LESSON_DOC_FORMAT.md.
func TestEmbeddedTextbooks(t *testing.T) {
	if err := TextbooksError(); err != nil {
		t.Fatal(err)
	}
	want := map[string]int{"hsk3-1": 15, "hsk3-2": 15, "hsk3-3": 18, "yct-6": 15}
	if len(books) != len(want) {
		t.Fatalf("want %d books, got %d", len(want), len(books))
	}
	for _, book := range books {
		if len(book.docs) != want[book.dir] || len(book.words) != want[book.dir] {
			t.Errorf("%s: %d lessons, want %d", book.dir, len(book.docs), want[book.dir])
		}
	}
}
