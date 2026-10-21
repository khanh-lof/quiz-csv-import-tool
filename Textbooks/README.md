# Textbooks

The textbook material behind Auto-mode AI generation. For a course that has a book here, the server
sends the AI the requested lesson's own words, language points and texts. The model then builds the quiz
from them instead of from its memory of the course (see the root `AGENTS.md`, "The two AI generation
modes").

This folder is the **source**. The server never reads it. What the server embeds and sends is the curated
lesson documents in `Server/internal/csvgen/textbooks/<book>/lesson-NN.md`, written from this material
by hand (by an AI curator reading the scan) to the format in [LESSON_DOC_FORMAT.md](LESSON_DOC_FORMAT.md).

| Folder | Book | QuizTool course | Lessons | PDF page = book page + |
|---|---|---|---|---|
| `hsk2-1` | 《HSK标准教程1》 HSK Standard Course 1 | HSK 2.0, level 1 | 15 | 13 |
| `hsk2-2` | 《HSK标准教程2》 HSK Standard Course 2 | HSK 2.0, level 2 | 15 | 16 (18 from lesson 11) |
| `hsk2-3` | 《HSK标准教程3》 HSK Standard Course 3 | HSK 2.0, level 3 | 20 | 0 up to lesson 11's first page, 1 from lesson 12 |
| `hsk3-1` | 《新HSK教程1》 New HSK Course 1 | HSK 3.0, level 1 | 15 | 14 |
| `hsk3-2` | 《新HSK教程2》 New HSK Course 2 | HSK 3.0, level 2 | 15 | 16 |
| `hsk3-3` | 《新HSK教程3》 New HSK Course 3 | HSK 3.0, level 3 | 18 | 12 |
| `yct-6` | 《YCT标准教程6》 YCT Standard Course 6 | YCT, level 6 | 15 | 5 |

## What each book folder holds

- **`vocabulary-index.md`** (committed) is typed by eye from the book's printed 词语表. It is the
  authority on which lesson a word belongs to (课号), on its pinyin, and on ★ (超纲词, beyond the level's
  syllabus). If its "Quick lookup" table disagrees with the alphabetical tables, the alphabetical tables
  win.
- **`lesson-index.md`** (committed) is typed from the printed 目录. It has the lesson map with page
  ranges and the language points per lesson (for YCT, the Key Sentences).
- **`book/*.pdf`** (gitignored) is the scan. It is image-only, has no text layer, and is too large for git.
- **`ocr/`** (gitignored) is the raw OCR, one file per lesson plus the full book. It is noisy and its
  pinyin is wrong, so use it only to locate text.

All of it was copied from the CN_PPT project (`<level>/book/` and `<level>/reference/`), which scanned
and transcribed the books.

## Known scan defects

- **HSK 3:** the word-list page for J–M (PDF page 190) is skewed in the scan. Its lesson numbers were
  reconstructed by hand and corrected against the lessons' 生词 boxes where checked.
- **YCT 6:** the scan stops at book p.130. The test listening scripts (pp.131–134), the test answers
  (pp.135–137) and the award page (p.138) are missing. Lesson 15 is a 复习 review of lessons 1–14.
- **YCT 6:** the word list prints the book page where a word is introduced, not the lesson.
  `vocabulary-index.md` gives both, so read 课号, not 书页.

## Adding a book

1. **Copy the material.** Make a folder named `<course><standard?>-<level>` with the two indexes, `book/`
   and `ocr/`. If the book has no typed indexes yet, type the word list and the contents page from the
   scan first. Never trust OCR for pinyin.
2. **Write the lesson docs.** Put one doc per lesson in `Server/internal/csvgen/textbooks/<folder>/`,
   following [LESSON_DOC_FORMAT.md](LESSON_DOC_FORMAT.md). Read the scan's pages, not just the OCR.
3. **Register the book on both sides, in step.** This means the registry in
   `Server/internal/csvgen/textbooks.go` (folder, course, standard, level, lesson count, name) and
   `TEXTBOOKS` in `Client/src/models/textbook.ts`.
4. **Run `go test ./...` in `Server/`.** It loads every registered book and fails on a missing lesson or
   a malformed New-words table. Also check that each doc's New-words table is exactly that lesson's rows
   of `vocabulary-index.md`, with the same pinyin.
