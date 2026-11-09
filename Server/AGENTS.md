# AGENTS.md

This file provides guidance to AI when working with code in this repository.

## What this is

A Go (`net/http`) HTTP API backed by MongoDB. It issues JWTs for login, and uses an LLM vision call
to convert uploaded images of Chinese vocabulary into a quiz CSV, gated by JWT auth and a per-user
rate limit stored in MongoDB. It runs as a single standalone binary: the `Dockerfile` image, or the `server`
service of the root `vercel.json`, where Vercel's Go preset builds `cmd/server` and runs it on
Fluid compute with `PORT` set — the code has no Vercel-specific parts. A second binary, `cmd/ai-server`, runs
only the creative jobs at High intelligence on Render (root `render.yaml`), where a request may run longer than
a Vercel function; see [../AGENTS.md](../AGENTS.md#what-this-is).

Module `quiz-csv-import-tool/server`, laid out as:

- `cmd/server` — entry point: reads config, connects to MongoDB, wires everything, graceful shutdown.
- `cmd/ai-server` — the High intelligence AI server: the same config, MongoDB stores and JWT checks, serving
  only `api.Server.HighIntelligenceHandler` (start and retry a creative job at High intelligence, 400 for any
  other job, and `/healthz`), with no LLM time limit. It refuses to start without the LLM settings, waits up to
  `shutdownGrace` (25 s, under the 30 s Render leaves a free instance after SIGTERM; `maxShutdownDelaySeconds`
  needs a paid one) for running jobs on shutdown, so a deploy cuts off a longer job, while any job runs requests
  its own public URL (`RENDER_EXTERNAL_URL`) every 5 minutes so Render's free instance does not go to sleep under
  it, and every minute, from boot, takes over and runs again the High intelligence jobs whose process died
  (`resumeInterrupted`, see [../AGENTS.md](../AGENTS.md#the-two-ai-generation-modes)).
- `cmd/import-users` — one-off tool importing users exported from the old Cosmos DB container.
- `internal/config` — env-var configuration (`FromEnv`) and a small `.env` loader for local dev.
- `internal/api` — routing (`Server.Handler`) and all handlers.
- `internal/auth` — JWT issue/parse, PBKDF2 password hashing, and `Service` (login/refresh/logout).
- `internal/store` — the `User` document, the `Users` interface, `Mongo` (production) and `Memory`
  (tests) implementations; the same pair for `Jobs` and for `Assignments` ("Giao bài", with its students).
- `internal/csvgen` — creative-mode option parsing, the two system prompts and the per-platform
  templates (all embedded from `prompts/*.txt`), the embedded lesson documents of four textbooks
  (`textbooks/`), and the OpenAI-compatible client
  (`/chat/completions` for the formatted mode, `/responses` for the creative mode). `radicals.go` is the
  "Ghép bộ thủ" platform's side of it: where a lesson's words come from (the textbook's tables, or the model),
  the two JSON requests (`prompts/radicals_vocabulary.txt`, `prompts/radicals_details.txt`) and their merging, then
  the calls into `internal/radicals`; `Generate` returns a `Result`, whose `CSV` is the exercise's JSON for that
  platform and whose `Source` is what it was built from (`radicals_source.go`: `radicalsSource`, its words flagged
  with where their notes came from). `radicals_edit.go` is the teacher's side: `RadicalsEditOf` (the table of what
  can be corrected) and `ReviseRadicals` (the corrections applied to the source and the exercise built again, no LLM).
- `internal/radicals` — the "Ghép bộ thủ" engine, a port of the GhepBoThu KIT (Python): `Plan` validates the
  lessons and solves the groups (1 example + 5 questions, 6 distinct missing components), `Draft.Needs` says which
  word, character and component notes the curated pools (`data/pool_*.json`) lack, `Draft.Build` assembles the
  `Exercise` (stored on the job as JSON), `RenderHTML` draws the standalone page from `data/template/` with the glyphs
  of `data/mmah.jsonl.gz` (Make Me a Hanzi, trimmed by `internal/genmmah`; licences in `data/MMAH-LICENSE.md`). No
  LLM, no I/O beyond the embedded data, deterministic for the same input. See
  [../AGENTS.md](../AGENTS.md#ghép-bộ-thủ-the-radicals-exercise).
- `internal/gesturequiz` — the Game quiz as the server reads it: `ExtractCSV` and `SplitRows` (ports of the
  client's `extractCsvContent` and `parseCsvRows`), `Parse` (a port of `parseGestureQuiz`, the same rules and
  the same `skipped` count: a row must have exactly `ColumnCount` (12) fields, and each `Question` keeps the
  pinyin of its question, answers and chunks, which `PinyinOf` and `ChunkPinyinOf` find by text), the stage table (option counts, seconds per question, `TimeLimit` per time mode)
  and `ShuffleChunks`. The client's versions are the reference; `quiz_test.go` ports the client's parser cases,
  and a rule changed on one side must be changed on the other.

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
  `AssignmentPlayers`): the quizzes teachers handed to students, and the students who joined them with their results,
  `MONGODB_LOGIN_ATTEMPTS_COLLECTION` (default `LoginAttempts`): the login attempts counted per username
- `JWT_SECRET` (≥ 32 bytes, RFC 7518 §3.2 for HS256), `JWT_ISSUER` (default `quiztool`),
  `JWT_AUDIENCE` (default `quiztool-api`) — issuer and audience are always set and validated
- `JWT_ACCESS_TOKEN_EXPIRES_MINUTES` (15), `JWT_REFRESH_TOKEN_EXPIRES_DAYS` (30),
  `MAX_REFRESH_TOKENS_PER_USER` (5 — oldest session evicted beyond this)
- `ADMIN_API_KEY` — required in the `X-Admin-Key` header by `POST /api/users`; empty rejects every call
- `APP_ORIGIN` — QuizTool's public URL, added to the origins the downloadable Wayground extension runs on
  when its zip is packed (`go generate` at build time, or the first download); empty leaves only
  `http://localhost:4200`, and a value that is not an `http(s)://host` origin fails the pack
- `HIGH_INTELLIGENCE_SERVER_URL` — the base URL of `cmd/ai-server`; when set, `createJob` and `retryJob` hand a
  creative job at High intelligence to it (`HighIntelligenceProxy`, path, query, body and token unchanged, up to
  2 minutes for its `202`, 502 `The High intelligence AI server is unavailable.` when it cannot be reached).
  Empty runs those jobs here. The AI server ignores it
- `CLOUDINARY_URL` — `cloudinary://<api key>:<api secret>@<cloud name>`: where both servers keep the images of jobs
  for 30 days (`imagestore.Cloudinary`, Basic-auth calls to the Upload and Admin APIs), so a failed job can be
  retried and an interrupted one resumed; empty keeps none, and a malformed value stops the server at start
- `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `LLM_MODEL` — if any is missing the server still starts, but
  CSV generation answers 500. `LLM_MODEL` serves the formatted mode (sent with `reasoning_effort: low`)
- `LLM_INTELLIGENCE_MODELS` — optional, exactly 2 comma-separated models: the creative-mode model for
  the client's "Độ thông minh" Thấp / Cao (`intelligence` query param 1 or 2, default 1).
  Empty means both use `LLM_MODEL`
- `LLM_TIMEOUT_SECONDS` (280) — per-call LLM deadline of `cmd/server`; kept under Vercel's 300 s function limit
  so the handler answers 504 itself. The HTTP server's write timeout is derived from it, and the creative
  system prompt's TIME LIMIT section tells the model this number (`{{.TimeLimitSeconds}}`). `cmd/ai-server`
  has no deadline: its prompt has no TIME LIMIT section, and its search guidance does not mention one
- `CALL_COUNT_ACCEPTED_IN_A_ROUND` (2), `ROUND_MINUTES` (1) — AI-call rate limit per user
- `LOGIN_MAX_ATTEMPTS` (5), `LOGIN_WINDOW_MINUTES` (15) — login limit per username, see Auth below
- `GAME_STAGE_SECONDS` (`12,12,15,15,20,45`) — the seconds per question of the Game's stages 1–6, in order, for
  assignments: exactly 6 whole numbers, 5–600 each, else the server refuses to start. The run handlers time
  answers by it (with the assignment's time mode applied) and the share answer and every assignment view send the
  result as `timeLimits`, so a student's browser holds no time table of its own that matters. The client's
  `STAGES` seconds only time practice played from a file or a job.

## Architecture

Routes (`internal/api/server.go`), all under `/api` because the client calls relative `/api/...` URLs:

- **Auth** (`auth_handlers.go`): `auth/login`, `auth/refresh`, `auth/logout`, `auth/logout-all`.
  Login/refresh return `{"accessToken": ...}` and set the refresh token as an
  `HttpOnly; Secure; SameSite=Strict` cookie — never in the body. A user holds one refresh token per
  device (capped); `logout` revokes the calling device's token, `logout-all` every token of that user.
  Refresh rotates the token; replaying a rotated token later than 30 s after its rotation is
  treated as theft and revokes every session of the user (see the data model below).
  Login is limited per username: `LOGIN_MAX_ATTEMPTS` password checks in a window of `LOGIN_WINDOW_MINUTES`
  that starts with the first attempt, after which every attempt (even with the right password) answers
  `429 Too many login attempts` with `Retry-After` (seconds to the window's end) and checks no password. An
  attempt is counted before the password is checked, so concurrent attempts cannot slip past together; a
  successful login clears the count. Unknown usernames are counted alike, so the limit does not reveal which
  exist. The count is `store.LoginAttempts` (`MongoLoginAttempts`, one document per SHA-256 of the typed
  username, so a password typed into the username field is never stored; `MemoryLoginAttempts` in tests),
  shared by every instance. Its `EnsureIndexes` (a TTL index on `expiresAt` that deletes ended windows) is,
  like the others, not called on start. The limit also lets anyone lock a user out for one window by typing
  wrong passwords under their name; there is no per-IP limit.
- **Users** (`auth_handlers.go`): `users`, admin-only via `X-Admin-Key` (replaces the Azure Functions
  admin key), enforced by the `requireAdminKey` middleware. 409 if the user exists.
- **Extension** (`extension_handler.go`): `GET extension`, behind the same `authenticate` + `requireRole` as the
  CSV jobs, answers the extension's zip (Wayground and Gimkit) from `internal/extension` (embedded when `go generate
  ./internal/extension` ran before the build, as the Vercel `buildCommand` does; otherwise packed from
  `../Extension` on first use), or 404 `Extension not available.`. See [../AGENTS.md](../AGENTS.md#the-browser-extension-wayground-and-gimkit).
- **CSV jobs** (`csv_handler.go`): `POST csv/jobs`, `GET csv/jobs`, `DELETE csv/jobs/{id}`,
  `POST csv/jobs/{id}/retry`, `GET csv/jobs/{id}/page` (the page of a finished Radicals job, `text/html`, drawn
  from the job's exercise JSON on each request; 404 `Job not found`, 409 `Job is not a finished radicals
  exercise.`), and in `radicals_handlers.go` `GET` and `PUT csv/jobs/{id}/radicals` (the teacher's corrections of a
  Radicals exercise; `radicalsJob` gives the page's two refusals, `editableRadicalsJob` adds 409 `Job cannot be
  edited.` for a job without its source; `reviseRadicals` then reads the body, maps `csvgen.ErrInvalidCorrections` to
  400, `csvgen.ErrIncomplete` to 422 with the flagged table, `radicals.ErrNothingToPlay` to 409, and saves with
  `Jobs.Revise`, never touching the rate limit or the generator; see
  [../AGENTS.md](../AGENTS.md#ghép-bộ-thủ-the-radicals-exercise)). All wrapped in
  `authenticate` (Bearer JWT → 401 with `WWW-Authenticate`) and `requireRole(auth.RoleUser, auth.RoleAdmin)`
  (→ 403); handlers read the claims with `auth.FromContext`. `createJob` loads the user (404 if deleted
  since the token was issued), reads a multipart body of zero or more files, enforces the rate limit,
  stores a running `store.Job`, prunes the user's jobs to the newest 30, answers `202 {"id"}` (flushed
  early, `Connection: close`) and keeps running in the same handler: `runJob` calls the generator on a
  context detached from the request (`context.WithoutCancel`), so the client leaving does not cancel it,
  and records the outcome with `Jobs.Complete` / `Jobs.Fail`; meanwhile `storeJobImages` stores the images in the
  `ImageStore` (Cloudinary) and records them with `Jobs.SetImages` (`job_images.go`, kept for `imagesKeptFor`, 30
  days). `retryJob` ("Tạo lại") rebuilds the failed job's request with `retryOptions`, fetches its images from the
  `ImageStore` (410 once they are not kept) and goes through the same `startJob`
  (rate limit, store, prune, `202`) and `runJob`, deleting the failed job before it answers; its refusals are
  in [../AGENTS.md](../AGENTS.md#retrying-ai-requests). Validation, auth and rate-limit
  errors are still answered synchronously with the plain-text bodies below. `title` (query, capped at
  100 runes) names the job. `listJobs` returns the user's jobs newest first (JSON `{"jobs": [...]}`,
  the CSV included, and `retryable`/`retryUntil` from `retryState`) after failing as abandoned any running job
  whose heartbeat is older than `abandonedAfter` (3 min; and refunding its call), giving a High intelligence job
  `resumeGiveUp` (10 min) when there is a High intelligence server, which takes it over (`resume.go`), and waking
  that server when such a job waits (`HighIntelligenceServer.Wake`, at most once a minute). While `runJob` works,
  `keepJobAlive` records the job's heartbeat (`Jobs.Heartbeat`) every `jobHeartbeatInterval` (30 s), so only a job
  whose process died is failed, whichever server ran it and however long it takes. A creative job at High
  intelligence goes to `HighIntelligenceProxy` before any of this when one is set (`isHighIntelligence`, from the
  query; `retryJob` decides from the failed job, before looking for its images). Both modes take an optional `language` (`csvgen.ParseLanguage`, see
  [Chinese and English](../AGENTS.md#chinese-and-english)), which picks the prompts and is kept on the job.
  `isCreative=true` switches to the creative prompt and requires `exportType`,
  `courseType` (one of the language's courses), `lessonNumbers`, plus `level` (HSK/YCT) or `courseName` (`Other`), and for GestureQuiz the
  optional `gestureStages` and `questionsPerStage` (see [Choosing the games](../AGENTS.md#the-gesture-quiz-game)) — parsed by
  `csvgen.ParseCreativeOptions` (400 with the message on failure). `lessonNumbers` is a comma-separated list
  of distinct lessons, each 1 or more, in any order (kept ascending in `Options.LessonNumbers`). A missing or
  bad list is 400 `Invalid or missing lessonNumbers
  parameter.`, more than `MaxLessons` (5) is 400 `At most 5 lessons per quiz.`, and for a textbook with embedded
  lessons (below) each must be at most its lesson count: 400 `Lesson must be 1 to <M> for <title>.`, e.g.
  `Lesson must be 1 to 15 for 《新HSK教程2》.` Images are optional only in
  creative mode. Each file part's type is sniffed from its bytes (`detectImageType`), never taken from the part's
  `Content-Type`: PNG, JPEG, WebP and GIF pass, anything else is 400 `Unsupported image type.`, checked while the
  body is read, before any query parameter. The LLM call runs under `LLM_TIMEOUT_SECONDS`; hitting it fails the job with
  `errorStatus` 504 ("AI generation timed out."), other LLM failures with 502. The job also gets an
  `errorCode`, the reason the client words its message by: `timeout`, `nothing_to_play` (handler), `interrupted`
  (`store.ExpiredJobCode`), or `csvgen.FailureCode`'s `truncated`, `filtered`, `provider_config`, `overloaded`,
  `bad_output`, `failed`. These codes are a contract with `Client/src/models/ai-job.ts`: never rename one. Either
  failure refunds the rate-limit slot (`RefundAICall`) so the user can resubmit without losing quota. See [../AGENTS.md](../AGENTS.md#the-two-ai-generation-modes) for the client half.
- **Assignments** (`assignment_handlers.go`, the teacher's side of "Giao bài"): `POST assignments`,
  `GET assignments`, `GET`/`PATCH`/`DELETE assignments/{id}` and `DELETE assignments/{id}/players/{playerId}`,
  wrapped like the csv routes (`csvRoute`, i.e. `authenticate` + `requireRole`). Every lookup is scoped to the
  caller's username, so someone else's assignment is a 404 `Assignment not found`, never a 403. The order of
  `createAssignment`'s checks is part of the contract: the payload first (`readJSON`'s 400s, then label ≤ 60
  runes, time mode, stage lock, closing time in the future and ≤ 180 days ahead, pass percents (keys `"1"`–`"6"`,
  plain integers 10–100), replay limit, board setting, pinyin setting: 400 `Label is too long.`, `Invalid time
  mode.`, `Invalid stage lock.`, `Invalid closing time.`, `Invalid pass percents.`, `Invalid replay limit.`,
  `Invalid board setting.`, `Invalid pinyin setting.`), before anything is read from the database. `showBoard` and
  `showPinyin` are read raw (`parseOptionalBool`): absent or `null` is the default (`true` for the board, `false`
  for the pinyin), a JSON boolean is kept, anything else (`"false"`, `0`, an object) is the 400. Then the
  100-per-user cap (409 `Too many assignments.`); then the job through `Jobs.Get` (404
  `Job not found`, or 409 `Job is not a finished gesture quiz.` unless it is `done`, `creative` and
  `exportType` GestureQuiz, and the same 409 when `gesturequiz.Parse` finds no playable question in its CSV). So
  a user at the cap gets the 409 even for a job id that does not exist. `stageCounts` is the server's own count
  of each stage from that parse (a `stageCounts` in the body, which older pages send, is ignored), and a pass
  percent for a stage the quiz does not have is dropped. It copies `job.Title` and `job.CSV`, draws the id
  (`newID`) and the code (`newShareCode`: 10 characters of Crockford base32 from `crypto/rand`) and retries on
  `ErrDuplicate` up to 3 times. `listAssignments` leaves the CSV out and adds each `playerCount`;
  `getAssignment` adds the CSV and `buildLeaderboard`'s output (`leaderboard.go`, one `leaderboardEntry` per
  player, with the player's `avatar`) to the same view, and both answer
  `Cache-Control: no-store`, as the client polls the detail. `patchAssignment` reads the body as a map of raw
  values, so an absent key (leave it) differs from `null` (clear `closesAt`; a `null` label, `closed` or
  `showPinyin` is a 400 `Invalid payload`, as is a `showPinyin` that is not a JSON boolean); `showPinyin` is
  stored as `showPinyin: true` or removed (`$unset`), the store's `AssignmentUpdate.ShowPinyin`; `closed: true` closes now unless it was already closed by hand (the first moment is
  kept, so the result grace does not slide), and `closed: false` is refused (400 `Invalid closing time.`) if the
  closing time that would remain, the old one or the one in the same request, is not in the future.
  `deleteAssignmentPlayer` loads the assignment first only to check the caller owns it, since the store's
  player methods do not know owners.
- **Share** (`share_handlers.go` and `run_handlers.go`, the students' side): `GET share/{code}`,
  `POST share/{code}/players`, `PATCH share/{code}/player`, `GET share/{code}/leaderboard` and a run's three
  routes, `POST share/{code}/runs`, `POST share/{code}/runs/{runId}/next` and `POST share/{code}/runs/{runId}/answers`.
  They are registered bare, with no `authenticate`, and must never answer 401
  (the SPA's interceptor would answer that with a token refresh): a student's credentials are the code and,
  for everything done as a student, the `X-Player-Token` header. The order of checks, which decides the status
  when several things are wrong: the code is trimmed and upper-cased and looked up (404 `Assignment not found`)
  in all of them. `getShared` then answers 410 `Assignment closed` unless `OpenAt(now)`, else `{title, label,
  timeMode, stageLock, stageCounts, passPercents, maxAttempts, showBoard, attempts, results, closesAt}`, with
  `no-store` on every answer, errors included, since a close must show at once. It holds no question: the CSV
  never reaches a student. With a known token, `attempts` is the player's runs started per stage
  (`max(Started[s], Stages[s].Attempts)`, the second for players from before runs were dealt by the server) and
  `results` their best finished run of each stage of the assignment, `{correct, total, passed}`; both are `{}`
  for no or an unknown token.
  `joinShared` refuses a closed assignment (410) before it reads the body, then `cleanPlayerName` (400
  `Invalid name.`: trimmed, whitespace runs folded, 1–40 runes, no control characters), then the optional
  `avatar` (400 `Invalid avatar.` when it is not empty and not in `avatarIDs`, `avatars.go`, so a bad avatar on
  a full assignment is a 400, not a 409), then the 300-player cap
  (409 `Assignment is full`), then `CreatePlayer` (409 `Name taken` on `ErrDuplicate`); it mints a token of 32
  random bytes (base64url), stores only `hashKey(token)` (`respond.go`: SHA-256, base64url, the same as the refresh
  tokens; `auth` keeps its helper unexported) and answers 201 `{playerId, token, name, avatar}` (`avatar` is `""`
  when none was sent). The avatar set is the 24 animal ids of `avatarIDs`, which the client's `AVATARS`
  (`Client/src/models/avatar.ts`) mirrors in the same order, kept in step by hand; `validAvatar` matches an id
  exactly and `TestAvatarIDsAreThePinnedSet` pins the list. `updateSharedPlayer` (`PATCH share/{code}/player`) is
  a student changing their own avatar; its checks run in this order: the code (404 `Assignment not found`),
  `OpenAt(now)` (410 `Assignment closed`; no result grace here), the `X-Player-Token` header (403 `Unknown
  player` when missing or unknown), `readJSON`'s 400s, then 400 `Invalid avatar.` unless the avatar is in the
  set (unlike joining, empty is refused: there is no way back to none), then `SetPlayerAvatar`, where
  `ErrNotFound` (the teacher removed the student meanwhile) is also 403, and 200 `{playerId, name, avatar}`.
  The player is always the token's, never one named in the body. `sharedLeaderboard`
  (`GET share/{code}/leaderboard`) is the class's board for a student: `Cache-Control: no-store` on every
  answer, 404 for an unknown code and **no open check**, so a closed assignment still answers and the students'
  closed card can show the final board. When the teacher hid the board (`HideBoard`), it answers 404 `Board
  hidden` right after the code lookup, before the token is read, open or closed. A 404 rather than an empty
  board, because an empty one reads as "nobody has a result yet", which is untrue, and because the one client
  page that cannot know the setting (a link already closed when opened) needs a final answer to stop polling;
  never 401 or 403, like every student route (the client forgets a student's identity on a 403). An optional
  `X-Player-Token` names the reader; a missing or unknown
  one only makes `you` null (never 401/403; a store error other than `ErrNotFound` is a 500). It answers 200
  `{top, you, possible, stageCount, playerCount}` from `newStudentBoard` (`leaderboard.go`, pure and tested
  on its own): `top` is the ranked entries with rank 1 to 5 in leaderboard order, at most 10 rows (a tie for
  5th adds rows, and a class tied for 1st is cut at 10), `[]` when nobody has a result, each row
  `{rank, name, avatar, stagesPassed, correct, you}`; `you` is the reader's own `{rank, name, avatar,
  stagesPassed, correct}` with `rank` null when they have no result, or null for no or an unknown token;
  `possible` is the sum of the stage counts, `stageCount` their number, `playerCount` everyone who joined. No
  player id appears anywhere in it. Nothing limits joins by IP, by design; the 300 cap and unique names are the
  only brakes.
- **Runs** (`run_handlers.go`): the server plays a student's stage, so the browser never holds an answer, a
  clock it could change or a score it could make up. Every answer is `no-store`, and the checks run in this
  order: the code (404), the assignment (410 `Assignment closed`: `startRun` needs `OpenAt(now)`, `nextQuestion`
  and `answerQuestion` only `AcceptsResultsAt(now)`, the 5-minute `store.ResultGrace`, so a run in progress at
  the close can finish), the token (`requestPlayer`: 403 `Unknown player` when missing or unknown), then the
  route's own. Each change goes through `Assignments.UpdatePlayer` on fresh data, with the handler's sentinels
  (`errStageLocked`, `errReplayLimit`, `errRunGone`, `errRunOver`, `errInvalidAnswer`, `errAlreadyAnswered`)
  coming back unchanged; its `ErrNotFound` (the teacher removed the student meanwhile) is 403 too.
  - `startRun` (`POST share/{code}/runs`, `{stage}`): 400 `Invalid stage.` for a stage not in `stageCounts` or
    with no question in `gesturequiz.Parse(a.CSV)`; then, inside the update, 409 `Stage locked` (`sequential`
    lock and a lower stage of the assignment not passed, `lowerStagesPassed`) and 409 `Replay limit reached`
    (runs used, `max(Started[s], Stages[s].Attempts)`, at `maxAttempts`). `dealRun` shuffles the questions
    (`math/rand/v2`), the options of stages 2–5 and the chunks of stage 6 (`ShuffleChunks`), keeps stage 1 as
    `Đúng`, `Sai`, and serves the first question now; the run replaces `Player.Run`, `Started[s]` goes up by one
    and the answer is 201 `{runId, stage, total, attempts, question}`.
  - `nextQuestion` (`POST …/runs/{runId}/next`): 404 `Run not found` unless the run is the player's `Run`, 409
    `Run is over` once it finished; serves the first unanswered question, writing its `ServedAt` only the first
    time, so asking again never resets its clock. 200 `{question}`.
  - `answerQuestion` (`POST …/runs/{runId}/answers`, `{index, choice}`, both read raw): 404 `Run not found`, then
    400 `Invalid answer.` for an index or choice that is not an integer / null / array of strings (a missing
    `choice` key too) or an index that is neither answered nor the served question in play. An answered index
    is a resend: `writeVerdict` rebuilds its stored verdict and nothing is written. Otherwise `judgeAnswer`
    times it (`timedOut` for a null choice, or later than `ServedAt` + the stage's limit (`GAME_STAGE_SECONDS` with the time mode applied) +
    `answerGrace`, 5 s), compares it with the parsed question found by `RunQuestion.Item` (`isRightChoice`: the
    option shown at that index, or the chunks in order as text) and, on the last question, finishes the run in
    the same write: `resultOf` counts it, `passed` is `correct >= passMark(total, percent)` with the assignment's
    percent for the stage (`passPercentOf`, 70 when unset; `passMark(n, percent) = (percent*n+99)/100`, at 70
    equal to the client's `Math.ceil(0.7 * n)`, `TestPassMark` checks up to 300), and `store.MergeRun` keeps the
    best. The answer is `{correct, timedOut, correctIndex | correctOrder, answer, explanation, result}`, `result`
    only on the last question of a finished run.
  - A question as dealt (`sharedQuestion`) is `{index, question, options, chunks, timeLeftMs, graceMs}`: never
    the answer or the explanation. With the assignment's `ShowPinyin` (read on each request, so the teacher's
    switch applies from the next question) `questionOf` adds `questionPinyin` and `optionPinyins`/`chunkPinyins`,
    found by each shown text in the parsed question; without it the three keys are left out (`omitempty`). A run whose `Item`s no longer match the parse (only a parser change between
    deployments could do it) is logged and answered 404 `Run not found`, which makes the page start over.

`Server.Now` is the clock the assignment and share handlers read (nil means `time.Now`; they call `s.now()`),
so a test can step through a closing time or the grace period without waiting. The other handlers still read
`time.Now` directly.

Shared handler helpers, to reuse rather than repeat: `respond.go` (`writeText`, `writeJSON`, `readJSON`,
`noStore`, `internalError`, `hashKey`), `lookups.go` (`callerName`, `ownedJob`, `ownedAssignment`,
`isFinishedJobOf`, `jobStoreReady`), and for the student routes `share_handlers.go`'s `sharedAssignmentWhile`
(the code's 404 then the 410 for a state such as `(*store.Assignment).OpenAt`), `requestPlayer` (403) and
`optionalPlayer` (a missing or unknown token is nil, never an error). `job_options.go` holds `newJob` and
`retryOptions`, the two mirror images of what a job keeps of its request: a new job setting goes into both, and
`TestJobOptionsRoundTrip` checks them together.

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
the stored field names) beside unit tests of `OpenAt`, `EffectiveClose`, `AcceptsResultsAt`, `UpdatePlayer`
(concurrent writers, an error that writes nothing, the fields it writes) and `MergeRun`;
`jobs_test.go` covers `Jobs.Get`. `api/assignments_api_test.go` drives the HTTP handlers over the memory stores
with a `testClock` (`env.clock.Advance`) as `Server.Now`: the whole flow (create, share, join, play, leaderboard,
close, the grace period, reopen, remove a student, delete), every error status and
body, ownership, `TestTeacherRoutesNeedALogin`, `TestStudentRoutesNeverAnswer401` (with bad `Authorization`
headers too, the avatar, student-leaderboard and run routes included), the limits, `TestPassMark`, the avatar rules of
joining and of `PATCH share/{code}/player`, the students' board end to end (hidden too) and store failures answering 500.
`api/runs_api_test.go` plays runs of all six games: no answer or explanation before the verdict, the shuffles,
right, wrong, null and late answers (at the limit plus the grace, the `extra` and `unlimited` modes), resends,
`next` asked twice, a run replaced by another, the stage lock, the replay limit with runs left unfinished, the
grace after a close, racing duplicates and store failures.
`gesturequiz/quiz_test.go` ports the client's parser spec.
`api/leaderboard_test.go` tests `buildLeaderboard` and `newStudentBoard` as plain Go, `api/avatars_test.go`
pins the avatar ids, and `config/config_test.go` the new collection settings.

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
  What differs by language is in `prompts/chinese/` and `prompts/english/`, loaded per `Language` into
  `languagePrompts` (`language.go`) when the package loads (a missing file or block panics): `simple_system.txt`, the
  `{{define}}` blocks of `creative.txt` and `gesture_quiz.txt`, and the six rules of `gesture_quiz_stages.txt`. The
  shared files are templates that the blocks fill in, with `.Lang`, `.ALang`, `.ALangCapital` and `.Forms`
  (`pinyin` / `spelling`) for the one-word differences. Rewording the shared text changes both languages.
  `creative_system.txt` is the long teacher prompt shared by every platform, and a platform's
  `exportTypeMessages` case sends its column line and, as a message of its own, `wayground_template.txt` for
  Wayground or what `buildGestureQuizMessage` builds for GestureQuiz. The Game message holds the whole format: the stages the teacher chose, which row shape each
  one takes, how to classify a question by its real difficulty into a stage, exactly `QuestionsPerStage` rows
  per stage grouped by stage, the pinyin of the question and of every answer in a column of its own (never in
  the text, and empty where it would give the answer away), and a Vietnamese Explanation on every row. It is
  built from two files:
  `gesture_quiz_template.txt`, a `text/template` (`missingkey=error`) with the framing and its variants (one
  stage or several, some stages left out, any stage with options) and the language's blocks (option length, the
  pinyin columns, the Explanation), and the language's `gesture_quiz_stages.txt`, the six
  tuned stage rules, one paragraph each starting `Stage N – `, of which only the chosen ones are sent word for
  word (the file is checked when the package loads and a malformed one panics). With the defaults (all six,
  5 each) it reads like the original one-file prompt apart from the counts. The message
  replaces the usual "mixture of difficulty" (two sentences in `creative_system.txt` step aside when
  a template defines stages or its own ordering format). The client plays those rows, so see the stage table in
  [../AGENTS.md](../AGENTS.md#the-gesture-quiz-game) before changing the template.
- **Textbook lessons** (`textbooks.go`, `textbooks/<book>/lesson-NN.md`, embedded with `go:embed textbooks`).
  For eight books the teacher need not send photos, nor leave the model to rebuild the lesson from memory:
  the curated document of the lesson is sent as a **LESSON MATERIAL** message. The books are the hand-kept
  `textbookRegistry` (`dir`, title, `CourseType`, `HskStandard`, level and the pinned **lesson count**):
  `hsk2-1`, `hsk2-2`, `hsk2-3` (HSK 2.0 levels 1 to 3, 15, 15 and 20 lessons, their own `hsk2` series: a learner of level 2 knows the level 1 book), `hsk3-1`, `hsk3-2`, `hsk3-3` (HSK 3.0 levels 1 to 3, 15, 15 and 18 lessons, one series: a learner of level
  N knows the lower books) and `yct-6` (YCT level 6, 15 lessons, alone; YCT 1 to 5 have no material and the
  learner is assumed to know them) and `vocab10` (the English vocabulary review "Ôn tập từ vựng lớp 10",
  `CourseType` `VocabReview10`, 8 topics as lessons, no level: its `level` is 0, `textbookFor` ignores the request's
  level for it, and the request's `level` is optional for it as for `Other`; its Known vocabulary list is joined with
  ", " instead of "、", and its `quizGuidance` ("Keep the quiz easy: …") is sent with the course and lesson in every
  request; any book may carry one). The client mirrors the registry in `Client/src/models/textbook.ts`, so
  adding a book or a lesson means changing the folder, the registry and that file together. `textbookFor`
  matches `CourseType` + (HSK only) `HskStandard` + `*Level`; `Other` and HSK 2.0 above level 3 never match, and neither does
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
    `yct-6` ends with a sentence that the learner also knows the words of YCT levels 1 to 5. Several lessons make
    one message, `…, lessons 3, 4 and 5 of M, …` and their documents in order; the known words are then those of
    the book's lessons before the last chosen one that were not chosen. With one lesson every message is exactly
    what it was before several could be chosen.
  - **The request** (`buildCreativeRequest`): the input parts are the intro, `exportTypeMessages`, the Course /
    Level / Lesson number messages (`Lesson numbers: …` with one more sentence asking for one quiz over all of
    them, for several), the material, then the images. The intro says the material is the lesson
    (with images: that the images show the part to focus on; for several lessons, it asks for one CSV covering all
    of them); for any course without a book the request is
    exactly what it was before (`TestBuildCreativeRequestWithoutLessonMaterial`). Token caps and the
    `web_search` tool are unchanged. `creative_system.txt`'s LESSON SOURCE has a case for each of material,
    only images and neither, after a paragraph on several lessons (one quiz, questions spread over the lessons and
    mixed, the unchosen earlier lessons known): with material the model tests only the New words (no ★ word or proper noun as the
    target), takes pinyin and meanings from the table, builds sentences from the Language points and Texts,
    and draws distractors only from the lesson and the Known vocabulary; the web search tool stays for
    illustrations and is never used to look the lesson up.
- `post` retries transient failures of the LLM provider (DeepSeek): 429, 500, 502/503/504, transport
  errors, and generations interrupted inside a 200 (`interruptedError`: chat `finish_reason`
  `insufficient_system_resource`/`aborted`, a response with `status` `failed`, a stream `error` event, a
  stream that ends early or stalls for `stallTimeout` (90 s) once started, a plain body of only the
  keep-alive blank lines), up to 5 attempts within the caller's deadline; this is the only retry layer
  (the client does not re-send) — see `retry.go` and [../AGENTS.md](../AGENTS.md#retrying-ai-requests).
  Both endpoints are called with `stream: true` (`stream.go`: `streamCompletion`, `streamResponse`); a
  `text/event-stream` answer is read event by event, anything else whole (`parseCompletion`,
  `parseResponse`), in each attempt. `GenerateWithProgress` reports the CSV rows written so far
  (`rowCounter`), which `runJob` stores on the job (`Jobs.Progress`, throttled to every 3 s). Non-2xx answers become `*StatusError` (status, `error.code`, `Retry-After`); each
  attempt's `x-request-id` is logged.
- `ExtractCSVContent` strips code fences / leading prose the model sometimes adds.
- Every CSV (both modes, not Radicals) is checked before the job stores it (`quoting.go`, `checkedCSV`). The
  prompts ask for every cell in double quotes; `normalizeCSV` reads the answer leniently (`readCSV`) and writes
  it back with every cell quoted, fixing on its own only what cannot move text between cells (missing
  quotes around comma-free cells, bare quotes, spaces, blank rows, extra empty trailing cells, and missing
  ones only when the row's cells are all quoted, since a short row with a bare cell may hide an unquoted
  comma). A row it cannot split into the export type's columns (`creativeColumns`, which `exportTypeMessages`
  also sends; `Câu hỏi,Đáp án` for the simple mode) — an unquoted comma, an unclosed quote — gets one repair call
  to the same model and endpoint (`prompts/csv_repair.txt`, no tools, counted in `Usage`), skipped when less
  than `minRepairBudget` (20 s) is left; a CSV still wrong after it fails the job as `bad_output`.
- The creative mode uses the Responses API because Wayground requests carry the `web_search` tool:
  the model searches Pexels for the Image Link column and builds `images.pexels.com` URLs from the
  photo IDs it finds (Wikimedia is banned; Wayground cannot load it). Other platforms have no image
  column and get no tool and the lower output cap (32000 tokens; Wayground's, `maxOutputTokensLarge`, is
  64000), except a GestureQuiz of more than 30 rows (`gestureRowsInBaseBudget`, the default six stages of
  five), which gets 64000 too, since up to 60 rows plus the model's reasoning may not fit in 32000
  (`TestGestureQuizTokenBudget` pins this). An `incomplete`
  response (output token cap hit), like a chat completion that finished with `length` or
  `content_filter`, fails the call rather than returning cut-off rows. The `OPENAI_BASE_URL` provider
  must support `/responses` with `web_search`, and requires `max_output_tokens` to be set.

Jobs (`internal/store/jobs*.go`): `store.Jobs` is implemented by `MongoJobs` (collection
`MONGODB_JOBS_COLLECTION`) and `MemoryJobs` (tests), and every method is scoped to a username. A `Job`
holds the request's metadata (title, mode, export type ordinal, intelligence, image count — never the
images — and, for a creative job, the lesson: course type ordinal, course name, HSK standard, level and
lesson numbers (`lessonNumbers`), which `listJobs` returns so the client can filter by them, and for a GestureQuiz job its
`gestureStages` and `questionsPerStage`, kept so `retryJob` can ask for the same quiz again), `status` (`running`/`done`/`failed`), the raw model `csv`, for a Radicals job its `source` (what csvgen rebuilds the exercise from), `errorStatus`/`errorCode`/`errorMessage`,
`usage` (model, calls including retries, input/cached/output tokens, duration; stored for the admin, never sent
to the client), the rate-limit `roundStart` (for refunds), `heartbeatAt` (see `listJobs` above) and timestamps.
`Complete`/`Fail`/`Progress`/`Heartbeat` only touch a job that is still `running`, so an expired job is never
revived by a late answer; `Prune` never deletes a running job. `ExpireRunning` fails the running jobs whose
`heartbeatAt` (or, before the first heartbeat, `createdAt`) is before the cutoff.
`Revise(username, id, csv, source)` replaces the result of a `done` job only (`ErrNotFound` otherwise). `List` leaves
the `source` out (Mongo projects it away), since the history never needs it.
`Get(username, id)` returns one job, `ErrNotFound` for another user's too (`createAssignment` is its caller).
`MongoJobs.EnsureIndexes` (username + createdAt) is, like the users' one, not called on start.

Assignments (`internal/store/assignments*.go`): `store.Assignments` is implemented by `MongoAssignments` and
`MemoryAssignments` (tests), and holds two kinds of document. An `Assignment` (collection
`MONGODB_ASSIGNMENTS_COLLECTION`, `_id` a random hex id) is the snapshot of a job: owner `username`, `jobId`,
`title`, the raw `csv`, `label`, `timeMode` (`standard`/`extra`/`unlimited`), `stageLock` (`sequential`/`open`; empty on old documents, read as `sequential` by `stageLockOf`), `passPercents` (stage → percent; stages or whole map missing read as 70 by `passPercentOf`), `maxAttempts` (nil = unlimited), `hideBoard` (true when the teacher hid the students' board; left out when false, so old documents show it; the API sends it as `showBoard`), `stageCounts` (stage → number of
questions), `createdAt`, the public `code`, and two optional times, `closesAt` (scheduled) and `closedAt` (by
hand), left out of the document when unset. It is copied rather than referenced so deleting a job, or the
newest-30 prune, cannot break a live link. `OpenAt(now)` is "`closedAt` unset and `closesAt` unset or ahead";
`EffectiveClose` is the earlier of the two, and `AcceptsResultsAt(now)` is open, or no later than the effective
close plus `ResultGrace` (5 minutes). A `Player` (collection `MONGODB_PLAYERS_COLLECTION`) is a student of one
assignment: `assignmentId`, `name`, `avatar` (the id of the avatar the student picked; left out of the document when
empty, which is also how a player from before avatars reads), `nameKey` (the lower-cased name, unique within the
assignment), `tokenHash` (never the token), `joinedAt`, `lastPlayedAt`, `stages` (the best finished run of each stage:
`correct`, `total`, `attempts`, `passed`, `bestAt`), `started` (stage → runs started, which is what the replay
limit counts; left out while empty), `run` (the latest `Run`, active or finished: its `id`, `stage`, `startedAt`,
`finishedAt` and the `questions` in the order asked, each with the `item` it is in the stage's parsed list, the
`options` or `chunks` as shown, `servedAt`, `answeredAt`, `correct` and `timedOut`; no answer text, which is
looked up in the quiz by `item`) and a `version`. Documents from before runs may still hold a `runIds` array,
which nothing reads. Players are a collection of their own,
not an array on the assignment, so many students finishing a stage at the same moment write different
documents. The interface's teacher-side methods (`Get`, `List`, `Count`, `Update`, `Delete`) take the owner's
username, so another user's assignment is `ErrNotFound`; `GetByCode` and the player methods (`CreatePlayer`,
`CountPlayers`, `ListPlayers`, `PlayerByToken`, `UpdatePlayer`, `SetPlayerAvatar`, `DeletePlayer`) work from the public code or the
token and leave authorization to the handlers. `List` leaves the CSV out, and `ListPlayers` the `run` (Mongo
projects it out; the leaderboard never needs it); `Delete` removes the players too
(in Mongo only after the assignment itself went, so deleting someone else's cannot wipe its players); `Update`
takes an `AssignmentUpdate` where each time is a `TimeChange{Set, Value}` (not set: unchanged; set with a nil
value: cleared, i.e. `$unset`).

- `UpdatePlayer(ctx, assignmentID, playerID, change)` is the one read-modify-write of a player's play: it reads
  the player, calls `change` on a copy (with non-nil `Stages` and `Started`), and writes back `stages`,
  `started`, `run` and `lastPlayedAt` only. Mongo does it like `UpdateSessions`: write only where `version` is
  unchanged (`$inc`), `$unset` a field that came out empty, retry up to 5 times, else `ErrConflict`; this keeps
  two requests of one student at the same moment (two tabs, a double tap, an answer racing the next question)
  from overwriting each other. The memory store does it under its mutex. `change` may run more than once, and
  an error from it writes nothing and comes back unchanged, which is how the run handlers refuse on fresh data.
- `MergeRun` folds a finished run into `stages`, the same on both stores: the stage's `correct` rises only if
  the run beat it (`bestAt` moves then), a pass once made stays (and sets `bestAt` when it first happens), and
  `attempts` becomes the runs started (`max` with what it was, for players from before `started`).
- `SetPlayerAvatar` replaces the avatar and nothing else, `ErrNotFound` when that player is not in that
  assignment. Mongo does it as one `UpdateOne` with `$set: {avatar}` and no version bump: `UpdatePlayer` `$set`s
  only `stages`, `started`, `run` and `lastPlayedAt`, so the two writes touch different fields and cannot undo each other.
  The store keeps whatever avatar it is given; the API validates against `avatarIDs`.
- Times are stored as UTC milliseconds (`storedTime`), the precision MongoDB keeps, and both implementations
  copy and normalize through `Assignment.stored()`/`Player.stored()`, so a value reads back the same from
  either (and empty maps and slices are stored as `{}` and `[]`, not `null`). `MemoryAssignments.Now` exists for
  parity with the other memory stores but no method reads it: `UpdatePlayer`'s `change` takes its time from the caller.
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
