---
name: add-bank-questions
description: Write new questions for QuizTool's question bank (MongoDB collection QuestionBank) for a course, level and lessons, the way the creative AI job fills the bank, and store them. Use whenever the user asks to add, generate, seed, top up or fill questions in the question bank or "the bank", or to prepare questions for HSK, YCT or vocab10 lessons ahead of quizzes, even if they don't say "bank".
---

# Add questions to the question bank

You stand in for the creative model of `bank.Service.Fill`: the server's own code plans the questions, builds the
exact request the model would get, and checks and stores your answer. Your part is to write the questions, as well
as the model would and to the same rules. Background: "The question bank" in `AGENTS.md` and `Server/AGENTS.md`.

All commands run from `Server/` (it reads `Server/.env`), with `go run ./cmd/bank-questions`.

## 1. Settle the inputs

Take what the user gave; ask (AskUserQuestion, one round) only for what is missing:

- **Course** → `--course`: `hsk3` (HSK 3.0, levels 1–3), `hsk2` (HSK 2.0, levels 1–3), `yct` (level 6 only),
  `vocab10` (English "Ôn tập từ vựng lớp 10", no level). Books and lesson counts: `textbookRegistry` in
  `Server/internal/csvgen/textbooks.go`.
- **Level** → `--level` (none for vocab10).
- **Lessons** → `--lessons`, comma-separated (`3` or `3,4`). Several lessons give one request whose sentences may
  use every word up to the highest lesson; a question is then only served to quizzes reaching that lesson. For
  questions on single lessons, run one lesson at a time.
- **Number of questions** → `--count`, at most 80 per request; for more, loop steps 3–5.
- **Image questions** → `--visual N`, how many of them are visual (answered by looking at a picture). Only
  Wayground shows them; GimKit, Blooket and the Game skip them. If the user didn't say, ask with the other missing
  inputs, suggesting about a quarter of `--count` for lessons of concrete, picturable words (things, food, places,
  actions) and 0 for lessons of mostly function words.
- **Database**: default is the local dev bank, `MONGODB_URI` of `Server/.env` (Podman container `quiz-mongo`).
  For another database (e.g. the production Atlas cluster), the user gives the connection string. Pass it as
  `--mongo-uri`, never write it into a file, and don't repeat it in chat (the tool prints it without the password).
  `--database` / `--collection` default to `QuizDb` / `QuestionBank`.

## 2. Reach the database

