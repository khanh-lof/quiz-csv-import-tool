# Lesson document format

One file per lesson, `Server/internal/csvgen/textbooks/<book>/lesson-NN.md` (two-digit `NN`), embedded in
the server and sent to the AI as the **LESSON MATERIAL** of a quiz request for that lesson. The model is
told to build the quiz from this document only, so it must be complete, exact and free of OCR noise.
It is input for a model, not a page for people: plain markdown, no images, no decoration.

## Template

```markdown
# 《新HSK教程2》 Lesson 7 — 他篮球打得很好
English: He plays basketball very well · Tiếng Việt: Anh ấy chơi bóng rổ rất giỏi

## Objectives
- Understand and describe an action in progress.
- Use the contracted complex sentence "……就……" for one action following another.
- Talk about the sports you often do.

## New words
| Word | Pinyin | POS | English | Tiếng Việt | Note |
|---|---|---|---|---|---|
| 从 | cóng | prep. | from | từ | |
| 往 | wǎng | prep./v. | towards; go | về phía; đi | |
| 爱情片 | àiqíngpiàn | n. | romance film | phim tình cảm | ★ |

## Proper nouns
| Word | Pinyin | English | Tiếng Việt |
|---|---|---|---|
| 陈天中 | Chén Tiānzhōng | Chen Tianzhong (a name) | Trần Thiên Trung (tên người) |

## Language points
1. 紧缩复句"……就……" — two actions in quick succession / hai hành động nối tiếp nhau ngay. 例：他一下课就往外跑。

## Texts
### Text 1 — 在教室，安妮和陈天中在聊天儿。
陈天中：安妮，你是什么时候从北京回来的？
安妮：昨天下午。天中，你怎么一下课就往外跑？
```

## Rules

**Sources.** Use only the level's own material. Never use deck files, `content_lessonNN.py`, or your
memory of the textbook.
- `Textbooks/<book>/vocabulary-index.md` is typed from the book's word list and is authoritative for
  three things: which words belong to the lesson, their pinyin, and ★.
- `Textbooks/<book>/lesson-index.md` gives the lesson map (PDF page ranges) and the language points
  (YCT: the Key Sentences).
- The rendered pages (JPEG per PDF page) are the scan itself. Read them for the 生词 boxes (POS,
  English), the objectives, the texts and the language-point examples.
- The OCR in `Textbooks/<book>/ocr/` only helps locate text. It is noisy, and its pinyin is wrong.

**Title line.** `# <book title> Lesson N — <Chinese title>`, then one line with the English title and a
Vietnamese translation.

**New words.** This table is machine-read.
- The heading is exactly `## New words`.
- The column header is exactly the six columns above. It is followed by one row per word, and the table
  ends at the next `## ` heading.
- The rows are exactly this lesson's entries in `vocabulary-index.md`:
  - HSK: 课号 contains N.
  - YCT: 课号 is `LN`.
  
  A word listed for two lessons appears in both docs. Order the rows as the book's 生词 boxes present
  them (Text 1's box first). Words not in a box go at the end.
- **Word:** the characters only, never `★`, `*`, numbers or pinyin. For a homograph, keep the word as
  written and let the pinyin and POS tell the two apart.
- **Pinyin:** copied exactly from `vocabulary-index.md`, with tone marks.
- **POS:** from the 生词 box (`n.`, `v.`, `adj.`, …). Leave it empty when the book gives none (YCT).
- **English:** from the 生词 box, in the sense the lesson uses.
- **Tiếng Việt:**
  - YCT: from `vocabulary-index.md`'s meaning column.
  - HSK: write a short, natural Vietnamese gloss for the sense the lesson uses. Use 1–4 words, separate
    senses with `;`, and keep it at the learner's level.
- **Note:** `★` when the index marks the word ★ (beyond the level's syllabus), otherwise empty.
- Every cell is on one line. A literal `|` never appears in a cell.

**Proper nouns.** Use the 专有名词 entries for the lesson (people, places, brands) from the index or the
boxes. Leave the section out when the lesson has none.

**Language points.** Include each point listed for the lesson in `lesson-index.md`:
- its Chinese name;
- a one-line explanation in English and in Vietnamese;
- one or two example sentences taken from the book's 小语讲堂 / explanation box.

For YCT, the two Key Sentences are the language points.

**Texts.** Include every 课文 of the lesson, in order:
- a `### Text K — <scene line>` heading;
- then the lines as `Speaker：sentence`, or plain sentences for a narrative.

Chinese characters only: no pinyin lines and no English translation. Leave out the listening questions,
the exercises and the answer options. Repair OCR errors by reading the page image. If a line is truly
unreadable, leave it out. Never invent one.

For YCT, the texts are the lesson's story / dialogue panels and the "Let's learn" phrases. Include the
"Let's learn" collocations, e.g. `安静极了`, as a `### Phrases` list.

**Review lessons.** YCT6 Lesson 15 is a 复习 lesson, so its doc does two things:
- it says so on the line after the title;
- it carries the review pages' content as Texts.

Its New words table holds every word of lessons 1–14, with each row copied from those lessons' docs.

**Size.** A doc is usually 3–10 KB. Do not pad it.
