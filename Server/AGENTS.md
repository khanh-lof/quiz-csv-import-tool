# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Go (`net/http`) HTTP API backed by MongoDB. It issues JWTs for login, and uses an LLM vision call
to convert uploaded images of Chinese vocabulary into a quiz CSV, gated by JWT auth and a per-user
rate limit stored in MongoDB. It runs as a single standalone binary: the `Dockerfile` image, or the `server`
service of the root `vercel.json`, where Vercel's Go preset builds `cmd/server` and runs it on
Fluid compute with `PORT` set — the code has no Vercel-specific parts.

Module `quiz-csv-import-tool/server`, laid out as:

- `cmd/server` — entry point: reads config, connects to MongoDB, wires everything, graceful shutdown.
- `cmd/import-users` — one-off tool importing users exported from the old Cosmos DB container.
- `internal/config` — env-var configuration (`FromEnv`) and a small `.env` loader for local dev.
- `internal/api` — routing (`Server.Handler`) and all handlers.
- `internal/auth` — JWT issue/parse, PBKDF2 password hashing, and `Service` (login/refresh/logout).
- `internal/store` — the `User` document, the `Users` interface, `Mongo` (production) and `Memory`
  (tests) implementations; the same pair for `Jobs` and for `Assignments` ("Giao bài", with its students).
- `internal/csvgen` — creative-mode option parsing, the two system prompts and the per-platform
  templates (all embedded from `prompts/*.txt`), the embedded lesson documents of four textbooks
  (`textbooks/`), and the OpenAI-compatible client
  (`/chat/completions` for the formatted mode, `/responses` for the creative mode).

## Commands

```bash
go build ./...
go vet ./...
go test ./...                                    # Mongo integration tests (users, jobs, assignments) are skipped…
MONGODB_TEST_URI=mongodb://localhost:27017 go test ./internal/store/   # …unless this is set
go run ./cmd/server                              # http://localhost:7071 (reads .env if present)
docker compose up --build                        # MongoDB + API on 7071
```

### Configuration

All settings are env vars (see `.env.example`; `go run` also reads `.env`, real env vars win).
`MONGODB_URI` and `JWT_SECRET` (at least 32 bytes) are required — the server refuses to start
without them.

