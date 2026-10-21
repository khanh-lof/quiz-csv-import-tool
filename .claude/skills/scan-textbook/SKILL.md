---
name: scan-textbook
description: Scan a textbook PDF (HSK, YCT, ...) into QuizTool's per-lesson documents and register the book. Use when the user gives a book PDF and asks to scan it, write its lesson docs, or add a textbook.
---

# Scan a textbook

Turns a book PDF into `Server/internal/csvgen/textbooks/<book>/lesson-NN.md`, plus the source indexes in
`Textbooks/<book>/`, and registers the book. Read `Textbooks/README.md` ("Adding a book") and
`Textbooks/LESSON_DOC_FORMAT.md` first; they are binding. `<book>` is `<course><standard>-<level>`, e.g. `hsk2-1`.

## 1. Extract text, markitdown first

- Run `python -m markitdown "<book>.pdf" -o <scratchpad>/book.md` (the `markitdown` command is not on PATH).
  Do the same for any `PPT_Old` deck the user names, but decks are not a source for lesson docs (the format
  forbids them); say so if a deck belongs to a different book.
- If the output is only a watermark or blank (image-only PDF), fall back to OCR:
  `mkdir -p Textbooks/<book>/{book,ocr,pages}`, copy the PDF to `book/`, then run in the background
  `python -I .claude/skills/scan-textbook/ocr_pages.py "book/<file>.pdf" pages ocr` from `Textbooks/<book>/`
  (`pip install rapidocr-onnxruntime` if missing). Ensure `.gitignore` has `Textbooks/*/book/`, `ocr/`, `pages/`.
- The page JPEGs are the real source; OCR only locates text and its pinyin is wrong.

## 2. Map the book

View the contents page images. Find the PDF page offset (book page + N) by grepping OCR for lesson titles.
Note per lesson: PDF page range, 生词 boxes, 注释/language points, texts, and what the book lacks (e.g. no
Objectives). Find the printed word list (词语总表).

## 3. Write the indexes (Textbooks/<book>/)

- `lesson-index.md`: lesson map with page ranges, language points per lesson, book facts, ★ words. Model on
  `Textbooks/hsk3-1/lesson-index.md`.
- `vocabulary-index.md`: delegate to one Sonnet subagent that reads the word-list page images. Columns must be
  exactly `| 词语 | 拼音 | 课号 |` (the Go test reads the third), `★` before beyond-syllabus words, a
  `## 专有名词` section, a `## Quick lookup` section. Extra tables whose heading is not 专有名词/Quick lookup/词性
  are parsed as lesson vocabulary, so only put real lesson words there.

## 4. Write the lesson docs

After the index exists, launch parallel Sonnet subagents (never Opus), about three lessons each, with the
Workflow or Agent tool. Each brief names: the format doc, one finished example doc, both indexes, its PDF page
range, the output paths, the book's differences from the format (missing sections, speaker labels), and the
rule that New words must equal the index rows for that lesson (Word, pinyin and ★ exact; POS/English from the
boxes; Vietnamese glossed by the agent, 1–4 words). Texts are Chinese only; leave out exercises, pronunciation
drills and culture pages.

## 5. Register and verify

- Server `textbookRegistry` in `Server/internal/csvgen/textbooks.go` (insert so `hsk3-1` stays first; the tests
  assume it) and client `TEXTBOOKS` in `Client/src/models/textbook.ts`, same lesson count; add the book to the
  `want` map in `TestEmbeddedTextbooks`, a case in `Client/src/models/textbook.spec.ts`, and the book tables in
  the root `AGENTS.md`, `Server/AGENTS.md` and `Textbooks/README.md`.
- `go test ./...` in `Server/`: it fails on a missing or malformed lesson and on any mismatch with the index.
  Fix by editing the doc, or the index if the scan was misread.
- Spot-check two or three docs against the page images. Don't commit unless asked.

Report: counts, deviations from the format, doubtful glosses, and anything not verified.
