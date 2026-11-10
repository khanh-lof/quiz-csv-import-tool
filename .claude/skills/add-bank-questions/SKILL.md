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
- **Database**: default is the local dev bank, `MONGODB_URI` of `Server/.env` (Podman container `quiz-mongo`).
  For another database (e.g. the production Atlas cluster), the user gives the connection string. Pass it as
  `--mongo-uri`, never write it into a file, and don't repeat it in chat (the tool prints it without the password).
  `--database` / `--collection` default to `QuizDb` / `QuestionBank`.

## 2. Reach the database

For the local bank, follow "Local MongoDB (Podman)" in `AGENTS.md`: `podman ps -a --filter name=quiz-mongo`,
`podman machine start` and/or `podman start quiz-mongo` when stopped (a `podman ps` that fails with "Cannot
connect to Podman" means the machine is stopped). Note what was stopped, so you can stop it
again at the end.

Podman's port forwarding on this machine often fails (`localhost` drops the connection, `127.0.0.1` refuses it).
Then reach the container on the Podman machine's own address, as `Server/run-server-podman.ps1` does:

```bash
M=$(podman machine inspect --format '{{.Name}}'); IP=$(wsl -d "$M" -- ip -4 -o addr show eth0 | awk '{print $4}' | cut -d/ -f1)
```

and pass `--mongo-uri "mongodb://$IP:27017"` to every command.

## 3. Get the request

```bash
go run ./cmd/bank-questions prompt --course hsk3 --level 1 --lessons 3 --count 20 --out <scratchpad>/bank-prompt.md
```

It prints how many questions the bank holds on each word (easy/medium/hard) and plans `--count` questions for the
least covered words: 40% easy, 40% medium, 20% hard; every fourth easy one a true/false statement (the Game's stage
1), the hard ones mc or word_order. (`status` instead of `prompt`, without `--count`/`--out`, prints only the
coverage.) If the user named particular words, formats or levels, plan with the tool anyway and adjust the
REQUEST lines you answer, keeping the W ids of the WORD LIST.

Read the whole file with the Read tool (about 500 lines, 40 KB; `cat` gets cut off). Much of the SYSTEM PROMPT is
the shared quiz guidance written for CSV quizzes (CSV templates, IMAGE USAGE, rebuilding a lesson without material):
skim it for its teaching rules. What binds you: QUESTION FORMATS, SKILLS, PINYIN, OUTPUT FORMAT, then the LESSON
MATERIAL, the WORD LIST and the REQUEST.

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
- typed answer over 40 characters; a `visual` question without an https image link (the planner never asks for
  visual, so don't write any).

Not rejected but matters for where a question can be played: the Game needs options of at most 8 Chinese
characters (or about 6 words) and no bare 1–4 as an option; GimKit and Blooket skip `typed` questions.

## 5. Check, then store

```bash
go run ./cmd/bank-questions insert --course hsk3 --level 1 --lessons 3 --file <scratchpad>/bank-answer.json --writer "claude-code (<your model id>)" --dry-run
```

It lists every rejected question and why, and how many are already in the bank (same format, stem and answer).
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