- `PORT` (default 7071 — the client's `ng serve` proxy points there)
- `MONGODB_URI`, `MONGODB_DATABASE` (default `QuizDb`), `MONGODB_COLLECTION` (default `Users`),
  `MONGODB_JOBS_COLLECTION` (default `Jobs`, the AI generation jobs),
  `MONGODB_ASSIGNMENTS_COLLECTION` (default `Assignments`) and `MONGODB_PLAYERS_COLLECTION` (default
  `AssignmentPlayers`): the quizzes teachers handed to students, and the students who joined them with their results
- `JWT_SECRET` (≥ 32 bytes, RFC 7518 §3.2 for HS256), `JWT_ISSUER` (default `quiztool`),
  `JWT_AUDIENCE` (default `quiztool-api`) — issuer and audience are always set and validated
- `JWT_ACCESS_TOKEN_EXPIRES_MINUTES` (15), `JWT_REFRESH_TOKEN_EXPIRES_DAYS` (30),
  `MAX_REFRESH_TOKENS_PER_USER` (5 — oldest session evicted beyond this)
- `ADMIN_API_KEY` — required in the `X-Admin-Key` header by `POST /api/users`; empty rejects every call
- `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `LLM_MODEL` — if any is missing the server still starts, but
  CSV generation answers 500. `LLM_MODEL` serves the formatted mode (sent with `reasoning_effort: low`)
- `LLM_INTELLIGENCE_MODELS` — optional, exactly 2 comma-separated models: the creative-mode model for
  the client's "Độ thông minh" Thấp / Cao (`intelligence` query param 1 or 2, default 1).
  Empty means both use `LLM_MODEL`
- `LLM_TIMEOUT_SECONDS` (280) — per-call LLM deadline; kept under Vercel's 300 s function limit so
  the handler answers 504 itself. The HTTP server's write timeout is derived from it
- `CALL_COUNT_ACCEPTED_IN_A_ROUND` (2), `ROUND_MINUTES` (1) — AI-call rate limit per user

## Architecture

Routes (`internal/api/server.go`), all under `/api` because the client calls relative `/api/...` URLs:

- **Auth** (`auth_handlers.go`): `auth/login`, `auth/refresh`, `auth/logout`, `auth/logout-all`.
  Login/refresh return `{"accessToken": ...}` and set the refresh token as an
  `HttpOnly; Secure; SameSite=Strict` cookie — never in the body. A user holds one refresh token per
  device (capped); `logout` revokes the calling device's token, `logout-all` every token of that user.
  Refresh rotates the token; replaying a rotated token later than 30 s after its rotation is
  treated as theft and revokes every session of the user (see the data model below).
- **Users** (`auth_handlers.go`): `users`, admin-only via `X-Admin-Key` (replaces the Azure Functions
  admin key), enforced by the `requireAdminKey` middleware. 409 if the user exists.
- **CSV jobs** (`csv_handler.go`): `POST csv/jobs`, `GET csv/jobs`, `DELETE csv/jobs/{id}`. All wrapped in
  `authenticate` (Bearer JWT → 401 with `WWW-Authenticate`) and `requireRole(auth.RoleUser, auth.RoleAdmin)`
  (→ 403); handlers read the claims with `auth.FromContext`. `createJob` loads the user (404 if deleted
  since the token was issued), reads a multipart body of zero or more files, enforces the rate limit,
  stores a running `store.Job`, prunes the user's jobs to the newest 30, answers `202 {"id"}` (flushed
  early, `Connection: close`) and keeps running in the same handler: `runJob` calls the generator on a
  context detached from the request (`context.WithoutCancel`), so the client leaving does not cancel it,
  and records the outcome with `Jobs.Complete` / `Jobs.Fail`. Validation, auth and rate-limit
  errors are still answered synchronously with the plain-text bodies below. `title` (query, capped at
  100 runes) names the job. `listJobs` returns the user's jobs newest first (JSON `{"jobs": [...]}`,
  the CSV included) after failing any job running past `LLM_TIMEOUT_SECONDS` + 1 min as abandoned (and
  refunding its call). `isCreative=true` switches to the creative prompt and requires `exportType`,
  `courseType`, `lessonNumber`, plus `level` (HSK/YCT) or `courseName` (`Other`), and for GestureQuiz the
  optional `gestureStages` and `questionsPerStage` (see [Choosing the games](../AGENTS.md#the-gesture-quiz-game)) — parsed by
  `csvgen.ParseCreativeOptions` (400 with the message on failure). `lessonNumber` must be 1 or more (400
  `Invalid or missing lessonNumber parameter.`), and for a textbook with embedded lessons (below) at most its
  lesson count: 400 `Lesson must be 1 to <M> for <title>.`, e.g. `Lesson must be 1 to 15 for 《新HSK教程2》.` Images are optional only in
  creative mode. The LLM call runs under `LLM_TIMEOUT_SECONDS`; hitting it fails the job with
  `errorStatus` 504 ("AI generation timed out."), other LLM failures with 502. Either failure refunds the
  rate-limit slot (`RefundAICall`) so the user can resubmit without losing quota. See [../AGENTS.md](../AGENTS.md#the-two-ai-generation-modes) for the client half.
- **Assignments** (`assignment_handlers.go`, the teacher's side of "Giao bài"): `POST assignments`,
  `GET assignments`, `GET`/`PATCH`/`DELETE assignments/{id}` and `DELETE assignments/{id}/players/{playerId}`,
  wrapped like the csv routes (`csvRoute`, i.e. `authenticate` + `requireRole`). Every lookup is scoped to the
  caller's username, so someone else's assignment is a 404 `Assignment not found`, never a 403. The order of
  `createAssignment`'s checks is part of the contract: the payload first (`readJSON`'s 400s, then label ≤ 60
  runes, time mode, closing time in the future and ≤ 180 days ahead, stage counts: 400 `Label is too long.`,
  `Invalid time mode.`, `Invalid closing time.`, `Invalid stage counts.`), before anything is read from the
  database; then the 100-per-user cap (409 `Too many assignments.`); then the job through `Jobs.Get` (404
  `Job not found`, or 409 `Job is not a finished gesture quiz.` unless it is `done`, `creative` and
  `exportType` GestureQuiz). So a user at the cap gets the 409 even for a job id that does not exist. It copies `job.Title` and `job.CSV`, draws the id (`newJobID`) and the code
  (`newShareCode`: 10 characters of Crockford base32 from `crypto/rand`) and retries on `ErrDuplicate` up to
  3 times. The server never parses the CSV: `stageCounts` is the client's count of each stage, checked for
  shape only (keys `"1"`–`"6"`, 1–50 each). `listAssignments` leaves the CSV out and adds each `playerCount`;
  `getAssignment` adds the CSV and `rankPlayers`' output (`ranking.go`) to the same view, and both answer
  `Cache-Control: no-store`, as the client polls the detail. `patchAssignment` reads the body as a map of raw
  values, so an absent key (leave it) differs from `null` (clear `closesAt`; a `null` label or `closed` is
  a 400 `Invalid payload`); `closed: true` closes now unless it was already closed by hand (the first moment is
  kept, so the result grace does not slide), and `closed: false` is refused (400 `Invalid closing time.`) if the
  closing time that would remain, the old one or the one in the same request, is not in the future.
  `deleteAssignmentPlayer` loads the assignment first only to check the caller owns it, since the store's
  player methods do not know owners.
- **Share** (`share_handlers.go`, the students' side): `GET share/{code}`, `POST share/{code}/players`,
  `POST share/{code}/results`. They are registered bare, with no `authenticate`, and must never answer 401
  (the SPA's interceptor would answer that with a token refresh): a student's credentials are the code and,
  for results, the `X-Player-Token` header. The order of checks, which decides the status when several
  things are wrong: the code is trimmed and upper-cased and looked up (404 `Assignment not found`) in all
  three. `getShared` then answers 410 `Assignment closed` unless `OpenAt(now)`, else `{title, label, csv,
  timeMode, stageLock, passPercents, maxAttempts, attempts, closesAt}`, with `no-store` on every answer, errors included, since a close must show at once.
  `joinShared` refuses a closed assignment (410) before it reads the body, then `cleanPlayerName` (400
  `Invalid name.`: trimmed, whitespace runs folded, 1–40 runes, no control characters), then the 300-player cap
  (409 `Assignment is full`), then `CreatePlayer` (409 `Name taken` on `ErrDuplicate`); it mints a token of 32
  random bytes (base64url), stores only `hashPlayerToken(token)` (SHA-256, base64url, the same as the refresh
  tokens; `auth` keeps its helper unexported) and answers 201 `{playerId, token, name}`. `reportResult` refuses
  with 410 once `AcceptsResultsAt(now)` is false (open, or within `store.ResultGrace`, 5 minutes, of the
  effective close), then 403 `Unknown player` for a missing header or a token no player of this assignment
  holds, *before* the body is read, then 400 `Invalid result.` (`runId` not `^[A-Za-z0-9-]{8,64}$`, stage not in
  `stageCounts`, `total` not that stage's count, `correct` outside `0..total`), then works out `passed` with
  `passMark(n, percent) = (percent*n+99)/100` with the assignment's percent for the stage (`passPercentOf`, 70 when
  unset; at 70 equal to the client's `Math.ceil(0.7 * n)`, `TestPassMark` checks up to 300); before recording it
  answers 409 `Replay limit reached` when `maxAttempts` is set, the `runId` is new and the player's attempts in
  that stage have reached it, and
  calls `RecordResult`, answering 204; an `ErrNotFound` from it (the teacher removed the student meanwhile) is
  also 403. Nothing limits joins by IP, by design; the 300 cap and unique names are the only brakes.

`Server.Now` is the clock the assignment and share handlers read (nil means `time.Now`; they call `s.now()`),
so a test can step through a closing time or the grace period without waiting. The other handlers still read
`time.Now` directly.

Auth is net/http middleware (`middleware.go`), composed per route in `Server.Handler`: `authenticate`
stores the validated `*auth.Claims` in the request context under an unexported key
(`auth.NewContext` / `auth.FromContext`); `requireRole` must sit inside it and fails closed (401) if
it finds no claims. Protect a new route by wrapping it the same way rather than checking tokens in
the handler.

The plain-text error bodies and status codes are part of the contract with the client and were kept
identical to the former .NET implementation; `internal/api/api_test.go` pins them down. The assignment routes
follow the same rule: the client matches some of their bodies as strings (`TEACHER_ERRORS` in
`Client/src/models/assignment.ts`, and `Name taken` / `Assignment is full` in `GesturePlay`), and
`assignments_api_test.go` pins them. The rules behind them are in
[../AGENTS.md](../AGENTS.md#giao-bài-assignments).

Tests of "Giao bài": `store/assignments_test.go` runs one contract (`testAssignments`) against both stores
(`TestMemoryAssignments`; `TestMongoAssignments` only when `MONGODB_TEST_URI` is set, in a throwaway database,
with `TestMongoAssignmentsWithoutIndexes` and `TestMongoAssignmentDocuments` for uniqueness without indexes and
the stored field names) beside unit tests of `OpenAt`, `EffectiveClose`, `AcceptsResultsAt` and `mergeResult`;
`jobs_test.go` covers `Jobs.Get`. `api/assignments_api_test.go` drives the HTTP handlers over the memory stores
with a `testClock` (`env.clock.Advance`) as `Server.Now`: the whole flow (create, share, join, results with a
repeated `runId`, ranking, close, the grace period, reopen, remove a student, delete), every error status and
body, ownership, `TestTeacherRoutesNeedALogin`, `TestStudentRoutesNeverAnswer401` (with bad `Authorization`
headers too), the limits, `TestPassMark` and store failures answering 500. `api/ranking_test.go` tests
`rankPlayers` as plain Go, and `config/config_test.go` the new collection settings.

There is no CORS handling: the API is only ever called from the SPA's own origin (Vercel Services in
production, the `ng serve` proxy locally), which is also why the refresh cookie can be
`SameSite=Strict`. Putting the SPA on another origin would need CORS back and a `SameSite=None`
cookie.

`csvgen`:

- `ExportType` (`GimKit`/`Blooket`/`Wayground`/`GestureQuiz`, ordinals 0–3) and `CourseType`
  (`Hsk`/`Yct`/`Other`) are passed by **ordinal** (the parser also takes the names, case-insensitively)
  and must stay in the same order as `Client/src/models/export-type.ts` and `course-type.ts`.
  `exportTypeMessages` must describe the same columns as the client's CsvBuilders, except for
  `GestureQuiz`, which is not an import target: its columns are the ones the client's own game parser
  (`parseGestureQuiz`, `Client/src/models/gesture-quiz.ts`) reads, and the two are kept in step by hand.
- Prompts live in `prompts/*.txt` (`go:embed`); CRLF from a Windows checkout is normalized at use.
  `creative_system.txt` is the long Chinese-teacher prompt shared by every platform, and a platform's
  `exportTypeMessages` case sends its column line and, as a message of its own, `wayground_template.txt` for
  Wayground or what `buildGestureQuizMessage` builds for GestureQuiz. The Game message holds the whole format: the stages the teacher chose, which row shape each
  one takes, how to classify a question by its real difficulty into a stage, exactly `QuestionsPerStage` rows
  per stage grouped by stage, and a Vietnamese Explanation on every row. It is built from two files:
  `gesture_quiz_template.txt`, a `text/template` (`missingkey=error`) with the framing and its variants (one
  stage or several, some stages left out, any stage with options), and `gesture_quiz_stages.txt`, the six
  tuned stage rules, one paragraph each starting `Stage N – `, of which only the chosen ones are sent word for
  word (the file is checked when the package loads and a malformed one panics). With the defaults (all six,
  5 each) it reads like the original one-file prompt apart from the counts. The message
  replaces the usual "mixture of difficulty" (two sentences in `creative_system.txt` step aside when
  a template defines stages or its own ordering format). The client plays those rows, so see the stage table in
  [../AGENTS.md](../AGENTS.md#the-gesture-quiz-game) before changing the template.
- **Textbook lessons** (`textbooks.go`, `textbooks/<book>/lesson-NN.md`, embedded with `go:embed textbooks`).
  For four books the teacher need not send photos, nor leave the model to rebuild the lesson from memory:
  the curated document of the lesson is sent as a **LESSON MATERIAL** message. The books are the hand-kept
  `textbookRegistry` (`dir`, title, `CourseType`, `HskStandard`, level and the pinned **lesson count**):
  `hsk3-1`, `hsk3-2`, `hsk3-3` (HSK 3.0 levels 1 to 3, 15, 15 and 18 lessons, one series: a learner of level
  N knows the lower books) and `yct-6` (YCT level 6, 15 lessons, alone; YCT 1 to 5 have no material and the
  learner is assumed to know them). The client mirrors the registry in `Client/src/models/textbook.ts`, so
  adding a book or a lesson means changing the folder, the registry and that file together. `textbookFor`
  matches `CourseType` + (HSK only) `HskStandard` + `*Level`; `Other` and HSK 2.0 never match, and neither does
  anything when the library did not load. A match changes `CourseDisplayName()` to the book's full name
  (`《新HSK教程2》 (New HSK Course 2), the HSK 3.0 level 2 textbook`) and is why `ParseCreativeOptions` knows the
  lesson count.
  - **The documents** follow `Textbooks/LESSON_DOC_FORMAT.md` (repository root): a title line, then
    `## Objectives`, `## New words` (a six-column table: Word, Pinyin, POS, English, Tiếng Việt, Note),
    `## Proper nouns`, `## Language points` and `## Texts`. They are written apart from the code, from the
    scanned books. The code reads only the New words table, as the Word cell of each row.
  - **Loading** (`loadLibrary`, at package init, into the package variable `books`): for each book the files
    `lesson-01.md` to `lesson-NN.md`, exactly the pinned count and no other `lesson-*` file, are read and
    normalized (`normalizePrompt`: CRLF to LF, trimmed). A file that is missing, has no `## New words`
    section (rows run to the next `## ` line, the header and `|---|` separator skipped), has no rows, a row
    that is not 6 cells wide, or a Word cell that is empty or contains `★` fails the load, and the error names
    the book and the lesson. A failed load does **not** panic (the documents are written separately and a
    half-written folder must not break every test): it leaves `books` empty, so nothing matches, and keeps the
    error for `csvgen.TextbooksError()`, which `cmd/server` checks first thing in `run` and refuses to start on.
    `TestEmbeddedTextbooks` pins that the embedded folder loads with its pinned counts; the rest of the tests
    run on `fstest.MapFS` fixtures swapped in with `useLibrary` / `useFixtureLibrary`.
  - **The message** (`lessonMaterial`): `LESSON MATERIAL: <full name>, lesson N of M, taken from the textbook
    itself.`, the normalized document, and a last line `Known vocabulary (words of …, which the learner already
    knows; …): w1、w2、…`: the New words of the lower books of the series (all their lessons) and then of lessons
    1 to N-1 of the book, deduplicated in that order. Lesson 1 of the first book has no such words and says so;
    `yct-6` ends with a sentence that the learner also knows the words of YCT levels 1 to 5.
  - **The request** (`buildCreativeRequest`): the input parts are the intro, `exportTypeMessages`, the Course /
    Level / Lesson number messages, the material, then the images. The intro says the material is the lesson
    (with images: that the images show the part to focus on); for any course without a book the request is
    exactly what it was before (`TestBuildCreativeRequestWithoutLessonMaterial`). Token caps and the
    `web_search` tool are unchanged. `creative_system.txt`'s LESSON SOURCE has a case for each of material,
    only images and neither: with material the model tests only the New words (no ★ word or proper noun as the
    target), takes pinyin and meanings from the table, builds sentences from the Language points and Texts,
    and draws distractors only from the lesson and the Known vocabulary; the web search tool stays for
    illustrations and is never used to look the lesson up.
- `post` retries transient gateway failures (429, 502/503/504, transport errors), up to 5 attempts
  within the caller's deadline; this is the only retry layer (the client does not re-send) — see `retry.go` and [../AGENTS.md](../AGENTS.md#retrying-ai-requests). Non-2xx answers
  become `*StatusError` (status, gateway `error.code`, `Retry-After`); each attempt's
  `x-request-id` is logged.
- `ExtractCSVContent` strips code fences / leading prose the model sometimes adds.
- The creative mode uses the Responses API because Wayground requests carry the `web_search` tool:
  the model searches Pexels for the Image Link column and builds `images.pexels.com` URLs from the
  photo IDs it finds (Wikimedia is banned; Wayground cannot load it). Other platforms have no image
  column and get no tool and the lower output cap (10000 tokens; Wayground's, `maxOutputTokensLarge`, is
  16000), except a GestureQuiz of more than 30 rows (`gestureRowsInBaseBudget`, the default six stages of
  five), which gets 16000 too, since up to 60 rows plus the model's reasoning may not fit in 10000
  (`TestGestureQuizTokenBudget` pins this). An `incomplete`
  response (output token cap hit) fails the call rather than
  returning cut-off rows. The `OPENAI_BASE_URL` gateway must support `/responses` with `web_search`,
  and requires `max_output_tokens` to be set.

Jobs (`internal/store/jobs*.go`): `store.Jobs` is implemented by `MongoJobs` (collection
`MONGODB_JOBS_COLLECTION`) and `MemoryJobs` (tests), and every method is scoped to a username. A `Job`
holds the request's metadata (title, mode, export type ordinal, intelligence, image count — never the
images — and, for a creative job, the lesson: course type ordinal, course name, HSK standard, level and
lesson number, which `listJobs` returns so the client can filter by them), `status` (`running`/`done`/`failed`), the raw model `csv`, `errorStatus`/`errorMessage`, the
rate-limit `roundStart` (for refunds) and timestamps. `Complete`/`Fail` only touch a job that is still
`running`, so an expired job is never revived by a late answer; `Prune` never deletes a running job.
`Get(username, id)` returns one job, `ErrNotFound` for another user's too (`createAssignment` is its caller).
`MongoJobs.EnsureIndexes` (username + createdAt) is, like the users' one, not called on start.

Assignments (`internal/store/assignments*.go`): `store.Assignments` is implemented by `MongoAssignments` and
`MemoryAssignments` (tests), and holds two kinds of document. An `Assignment` (collection
`MONGODB_ASSIGNMENTS_COLLECTION`, `_id` a random hex id) is the snapshot of a job: owner `username`, `jobId`,
`title`, the raw `csv`, `label`, `timeMode` (`standard`/`extra`/`unlimited`), `stageLock` (`sequential`/`open`; empty on old documents, read as `sequential` by `stageLockOf`), `passPercents` (stage → percent; stages or whole map missing read as 70 by `passPercentOf`), `maxAttempts` (nil = unlimited), `stageCounts` (stage → number of
questions), `createdAt`, the public `code`, and two optional times, `closesAt` (scheduled) and `closedAt` (by
hand), left out of the document when unset. It is copied rather than referenced so deleting a job, or the
newest-30 prune, cannot break a live link. `OpenAt(now)` is "`closedAt` unset and `closesAt` unset or ahead";
`EffectiveClose` is the earlier of the two, and `AcceptsResultsAt(now)` is open, or no later than the effective
close plus `ResultGrace` (5 minutes). A `Player` (collection `MONGODB_PLAYERS_COLLECTION`) is a student of one
assignment: `assignmentId`, `name`, `nameKey` (the lower-cased name, unique within the assignment), `tokenHash`
(never the token), `joinedAt`, `lastPlayedAt`, `stages` (the best result of each stage: `correct`, `total`,
`attempts`, `passed`, `bestAt`), the last 50 `runIds` and a `version`. Players are a collection of their own,
not an array on the assignment, so many students finishing a stage at the same moment write different
documents. The interface's teacher-side methods (`Get`, `List`, `Count`, `Update`, `Delete`) take the owner's
username, so another user's assignment is `ErrNotFound`; `GetByCode` and the player methods (`CreatePlayer`,
`CountPlayers`, `ListPlayers`, `PlayerByToken`, `RecordResult`, `DeletePlayer`) work from the public code or the
token and leave authorization to the handlers. `List` leaves the CSV out; `Delete` removes the players too
(in Mongo only after the assignment itself went, so deleting someone else's cannot wipe its players); `Update`
takes an `AssignmentUpdate` where each time is a `TimeChange{Set, Value}` (not set: unchanged; set with a nil
value: cleared, i.e. `$unset`).

- `RecordResult` merges one run through `mergeResult`, shared by both implementations so the rules cannot
  drift: an already-recorded `runId` changes nothing (and returns nil, which is what makes a resend safe), else
  `attempts` counts it, the stage's `correct` rises only if the run beat it (`bestAt` moves then), a pass once
  made stays (and sets `bestAt` when it first happens), and the last 50 run ids are kept. Mongo does it like
  `UpdateSessions`: read the player, merge, write back only where `version` is unchanged (`$inc`), retry up to
  5 times, else `ErrConflict`; this keeps two runs of one student reported at the same moment (two tabs, a
  queue being flushed) from overwriting each other's merge. The memory store does it under its mutex.
- Times are stored as UTC milliseconds (`storedTime`), the precision MongoDB keeps, and both implementations
  copy and normalize through `Assignment.stored()`/`Player.stored()`, so a value reads back the same from
  either (and empty maps and slices are stored as `{}` and `[]`, not `null`). `MemoryAssignments.Now` exists for
  parity with the other memory stores but no method reads it: `RecordResult` takes its time from the caller.
- Uniqueness of the code and of a name within an assignment is **checked before inserting** (`Create`,
  `CreatePlayer`), so it holds even where no index was ever created (`TestMongoAssignmentsWithoutIndexes`); the
  unique indexes only close the race between two simultaneous inserts. `MongoAssignments.EnsureIndexes` defines,
  on the assignments collection, unique `code` and `{username, createdAt: -1}` (`List`, `Count`), and on the
  players collection unique `{assignmentId, nameKey}` and `{assignmentId, tokenHash}` (`PlayerByToken`; this one
  is not unique, tokens being 256 random bits). Like the users' and jobs' ones, **the server does not call
  `EnsureIndexes`** (it would slow every serverless cold start) and nothing else does either: create the four
  indexes once by hand, or from a one-off that calls it. Without them the lookups by code, by owner and by
  token scan their collection, which is fine for a classroom's volumes but not for ever.

Data model (`internal/store`): one `User` document per user in one collection, `_id` = username,
holding `passwordHash`, `roles`, `createdAt`, `refreshTokens` (`tokenHash`, `expiresAt`,
`createdAt`), `spentRefreshTokens` (`tokenHash`, `spentAt`, `expiresAt`), `aiCallCountInRound`,
`startRoundTime`, and `version`.

- Refresh tokens are opaque 512-bit random strings; only their SHA-256 (`tokenHash`, base64url) is
  stored, so a database leak hands out no sessions. `auth.Service` hashes; the store only sees hashes.
- Session changes go through `UpdateSessions` (active + spent tokens as one `store.Sessions`):
  read, apply the mutation, write back only if `version` is unchanged (`$inc` on success), retry up
  to 5 times. This keeps concurrent logins from dropping each other's tokens, and — because
  `Refresh` checks the token inside the mutation — two concurrent refreshes with one token cannot
  both succeed. Documents without `version` count as 0. The token policy (prune expired, cap,
  rotate, reuse detection) lives in `auth.Service`, not the store.
- Reuse detection: a rotated token moves to `spentRefreshTokens` (last 50 kept, each until its
  original expiry). Presenting a spent token within 30 s of its rotation is a benign race (two tabs
  refreshing at once) and just gets 401; later, it clears every active session of the user
  (`auth.ErrRefreshTokenReused`, logged as a warning) and still answers `401 Invalid refresh token`.
  `logout-all` only accepts an active token.
- `TryConsumeAICall` enforces the rate limit atomically with two conditional updates (increment
  within a running round under the limit, else start a new round) instead of read-then-write. It
  returns the round's start; `RefundAICall` decrements only while `startRoundTime` still equals it,
  so a refund arriving after a new round began cannot eat into that round.
- `EnsureIndexes` creates the `refreshTokens.tokenHash` and `spentRefreshTokens.tokenHash` indexes
  used by `FindByRefreshTokenHash`. The server
  does not call it (it would slow every serverless cold start); `cmd/import-users` does, or create
  the index once by hand. Without it, refresh lookups scan the collection — fine for few users.

Password hashes are `iterations.base64(salt).base64(key)` with PBKDF2-HMAC-SHA256 — the same format
the .NET version wrote, so users imported with `cmd/import-users` keep their passwords. Login with
an unknown username still runs PBKDF2 (against `dummyHash`) so response time does not reveal which
usernames exist. Access tokens are HS256 with the username in `sub` and a `roles` array, validated
with 2 minutes of clock skew (the algorithm is pinned; `exp`, `iss` and `aud` are required). Expired
tokens are logged at debug level (`auth.ErrTokenExpired`), other validation failures as warnings.
