# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

QuizTool turns photos of a Chinese (HSK) lesson into a quiz file that can be imported into GimKit,
Blooket, or Wayground, or into a quiz that QuizTool plays itself as a webcam gesture game
("Quiz cử chỉ"). It is one git repo holding two independently built and independently deployed
projects, plus an optional browser extension:

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

Two things make the wiring non-obvious:

- **Same-origin everywhere, no CORS.** On Vercel the SPA and API are services of one deployment
  (every preview included); locally the `ng serve` proxy puts them on one origin too. The server
  therefore has no CORS handling, and the refresh token is an `HttpOnly; Secure; SameSite=Strict`
  cookie (`Secure` is accepted on `http://localhost`). Serving the SPA and API from different
  origins is not supported: the browser would block the calls and never send the cookie, breaking
  the silent-refresh-on-boot flow in `app.config.ts`.
- **Auth is split across two mechanisms.** The access token is a Bearer JWT the client attaches via
  `AuthInterceptor`; only the `csv/jobs` routes require it, via the `authenticate` +
  `requireRole` middleware wrapped around that route (`Server/internal/api/middleware.go`).
  The refresh token lives only in the cookie and is never in a JSON body.

## The two AI generation modes

This is the one feature that only makes sense by reading both sides. The AI generation page
(`AiGeneration`, route `/ai`) offers `AIGenerationMode.Formatted` and `AIGenerationMode.Auto`, and they take
completely different paths through the system. First, what they share — **AI generation is a job**: `POST csv/jobs`
validates the request, stores a job in MongoDB (`store.Job`, collection `Jobs`, newest 30 kept per user),
answers `202 {"id"}` and keeps working in the same handler, detached from the client's connection, until
the model has answered and the result is saved on the job. The client does not wait for the result: the
`AiGeneration` page shows a "Đã gửi yêu cầu" notice, and the history table below the form (`AiJobs`) shows
the user's jobs from `GET csv/jobs`, which `AiJobService` polls every 3 s while any job runs. A job
finishing is announced wherever the user is in the app. The result is delivered from the table, not on
completion: **Formatted** jobs get a "Mở trong bảng" action, **Auto** jobs a "Tải file" action
and, for a Wayground job, also "Tiện ích tự publish" (the extension; disabled when it is not installed)
or, for a Quiz cử chỉ job, "Chơi ngay" (played in the app, see
[the gesture quiz](#the-gesture-quiz-quiz-cử-chỉ)): the user picks the delivery per job once the AI is done. The table's search covers titles, errors and the generated
CSV; its filters are status, mode, platform, course type, HSK standard, level and lesson number (the server
keeps those on each creative job; jobs from before it did have none and drop out when one is set).

- **`Formatted`** → `POST csv/jobs` (only a `title` query param) → server's simple prompt
  (`Server/internal/csvgen/prompts/simple_system.txt`, two columns, `Câu hỏi`/`Đáp án`) → client parses the CSV
  with `CsvImportService.parseCsv` and **hands the rows to the vocabulary table** (`PendingImportService`,
  then navigates to `/quiz`) when the user clicks "Mở trong bảng" on the job, where the user edits
  them and later exports via `FileExportService.exportFile` (client-side builders synthesize the
  distractors).
- **`Auto`** (sent as `isCreative=true`, alongside `exportType`, `courseType`, `lessonNumber`, and
  `level`/`courseName` depending on the course) → server's creative prompt
  (`csvgen.buildCreativeRequest`, `prompts/creative_system.txt`), a long Chinese-teacher prompt that is told the exact
  column layout of the *target platform* via `exportTypeMessages` and asked to
  return **rows without a header** → client never touches the table: on "Tải file" it prepends the header through
  `CsvBuilderBase.buildFromCsvContent` and downloads (for the Quiz cử chỉ platform the job can instead be
  played in the app, its third delivery). **Images are optional in this
  mode**: with none attached the prompt tells the model to work from the standard word list of the
  identified lesson instead. The lesson is identified by `CourseType` (`Hsk`/`Yct`/`Other`, another
  by-ordinal enum duplicated on both sides), a `level` that is required for HSK and YCT but optional
  for `Other`, a `courseName` required only for `Other`, and a `lessonNumber`. For HSK the user
  also picks the standard, `HskStandard` 2.0 (levels 1–6, the default) or 3.0 (levels 1–9), sent as
  `hskStandard=2|3` by value, not ordinal; the server rejects a level outside the standard's range. Everything the prompt
  needs travels in `csvgen.Options` (`Server/internal/csvgen/options.go`).

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
- Export output format is per-platform: GimKit, Blooket and Quiz cử chỉ download as `.csv`, Wayground is
  converted to `.xlsx` via `xlsx` before download (`FileExportService.download`).

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

## The gesture quiz (Quiz cử chỉ)

`ExportType.GestureQuiz` (ordinal 3 on both sides) is the one platform that is not an import target:
QuizTool plays the quiz itself, as a game in which the learner answers with body gestures in front of a
webcam. For the pipeline it is an `Auto`-mode platform like the others (same `POST csv/jobs`, rate limit,
job and polling); only the prompt and what the client does with the finished job differ. Camera frames
are processed locally in the browser (MediaPipe), nothing is recorded or sent anywhere.

**The CSV contract.** The model returns headerless rows of exactly 7 fields, `Stage,Question,Correct
Answer,Wrong Answer 1,Wrong Answer 2,Wrong Answer 3,Explanation` (an unused column is an empty field),
grouped by stage, 4–5 rows per stage (24–30 rows). The stage, 1 to 6, fixes the row shape and, because the
prompt tells the model to classify each question by its real difficulty (the creative prompt's stage
rules replace its usual difficulty mixture), the difficulty too. The Explanation is one Vietnamese
sentence shown after the answer. The stages are played easiest to hardest, one game each, and a stage is
passed with at least 70% right (`PASS_RATIO` / `passMark`: 4 of 5, 7 of 10), which opens the next one:

| Stage | Game (`GameKind`) | The learner… | Row shape |
|---|---|---|---|
| 1 | Đúng hay sai (`true-false`) | holds a thumb up or down | Correct Answer exactly `Đúng` or `Sai`, no wrong answers |
| 2 | Nghiêng đầu (`head-tilt`) | tilts or leans the head to the left or right card | Correct Answer + Wrong Answer 1 |
| 3 | Ếch đớp chữ (`frog-bite`) | moves the head to a lane and opens the mouth to bite | Correct Answer + Wrong Answer 1–2 |
| 4 | Chém hoa quả (`fruit-slice`) | slashes, with the index fingertip, the fruit whose colour matches the answer | Correct Answer + Wrong Answer 1–2 |
| 5 | Giơ ngón tay (`finger-count`) | shows 1–4 fingers (thumb ignored) for the option's number | Correct Answer + Wrong Answer 1–3 |
| 6 | Xếp câu (`word-order`) | points at word tiles in order, resting on a tile or pinching | Correct Answer = the sentence's chunks in the right order joined by ` / `, no wrong answers |

Stages 1, 4, 5 and 6 read the hand and 2 and 3 the face (MediaPipe's GestureRecognizer and FaceLandmarker);
every game also works with mouse, touch or keyboard, so a quiz is playable without a camera. The server's
`prompts/gesture_quiz_template.txt` (the model must not shuffle: the page shuffles the options and the
chunks itself) and the client's `parseGestureQuiz` (`Client/src/models/gesture-quiz.ts`) with the stage
table `STAGES` (`Client/src/game/stages.ts`) describe this one format from both ends, and, like the
other contracts, are kept in step by hand. The parser is forgiving: a header row is optional and rows that
break their stage's rules are dropped and counted (`skipped`, announced to the player), so a drifting
prompt shows up as missing questions, not as an error. A stage without any questions shows as empty on the
map and does not block the ones after it.

**Entry points.** On a finished GestureQuiz job the AI jobs table shows "Chơi ngay", which navigates to
`/play/<job id>` (login required; the page takes the job from `AiJobService`), and "Tải file", which
downloads `<title>-Quiz-cử-chỉ.csv` with the header prepended. A downloaded file, or the built-in sample
(`Client/src/game/demo-quiz.ts`), is opened on `/play`, which needs no login. The vocabulary table does not
offer this platform: its rows have no stages. Progress (stages passed, best result per stage) is kept in
`localStorage` per quiz, keyed by a hash of the questions rather than the title, so a job and the file
downloaded from it share it; nothing about the quiz or the player goes to the server.

The camera needs HTTPS (or localhost) and the player's permission, and the two MediaPipe models are
fetched from Google's storage on first use. The specs run against fakes and synthetic landmarks, so they
cover the logic but not the recognition: how the real webcam behaves (lighting, distance, the gesture
thresholds) can only be checked by playing on a machine with a camera.

The Client's half (page, engine, MediaPipe loading) is in [Client/AGENTS.md](Client/AGENTS.md#gesture-quiz-play), the
prompt's in [Server/AGENTS.md](Server/AGENTS.md).

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
