# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

QuizTool turns photos of a Chinese (HSK) lesson into a quiz file that can be imported into GimKit,
Blooket, or Wayground, or into a quiz that QuizTool plays itself as a webcam gesture game
("Game"). A teacher can also hand a Game to students as a link ("Giao bài"): they play it
with no account and the teacher watches their leaderboard. It is one git repo holding two independently built
and independently deployed projects, plus an optional browser extension:

- `Client/` — Angular 22 SPA (standalone components, ng-zorro-antd).
- `Server/` — Go (`net/http`) API with MongoDB persistence. Runs as a standalone binary / Docker
  image (`Server/Dockerfile`).
- `Extension/` — Chrome extension (plain JS, loaded unpacked, not deployed) that imports and
  publishes the Wayground `.xlsx` in the user's own Wayground tab. See [Extension/AGENTS.md](Extension/AGENTS.md).

Both deploy together as one Vercel project via [Vercel Services](https://vercel.com/docs/services),
configured in the root `vercel.json`: the `client` service (Angular preset, SPA fallback to
`index.html`) and the `server` service (Go preset, which runs `Server/cmd/server` listening on
`PORT`). Top-level rewrites send `/api/*` and `/healthz` to `server` — with the path unchanged, so
the Go mux still sees `/api/...` — and everything else to `client`. The Vercel project's Root
Directory must be the repo root, and the server's env vars (`MONGODB_URI`, `JWT_SECRET`, …) are set
in the same project.

Each project has its own `AGENTS.md` with the detail for that side — read
[Client/AGENTS.md](Client/AGENTS.md), [Server/AGENTS.md](Server/AGENTS.md) or
[Extension/AGENTS.md](Extension/AGENTS.md) before working inside that directory. This file covers only
what spans them.

There is no root-level build, no workspace/solution tying the two halves together, and no shared code or
generated client — the contract between them is hand-written on both sides and must be kept in sync
manually.

## Commands

Client (run from `Client/`):
```bash
npm start        # ng serve → http://localhost:4200
npm test         # Karma + Jasmine (specs: services, models, and the gesture quiz's engine, games and page)
npm run build    # ng build (production)
```

Server (run from `Server/`):
```bash
go test ./...
go run ./cmd/server   # http://localhost:7071; needs MongoDB and a .env (see Server/.env.example)
```

Running the full app locally means starting both: the SPA on 4200 and the API on 7071. `ng serve`
proxies `/api` to 7071 (`Client/proxy.conf.json`), so the browser only ever talks to 4200.

## The client/server contract

All server routes are under `/api`. The client calls them by relative URL (`/api/...`) — there is
no configurable backend URL:

| Client caller | Server endpoint |
|---|---|
| `AuthService.login` / `.refreshToken` | `auth/login`, `auth/refresh` (`internal/api/auth_handlers.go`, anonymous) |
| `AuthService.logout` | `auth/logout` (`auth_handlers.go`) |
| — (no client caller) | `auth/logout-all` (`auth_handlers.go`) |
| — (admin only, `X-Admin-Key` header) | `users` (`auth_handlers.go`) |
| `AiCsvService.submitFormatted` / `.submitCreative` | `POST csv/jobs` (`internal/api/csv_handler.go`) |
| `AiJobService.refresh` / `.remove` | `GET csv/jobs`, `DELETE csv/jobs/{id}` (`csv_handler.go`) |
| `AssignmentService.create` | `POST assignments` (`internal/api/assignment_handlers.go`) |
| `AssignmentService.list` / `.get` | `GET assignments`, `GET assignments/{id}` (`assignment_handlers.go`) |
| `AssignmentService.update` | `PATCH assignments/{id}` (`assignment_handlers.go`) |
| `AssignmentService.remove` / `.removePlayer` | `DELETE assignments/{id}`, `DELETE assignments/{id}/players/{playerId}` (`assignment_handlers.go`) |
| `SharedPlayService.load` / `.join` | `GET share/{code}`, `POST share/{code}/players` (`internal/api/share_handlers.go`, anonymous) |
| `SharedPlayService.submit` / `.flush` | `POST share/{code}/results` (`share_handlers.go`, anonymous, `X-Player-Token` header) |
| `SharedPlayService.setAvatar` | `PATCH share/{code}/player` (`share_handlers.go`, anonymous, `X-Player-Token` header) |
| `SharedPlayService.leaderboard` | `GET share/{code}/leaderboard` (`share_handlers.go`, anonymous, optional `X-Player-Token` header) |

Three things make the wiring non-obvious:

- **Same-origin everywhere, no CORS.** On Vercel the SPA and API are services of one deployment
  (every preview included); locally the `ng serve` proxy puts them on one origin too. The server
  therefore has no CORS handling, and the refresh token is an `HttpOnly; Secure; SameSite=Strict`
  cookie (`Secure` is accepted on `http://localhost`). Serving the SPA and API from different
  origins is not supported: the browser would block the calls and never send the cookie, breaking
  the silent-refresh-on-boot flow in `app.config.ts`.
- **Auth is split across two mechanisms.** The access token is a Bearer JWT the client attaches via
  `AuthInterceptor`; only the `csv/jobs` and `assignments` routes require it (the latter being the teacher's
  half of [Giao bài](#giao-bài-assignments)), via the `authenticate` + `requireRole` middleware wrapped
  around that route (`Server/internal/api/middleware.go`).
  The refresh token lives only in the cookie and is never in a JSON body.
- **The student routes are anonymous and never answer 401.** `share/{code}` and its four sub-routes are
  registered bare, with no `authenticate`: the link's code and the student's own token are their only
  credentials. A 401 would be wrong for a student, because `AuthInterceptor` answers every 401 by calling
  `auth/refresh` and retrying, and a student has no session to refresh. So a refusal there is always a 400,
  403, 404, 409 or 410, even when the request carries a bad or expired `Authorization` header
  (`TestStudentRoutesNeverAnswer401` pins it). Keep it that way for any route added under `share/`.

## The two AI generation modes

This is the one feature that only makes sense by reading both sides. The AI generation page
(`AiGeneration`, route `/ai`) offers `AIGenerationMode.Formatted` and `AIGenerationMode.Auto`, and they take
completely different paths through the system. First, what they share — **AI generation is a job**: `POST csv/jobs`
validates the request, stores a job in MongoDB (`store.Job`, collection `Jobs`, newest 30 kept per user),
answers `202 {"id"}` and keeps working in the same handler, detached from the client's connection, until
the model has answered and the result is saved on the job. The client does not wait for the result: the
`AiGeneration` page shows a "Đã gửi yêu cầu" notice, and the history table on its own page, "AI › Lịch sử" in the side menu (`/ai-history`, `AiJobs`), shows
the user's jobs from `GET csv/jobs`, which `AiJobService` polls every 3 s while any job runs. A job
finishing is announced wherever the user is in the app. The result is delivered from the table, not on
completion: **Formatted** jobs get a "Mở trong bảng" action, **Auto** jobs a "Tải file" action
and, for a Wayground job, also "Tiện ích tự publish" (the extension; disabled when it is not installed)
or, for a Game job, "Chơi ngay" (played in the app, see
[the gesture quiz](#the-gesture-quiz-game)): the user picks the delivery per job once the AI is done. The table's search covers titles, errors and the generated
CSV; its filters are status, mode, platform, course type, HSK standard, level and lesson number (the server
keeps those on each creative job; jobs from before it did have none and drop out when one is set).

- **`Formatted`** → `POST csv/jobs` (only a `title` query param) → server's simple prompt
  (`Server/internal/csvgen/prompts/simple_system.txt`, two columns, `Câu hỏi`/`Đáp án`) → client parses the CSV
  with `CsvImportService.parseCsv` and **hands the rows to the vocabulary table** (`PendingImportService`,
  then navigates to `/quiz`) when the user clicks "Mở trong bảng" on the job, where the user edits
  them and later exports via `FileExportService.exportFile` (client-side builders synthesize the
  distractors).
- **`Auto`** (sent as `isCreative=true`, alongside `exportType`, `courseType`, `lessonNumber`, and
  `level`/`courseName` depending on the course, and for Game `gestureStages`/`questionsPerStage`, see
  [the gesture quiz](#the-gesture-quiz-game)) → server's creative prompt
  (`csvgen.buildCreativeRequest`, `prompts/creative_system.txt`), a long Chinese-teacher prompt that is told the exact
  column layout of the *target platform* via `exportTypeMessages` and asked to
  return **rows without a header** → client never touches the table: on "Tải file" it prepends the header through
  `CsvBuilderBase.buildFromCsvContent` and downloads (for the Game platform the job can instead be
  played in the app, its third delivery). **Images are optional in this
  mode.** The lesson is identified by `CourseType` (`Hsk`/`Yct`/`Other`, another
  by-ordinal enum duplicated on both sides), a `level` that is required for HSK and YCT but optional
  for `Other`, a `courseName` required only for `Other`, and a `lessonNumber`. For HSK the user
  also picks the standard, `HskStandard` 2.0 (levels 1–6, the server's default) or 3.0 (levels 1–9; the form's
  default), sent as `hskStandard=2|3` by value, not ordinal; the server rejects a level outside the standard's range.
  Everything the prompt needs travels in `csvgen.Options` (`Server/internal/csvgen/options.go`). Where the lesson's
  words come from depends on the course:
  - **A course with a textbook** (see [Textbook lessons](#textbook-lessons)): the server sends the lesson's own
    material, and the model builds the quiz from it alone. Photos, if any, only say which part to focus on.
  - **Any other course:** the photos when there are some. With none, the model rebuilds the lesson from its own
    knowledge of the textbook (the prompt's LESSON SOURCE, Steps 1–3).
  - **The web search tool** (Wayground only) is for finding illustrations and is never used to look up the lesson.

Consequences to keep in mind when changing anything here:

- The `ExportType` enum exists twice (`Client/src/models/export-type.ts` and
  `Server/internal/csvgen/options.go`) and is passed over the wire **by ordinal**: `GimKit`, `Blooket`,
  `Wayground`, `GestureQuiz` (0–3). Adding or reordering a member on one side silently mis-maps the other.
- Adding a new export platform means three coordinated changes: a client `CsvBuilder` (with a
  `CsvHeader` matching what the platform expects on import), an `exportTypeMessages` case
  on the server describing the same columns to the LLM, and the enum entry on both sides. `GestureQuiz`
  bends the first one: its builder only prepends the header (the "columns" are the ones the game's own
  parser reads), and it throws if the vocabulary table ever asks it to build rows.
- A job outlives the connection that started it only if the host keeps the process alive after the
  client leaves. The handler flushes its `202` early with `Connection: close` and goes on working;
  where the platform buffers the response until the handler ends (Vercel's behaviour for a Go
  service is unverified), the client just gets the `202` late and polling still shows the job. A job
  still `running` well past the LLM deadline (its process died) is failed as "interrupted" and its
  call refunded the next time its owner lists jobs.
- Export output format is per-platform: GimKit, Blooket and Game download as `.csv`, Wayground is
  converted to `.xlsx` via `xlsx` before download (`FileExportService.download`).

## Textbook lessons

For four books QuizTool holds the lessons themselves:

| Book | Course | Lessons |
|---|---|---|
| 《新HSK教程1》 | HSK 3.0 level 1 | 15 |
| 《新HSK教程2》 | HSK 3.0 level 2 | 15 |
| 《新HSK教程3》 | HSK 3.0 level 3 | 18 |
| 《YCT标准教程6》 | YCT level 6 | 15 |

- **What gets sent.** One curated markdown document per lesson is embedded in the server
  (`Server/internal/csvgen/textbooks/<book>/lesson-NN.md`) and sent with a request for that lesson as its
  LESSON MATERIAL. The document holds the lesson's new words (pinyin, part of speech, English, Vietnamese, ★ for
  words beyond the syllabus), its language points and its texts. The words of the earlier lessons and of the
  lower books are sent with it as the vocabulary the learner already knows.
- **Where it comes from.** The documents were written from the scanned books and their typed word lists, which
  live in `Textbooks/` together with the format (`Textbooks/LESSON_DOC_FORMAT.md`) and how to add a book
  (`Textbooks/README.md`). The PDFs and raw OCR there are gitignored.
- **The registry is hand-kept twice.** The server's `textbookRegistry` (`Server/internal/csvgen/textbooks.go`)
  and the client's `TEXTBOOKS` (`Client/src/models/textbook.ts`) must name the same books with the same lesson
  counts.
- **What each side does with it.**
  - The server refuses a lesson beyond the book: 400 `Lesson must be 1 to <M> for <title>.`
  - The client caps the lesson field the same way, and tells the user under it whether the course has a book.
- **The tests pin the documents.** `go test` fails when a registered lesson is missing or malformed. It also
  fails when a lesson's New words disagree with that book's `vocabulary-index.md`: a missing or extra word, its
  pinyin, or its ★.

## The Wayground browser extension

Wayground has no public API for creating quizzes, so `Extension/` drives Wayground's own spreadsheet
import and Publish in the user's logged-in tab, then hands the quiz's share link back. The SPA side
is `WaygroundExtensionService`:
- On the vocabulary table, when Wayground is the chosen platform, the page offers a `WaygroundDelivery`
  choice: **Tải file** (download the `.xlsx` for a manual import) or **Tiện ích tự publish** (hand it to
  the extension), remembered in `localStorage` (`wayground-delivery`) and defaulting to the extension when
  it is installed. In `Auto` mode there is no such setting: the AI jobs table shows both buttons on a
  finished Wayground job. The extension is unavailable unless `<html data-quiztool-extension>` is present.
- With the extension chosen, `FileExportService` builds the `.xlsx` without downloading it and the
  service `postMessage`s
  `{source: 'quiztool', type: 'wayground-import', requestId, title, fileName, base64}` to the
  extension's content script.
- The extension answers, possibly minutes later, with
  `{source: 'quiztool-extension', type: 'wayground-import-result', requestId, title, ok, shareUrl, error}`.
  The service shows it as its own notification (the share link, also copied to the clipboard) and
  ignores request ids it didn't send. On a failed result it downloads the file it kept for that
  request, so the user can finish the import by hand.

The message shapes and the QuizTool origins the
extension listens on (`Extension/manifest.json`: production `https://kt-quiz-csv-import-tool.vercel.app`
and `http://localhost:4200`; Vercel preview URLs are not included) are hand-kept in step on both
sides. Quizzes are published publicly with fixed settings (`PUBLISH_SETTINGS` in
`Extension/selectors.js`).

## The gesture quiz (Game)

`ExportType.GestureQuiz` (ordinal 3 on both sides) is the one platform that is not an import target:
QuizTool plays the quiz itself, as a game in which the learner answers with body gestures in front of a
webcam. For the pipeline it is an `Auto`-mode platform like the others (same `POST csv/jobs`, rate limit,
job and polling); only the prompt and what the client does with the finished job differ. Camera frames
are processed locally in the browser (MediaPipe), nothing is recorded or sent anywhere.

**The CSV contract.** The model returns headerless rows of exactly 7 fields, `Stage,Question,Correct
Answer,Wrong Answer 1,Wrong Answer 2,Wrong Answer 3,Explanation` (an unused column is an empty field),
grouped by stage. The stage, 1 to 6, fixes the row shape and, because the
prompt tells the model to classify each question by its real difficulty (the creative prompt's stage
rules replace its usual difficulty mixture), the difficulty too. The Explanation is one Vietnamese
sentence shown after the answer. The stages are played easiest to hardest, one game each, and a stage is
passed with at least 70% right by default (`DEFAULT_PASS_PERCENT` / `passMark`: 4 of 5, 7 of 10; a teacher can
set another percentage per stage in an assignment, see [Giao bài](#giao-bài-assignments)), which opens the next stage the
quiz has (a quiz may have only some of the six, see *Choosing the games* below):

| Stage | Game (`GameKind`) | The learner… | Row shape |
|---|---|---|---|
| 1 | Đúng hay sai (`true-false`) | holds a thumb up or down | Correct Answer exactly `Đúng` or `Sai`, no wrong answers |
| 2 | Nghiêng đầu (`head-tilt`) | tilts or leans the head to the left or right card | Correct Answer + Wrong Answer 1 |
| 3 | Ếch đớp chữ (`frog-bite`) | moves the head to a lane and opens the mouth to bite | Correct Answer + Wrong Answer 1–2 |
| 4 | Chém hoa quả (`fruit-slice`) | slashes, with the index fingertip, the fruit whose colour (and icon on the answer box) matches the answer | Correct Answer + Wrong Answer 1–2 |
| 5 | Giơ ngón tay (`finger-count`) | shows 1–4 fingers (thumb ignored) for the option's number | Correct Answer + Wrong Answer 1–3 |
| 6 | Xếp câu (`word-order`) | points at word tiles in order, resting on a tile or pinching | Correct Answer = the sentence's chunks in the right order joined by ` / `, no wrong answers |

Stages 1, 4, 5 and 6 read the hand and 2 and 3 the face (MediaPipe's GestureRecognizer and FaceLandmarker);
every game also works with mouse, touch or keyboard, so a quiz is playable without a camera. The server's
`prompts/gesture_quiz_template.txt` (the model must not shuffle: the page shuffles the options and the
chunks itself) and the client's `parseGestureQuiz` (`Client/src/models/gesture-quiz.ts`) with the stage
table `STAGES` (`Client/src/game/stages.ts`) describe this one format from both ends, and, like the
other contracts, are kept in step by hand. The parser is forgiving: a header row is optional and rows that
break their stage's rules are dropped and counted (`skipped`, announced to the player), so a drifting
prompt shows up as missing questions, not as an error. The map shows only the stages that have questions, so a
stage left out of the quiz, or one whose rows were all dropped, is simply not there and blocks nothing.

**Choosing the games.** A quiz need not have all six stages. On the AI form the teacher ticks which games it has (any 1 to 6, all by
default) and how many questions each gets (4 to 10, 5 by default; four is the least for which the 70% pass
mark is not all-or-nothing). They travel as `gestureStages=4,6` and `questionsPerStage=7` on `POST csv/jobs`
and are read only for GestureQuiz (`csvgen.Options.GestureStages` / `.QuestionsPerStage`): absent means all
six and 5, a value out of range is 400 `Invalid gestureStages parameter.` or `Invalid questionsPerStage
parameter.`. The server's template then describes only those stages and asks for exactly that many rows of
each. The limits are constants on both sides (`csvgen`'s `Min`/`Max`/`DefaultQuestionsPerStage`, the client's
`models/gesture-quiz-options.ts`), kept in step by hand. Nothing about the choice is stored on the job: the
stages a quiz has are read from its CSV.

**The stage number stays the game's identity** everywhere it is stored or sent (the CSV's Stage column, the
progress, an assignment's `stageCounts`, results), so a quiz of Chém hoa quả and Xếp câu has rows with Stage 4
and 6. Only what a person reads is renumbered by position (`stagePosition` in `game/stages.ts`): that quiz
shows "Màn 1" and "Màn 2" on the map, in the game, on its result and on an assignment's leaderboard.

**Entry points.** On a finished GestureQuiz job the AI jobs table shows "Chơi ngay", which navigates to
`/play/<job id>` (login required; the page takes the job from `AiJobService`), and "Tải file", which
downloads `<title>-Game.csv` with the header prepended. A downloaded file, or the built-in sample
(`Client/src/game/demo-quiz.ts`), is opened on `/play`, which needs no login. The vocabulary table does not
offer this platform: its rows have no stages. Progress (stages passed, best result per stage) is kept in
`localStorage` per quiz, keyed by a hash of the questions rather than the title, so a job and the file
downloaded from it share it; nothing about the quiz or the player goes to the server, except when a teacher
hands the quiz out: the job also gets "Giao bài" (see [Giao bài](#giao-bài-assignments)), and a student who
opens its link plays the same game on `/play/s/<code>` (no login), which reports each finished stage to the
server under the name the student typed. The teacher's own try-out of an assignment is
`/play/preview/<assignment id>` (login required, all stages open, nothing saved).

The camera needs HTTPS (or localhost) and the player's permission, and the two MediaPipe models are
fetched from Google's storage on first use. The specs run against fakes and synthetic landmarks, so they
cover the logic but not the recognition: how the real webcam behaves (lighting, distance, the gesture
thresholds) can only be checked by playing on a machine with a camera.

The Client's half (page, engine, MediaPipe loading) is in [Client/AGENTS.md](Client/AGENTS.md#gesture-quiz-play), the
prompt's in [Server/AGENTS.md](Server/AGENTS.md).

## Giao bài (assignments)

A teacher (any logged-in user) gives a finished Game job to students: the AI jobs table's "Giao bài"
makes an *assignment*, a link `<origin>/play/s/<code>` that anyone can open. A student types a name, picks an
avatar, plays the six-stage game above, and the browser reports each finished stage run; the teacher sees the
leaderboard ("Bảng xếp hạng") on `/assignments/<id>`, can close and reopen the assignment, set a closing time,
preview it, remove a student and download the leaderboard as CSV, and the students see its top five and their
own place on their stage map, unless the teacher hid it from them. A teacher may assign the same quiz several times (one per class), each with its
own link, label and leaderboard. The server half is `Server/internal/api/{assignment,share}_handlers.go`,
`leaderboard.go` and `avatars.go` over `store.Assignments`, the client's `AssignmentService` and `SharedPlayService`; the rules
below are decided by the server, and the client repeats a few of them (the pass mark, whether an assignment is
open, the result grace) only to show the right screen without a round trip.

- **The assignment is a snapshot.** Creating one copies the job's `title` and raw `csv` into the assignment
  (`POST assignments` takes a `jobId`, but only to read it: the job must be the caller's own, `done`,
  `creative` and `exportType` GestureQuiz, else 409 `Job is not a finished gesture quiz.`). The copy is why a
  live link survives the teacher deleting the job or the table pruning it (the newest 30 kept per user): the
  students' game needs a quiz that cannot disappear under it. The server does not parse the quiz: the client
  counts the questions of each stage with `parseGestureQuiz` (`stageCountsOf`) and sends them as `stageCounts`
  (`{"1": 5, …}`, only the stages that have questions; keys `"1"`–`"6"`, 1–50 each), which the server checks
  for shape and then keeps as what a result is checked against. The dialog refuses a quiz with no questions.
- **The code** is 10 characters of Crockford base32 (digits and letters without `I L O U`, so it can be read
  out or typed from a projector), drawn from `crypto/rand` (`newShareCode`), 50 random bits; a clash with an
  existing code redraws, up to 3 attempts. It is stored upper-case and matched case-insensitively (a student's
  typing is trimmed and upper-cased). It is the only credential for opening the quiz: whoever has it can read
  the quiz, answers included, from `GET share/{code}`, since the browser plays it. There is no IP restriction.
- **A student is a name, an avatar and a token, no account.** `POST share/{code}/players` takes `{name,
  avatar}`, creates the player and answers `{playerId, token, name, avatar}`. The token is 32 random bytes, base64url; only its SHA-256 (base64url, the same
  scheme as the refresh tokens) is stored, so reading the database does not let anyone play as somebody else.
  The browser keeps the identity per code in `localStorage` and sends the token as the `X-Player-Token`
  header on every result, which is what makes a reload resume as the same student. "Không phải bạn?" forgets
  it on that device and the old player stays on the leaderboard until the teacher removes it; a 403 on a result
  (the teacher removed the player) also makes the client forget it.
- **Avatars** are picked from a fixed set of 24 animals, never uploaded: only the id travels and is stored
  (`Player.Avatar`). The ids are `avatarIDs` in `Server/internal/api/avatars.go` and `AVATARS` in
  `Client/src/models/avatar.ts` (which also has each one's emoji, Vietnamese name and disc colour), the same
  ids in the same order, kept in step by hand and pinned by a test on each side. On join the avatar is optional
  (empty for none, as from a page older than avatars), and a non-empty unknown id is 400 `Invalid avatar.`,
  checked right after the name. A student changes it later with `PATCH share/{code}/player` (`{avatar}` and the
  token header; checks in order: 404, 410 `Assignment closed`, 403 `Unknown player` for a missing or unknown
  token, the body, 400 `Invalid avatar.` for an empty or unknown id), which answers `{playerId, name, avatar}`.
  The client draws an empty or unknown id as the name's first letter on a neutral disc.
- **Names** are trimmed, with inner whitespace collapsed to one space, 1–40 characters, no control
  characters, and must be unique within the assignment as `strings.ToLower(name)` (`nameKey`: accents are
  kept, so "Nam" and "Năm" are different students, "Lan" and "lan" are not): 409 `Name taken`. The
  assignment takes at most 300 players (409 `Assignment is full`).
- **A result** is `POST share/{code}/results` with `{runId, stage, correct, total}` and the token header, and
  answers 204. The server accepts what could have happened in this quiz: `stage` is one of the assignment's
  `stageCounts` and `total` equals that stage's count, `0 ≤ correct ≤ total`, `runId` matches
  `^[A-Za-z0-9-]{8,64}$` (else 400 `Invalid result.`). A `runId` the player has already reported (the last 50
  are remembered) is answered 204 and changes nothing: the client creates the id once per finished run and
  queues a run it could not deliver with the same id, so resending is safe and never counts a run twice.
  Whether the stage was **passed** is decided by the server, not reported: `correct >= passMark(total, percent)`
  where `percent` is the assignment's pass percent for that stage (70 unless the teacher set another, see
  below) and `passMark(n, p) = (p*n+99)/100` in integer division, which is the client's
  `passMark(total, percent)` (`Math.floor((percent*total+99)/100)`, `game/stages.ts`); `TestPassMark` checks the
  70% case against `ceil(0.7n)` for every `n` up to 300. Changing the pass rule on one side means changing the other.
- **Best run per stage.** A player's results are merged by `mergeResult` (`store/assignments.go`, used by both
  stores): each stage keeps the best `correct` so far, a pass once made stays, `attempts` counts every
  accepted run, and `bestAt` is when the best score was reached (or the pass made), which is what breaks
  ties. A replay can only raise a score, and a student can replay until the assignment closes, or until the
  stage's replay limit is used up (see `maxAttempts` below).
- **The leaderboard** (`buildLeaderboard`, `api/leaderboard.go`, computed on every `GET assignments/{id}` and
  `GET share/{code}/leaderboard`) orders players who
  have results by stages passed, then total correct (the sum of the best of each stage), then who reached that
  score first (`reachedAt`, the latest `bestAt` over the player's stages), then who joined first. Players equal
  on all three share a rank, like a race (1, 1, 3). Players who joined but have no result come last, in the
  order they joined, with `rank: null`. Only the assignment's stages count, and `possible` is the sum of the
  stage counts. The client shows the order as it arrives and never sorts. The teacher gets every player with
  the per-stage detail (`players` of `assignmentDetailView`, each a `leaderboardEntry` with its `avatar`).
- **The students' board** is `GET share/{code}/leaderboard` (`newStudentBoard`), anonymous like every share route,
  with an optional `X-Player-Token`: `{top, you, possible, stageCount, playerCount}`. `top` is the ranked
  players with rank 1 to 5 in leaderboard order, at most 10 rows (a tie for fifth can add some), each
  `{rank, name, avatar, stagesPassed, correct, you}`; `you` is the caller's own place (`rank` null before a
  result), or null for a missing or unknown token, which is never a 401 or 403. It carries no player ids: the
  whole class reads it. Unlike opening the link it answers while the assignment is closed, so the closed card
  can show the final board; it is `no-store`, since every result changes it. When the teacher hid the board
  (`showBoard` false, see below) it answers 404 `Board hidden` instead, open or closed, whatever the token.
- **Open, closed, closing time.** An assignment is closed by hand (`closedAt`) or scheduled (`closesAt`, in
  the future and at most 180 days ahead): it is *open* while `closedAt` is unset and `closesAt` is unset or
  still ahead. The server computes `open` for each response, and the client recomputes it from the two times
  (`isOpenAt`), since a page left open goes stale. Opening the link (`GET share/{code}`) and joining are
  refused with 410 `Assignment closed` the moment it is not open, but **results get a 5 minute grace**
  (`store.ResultGrace`, counted from the earlier of the two times; the leaderboard page repeats it as
  `RESULT_GRACE_MS` to know how long to keep polling) so a student in the middle of a stage at the deadline
  does not lose it; after that a result is a 410 too. `PATCH assignments/{id}` takes any of
  `label`, `closesAt` (null removes it) and `closed` (`true` closes now, keeping the first moment if it was
  already closed; `false` reopens), and a key left out stays as it is. A reopen is refused (400 `Invalid
  closing time.`) when the closing time that would remain is already past, because it would close again
  at once, so the client's reopen dialogs always send a new `closesAt` (or null). A page checks the link
  again before each stage and shows the closed card if it closed meanwhile.
- **Limits:** 100 assignments per user (409 `Too many assignments.`), 300 players per assignment, a label of
  at most 60 characters. Assignments are not AI calls: they use none of the rate-limit quota.
- **Results are reported by the student's browser**, so the server can only check that they are plausible (the
  rules above); a student who tampers with their own browser can post full marks, and stage locks are enforced
  by the client alone. That is accepted for a classroom: do not treat the leaderboard as proof.
- **The contract is hand-kept, like the others.** `Client/src/models/assignment.ts` mirrors the JSON of
  `assignmentView`, `assignmentDetailView` (the assignment plus `csv` and the players in leaderboard order),
  `leaderboardEntry` (`LeaderboardEntry`), the students' board (`StudentBoard`) and the share answers; the
  plain-text error bodies are matched by the client as strings
  (`TEACHER_ERRORS` in the model, `GesturePlay`'s join messages for `Name taken` and `Assignment is full`);
  the time mode (`standard`, `extra`, `unlimited`) travels by name and is the same `TimeMode` the game's
  settings use. The teacher picks one time mode per assignment, which replaces the student's own setting.
  The teacher also picks a **stage lock**, `stageLock`: `sequential` (the default, and what an assignment from
  before the setting reads as) opens each stage once the one before it is passed, `open` lets the student play
  every stage from the start. It is sent on `POST assignments` (absent means `sequential`, any other value is
  400 `Invalid stage lock.`, checked right after the time mode), fixed for the assignment's life, and returned
  by `assignmentView` and `GET share/{code}`. Like every lock it is enforced by the client alone; the server
  does not check the order of results.
  The teacher also picks, per stage, the **pass percent** `passPercents` (stage `"1"`–`"6"` → integer 10–100):
  the share of a stage's questions that must be right to pass it, 70 for a stage not sent. It is sent on
  `POST assignments` (400 `Invalid pass percents.` for a key that is not one of the `stageCounts`, or a value that
  is not a plain integer 10–100, checked after `stageCounts`), fixed for the assignment's life, and returned as a
  complete map for exactly the stages of `stageCounts` by `assignmentView` and `GET share/{code}`. The server
  uses it to decide `passed` when a result arrives; the client uses it for the stage verdict, the unlock, the
  rules line and the leaderboard page. Assignments stored without it read as all 70.
  With the `open` lock the teacher can also set a **replay limit** `maxAttempts` (1–10 finished runs per stage;
  null, the default, is unlimited). It is sent on `POST assignments` (400 `Invalid replay limit.` when it is not a
  plain integer 1–10 or the stage lock is not `open`), fixed for the assignment's life, and returned by
  `assignmentView` and `GET share/{code}` (`null` when unlimited). Unlike the locks it is also enforced by the
  server: `POST share/{code}/results` answers 409 `Replay limit reached` when the player already has
  `maxAttempts` accepted runs in that stage, except for a `runId` already recorded, which is still 204. To let a
  reload or another device know the count, `GET share/{code}` returns `attempts` (stage → accepted runs) for the
  player named by the optional `X-Player-Token` header, `{}` for no or an unknown token (never 401/403). The
  check and the record are not atomic, so two simultaneous runs could both get in: acceptable for a classroom.
  The teacher also decides whether the students see the board, **`showBoard`** (true by default, and what an
  assignment from before the setting reads as), for a class whose students should not be compared with each
  other. It is sent on `POST assignments` (absent or null means true; anything but a JSON boolean is 400
  `Invalid board setting.`, checked after the replay limit), fixed for the assignment's life, and returned by
  `assignmentView` and `GET share/{code}`. With it false, `GET share/{code}/leaderboard` answers 404 `Board
  hidden` and the client mounts no board at all, under the map, on the closed card or in the teacher's
  preview; the teacher's own leaderboard is unchanged. A 404 rather than an empty board, because an empty board
  would tell the class that nobody has a result yet, and because the one page that cannot know the setting (a
  student who opens a link that is already closed gets a 410 from `GET share/{code}`, then shows the closed
  card's board) needs a final answer to stop asking. It is never a 401 or 403, like every student route.
  Adding or renaming a field, status or message means changing both sides and their specs together.

The Client's half is in [Client/AGENTS.md](Client/AGENTS.md#giao-bài-assignments), the Server's (the store, its
collections and indexes, the handlers' order of checks) in [Server/AGENTS.md](Server/AGENTS.md).

## Rate limiting

AI calls are capped per user (`CALL_COUNT_ACCEPTED_IN_A_ROUND` per `ROUND_MINUTES`), with the counter
stored on the user's MongoDB document. The client has no matching UI state — it discovers the limit
only as a `403` with a plain-text body from `POST csv/jobs`, which
`AiGeneration.showGenerationError` turns into a "Hết lượt dùng AI" notification (a `403` with an
empty body is the role check instead, shown as "Không có quyền"). A job whose generation fails (recorded as
`502`/`504`) is given back (`RefundAICall`), so resubmitting after a failure does not use up the user's quota.

## Upload size and LLM timeout (Vercel limits)

Vercel functions reject request bodies over 4.5 MB (413) and stop after 300 s by default (504). The
two sides guard against both:

- The client shrinks images before upload (`ImageCompressionService.compressForUpload`): JPEG,
  longest side 2048 px, stepping down in size/quality until the batch fits a 4 MB budget, else it
  refuses the upload itself.
- The server bounds each LLM call with `LLM_TIMEOUT_SECONDS` (default 280, under Vercel's limit); hitting
  it fails the job with `504 AI generation timed out.` and refunds the call. The upload itself is a
  separate, short request, so only the generation can hit the time limit.
- `AiGeneration.showGenerationError` maps 413 (or the client's own refusal) to a message asking the user to
  send fewer images; a 504 job is announced by `AiJobService` with the same advice.

## Retrying AI requests

All retrying is on the server, inside the one request (`csvgen/retry.go`): transient failures from
the LLM gateway — 429 and 502/503/504, and transport errors — are retried up to 5 attempts with
exponential backoff + jitter, honouring `Retry-After` (following the gateway's policy,
https://shineshop.dev/docs/errors/). All attempts share the `LLM_TIMEOUT_SECONDS` deadline, and a
retry is skipped when less than 30 s would be left, so this never pushes past Vercel's limit (one
invocation cannot outlive 300 s). Other statuses (400/401/402/403/404/413) are never retried.

The client submits each generation once (`AiCsvService` has no retry): a job that used the whole deadline
fails as `504`, and the user submits again from the page. Only a failed *upload* (status 0, before the job
exists) needs the user's retry for a connection reason; once the server answers `202`, a dropped connection
no longer matters.