For the local bank, follow "Local MongoDB (Podman)" in `AGENTS.md`: `podman ps -a --filter name=quiz-mongo`,
`podman machine start` and/or `podman start quiz-mongo` when stopped (a `podman ps` that fails with "Cannot
connect to Podman" means the machine is stopped). Note what was stopped, so you can stop it
again at the end.

Try the default (`localhost`, from `.env`) once with `status`. Podman's port forwarding on this machine often fails
(`localhost` drops the connection, `127.0.0.1` refuses it). Then reach the container on the Podman machine's own address, as `Server/run-server-podman.ps1` does:

```bash
M=$(podman machine inspect --format '{{.Name}}'); IP=$(wsl -d "$M" -- ip -4 -o addr show eth0 | awk '{print $4}' | cut -d/ -f1)
```

and pass `--mongo-uri "mongodb://$IP:27017"` to every command.

## 3. Get the request

```bash
go run ./cmd/bank-questions prompt --course hsk3 --level 1 --lessons 3 --count 20 --visual 5 --out <scratchpad>/bank-prompt.md
```

It prints how many questions the bank holds on each word (easy/medium/hard) and plans `--count` questions for the
least covered words: 40% easy, 40% medium, 20% hard; every fourth easy one a true/false statement (the Game's stage
1), the hard ones mc or word_order; `--visual` of the easy and medium mc ones become visual questions (REQUEST lines
ending "a visual question with an image"). (`status --course … --level … --lessons …`, the same flags without
`--count`/`--visual`/`--out`, prints only the coverage.) If the user named particular words, formats or levels, plan with the tool anyway and adjust the
REQUEST lines you answer, keeping the W ids of the WORD LIST.

Read the whole file with the Read tool (about 500 lines, 40 KB; `cat` gets cut off). Much of the SYSTEM PROMPT is
the shared quiz guidance written for CSV quizzes (CSV templates, IMAGE USAGE, rebuilding a lesson without material):
skim it for its teaching rules. What binds you: QUESTION FORMATS, SKILLS, PINYIN, OUTPUT FORMAT, then the LESSON
MATERIAL, the WORD LIST and the REQUEST, and, when the REQUEST asks for visual questions, IMAGE USAGE too (how a
visual question is phrased and where its picture comes from; its coverage target is not yours to meet).

## 4. Write the answer

Write `<scratchpad>/bank-answer.json` exactly as the system prompt's OUTPUT FORMAT says: one
`{"questions":[ ... ]}` object, one question per line, one question per REQUEST line in its order, `targets` as W
ids from the WORD LIST. Work as the model is told to: build from the lesson material and known vocabulary only,
real Vietnamese, natural Chinese/English, plausible distractors ordered most plausible first, and variety across
the questions.

What the checks (`bank.Validate`) reject, so get it right the first time:

- `format`, `skill` not one of the listed values; `difficulty` not 1–3; a target that is not a W id of the list.
- Empty stem, answer or explanation.
- Chinese: any text with a Chinese character without its pinyin (stem, answer, every mc distractor, every chunk),
  except questions with skill `form`, where all pinyin stays empty. A true_false answer needs none. English
  (vocab10): leave every pinyin field `""` (the tool drops them anyway).
- mc with no distractor (write three); true_false answer other than `Đúng` / `Sai`.
- word_order: 2–8 chunks (the prompt asks 3–6) that, joined, are exactly the answer (spaces aside); distractors
  are wrong orderings of the same chunks, each written as a whole sentence.
- typed answer over 40 characters.
- A `visual` question whose `imageUrl` is not https, is on Wikimedia or Wikipedia (the platforms cannot load
  those), or does not load as an image (the tool fetches every link). Write `visual` only where the REQUEST asks.

Not rejected but matters for where a question can be played: the Game needs options of at most 8 Chinese
characters (or about 6 words) and no bare 1–4 as an option; GimKit and Blooket skip `typed` questions.

### Visual questions

For each REQUEST line that asks for one:

1. **Choose the word.** The planner picks words by coverage, not by whether they can be pictured, so it often asks
   for a visual question on a word like 今天, 号 or 的. Then move the visual question to a picturable word of the
   WORD LIST, using that word's W id in `targets` and keeping the line's position. Prefer, in order: a word with no
   question yet and no other REQUEST line, a concrete noun (thing, food, place) before a verb. Write nothing for the
   unpicturable word on that line: a later `prompt` run gives it a text question. The insert accepts any word of the
   list.
2. **Search Pexels.** Use WebSearch with `allowed_domains: ["pexels.com"]` and a plain English query ("dumplings on
   a plate photo"). Don't write `site:` in the query, since it returns look-alike stock sites. Pick a result whose
   title names the subject plainly. Never invent or guess a URL.
3. **Build the direct link** from the photo page's numeric id (`pexels.com/photo/<slug>-<ID>/`):
   `https://images.pexels.com/photos/<ID>/pexels-photo-<ID>.jpeg?auto=compress&cs=tinysrgb&w=940`. Old, low ids
   often have no such file; then take the next result.
4. **Check the link:** `curl -sIL "<url>" | grep -iE "^HTTP|^content-type" | tail -2` must show `200` and
   `image/...`.
5. **Look at the picture.** Download it (`curl -sL -o <scratchpad>/img-<ID>.jpg "<url with w=400>"`) and view it
   with the Read tool. The tool only checks that the link is an image, not what it shows. The picture must show
   the word unmistakably to a Vietnamese learner (dumplings that look like 饺子, not 包子).
6. **Phrase the question** so the picture carries what is tested and the text leaves it out ("这是什么？" with
   its pinyin, answer 饺子), as IMAGE USAGE describes. A Chinese stem needs its pinyin here too. Every distractor
   must be clearly wrong for that picture: another thing of the same kind (lesson words first, then words of the
   known vocabulary). Never use a word that also fits the picture, such as 菜 (dish) under a photo of dumplings.
7. When no word left can be pictured, or no working image turns up, write a text-only question on the requested
   word instead, with a skill of that level (easy: meaning or form; medium: fill_blank, collocation, discrimination
   or grammar) and `imageUrl` `""`. Say which in your report.

## 5. Check, then store

```bash
go run ./cmd/bank-questions insert --course hsk3 --level 1 --lessons 3 --file <scratchpad>/bank-answer.json --writer "claude-code (<your model id>)" --dry-run
```

It lists every rejected question and why (a visual one whose image does not load names the link and the answer it
got), and how many are already in the bank (same format, stem and answer).
Fix or replace the rejected ones and dry-run again until nothing is rejected. Then run it without `--dry-run`.
For any database other than the local dev one, show the user the dry-run counts and get their go-ahead before
the real insert: the bank is shared by every teacher's quizzes.

The insert stores only new questions, so running it twice is safe. The questions are used by quizzes only where the
server runs with `QUESTION_BANK=on`.

## 6. Report

Run `status` again and tell the user: questions stored (by level and format), rejected or duplicate ones, and the
words still without a question (another `prompt` run goes to those first, as they are now the least covered).
Leave Podman as you found it (`podman stop quiz-mongo`, `podman machine stop` if you
started them). Delete nothing from the bank unless the user asks; there is no command for it, and a stored question
may already be in a quiz.
