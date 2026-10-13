# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

QuizTool turns photos of a Chinese (HSK) lesson into a quiz file that can be imported into GimKit,
Blooket, or Wayground. It is one git repo holding two independently built and independently deployed
projects, plus an optional browser extension:

- `Client/` — Angular 20 SPA (standalone components, ng-zorro-antd).
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
npm test         # Karma + Jasmine (specs: csv-import, image-compression services)
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
(or "Publish Wayground"). The table's search covers titles, errors and the generated CSV; its filters are
status, mode and platform.

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
  `CsvBuilderBase.buildFromCsvContent` and downloads. **Images are optional in this
  mode**: with none attached the prompt tells the model to work from the standard word list of the
  identified lesson instead. The lesson is identified by `CourseType` (`Hsk`/`Yct`/`Other`, another
  by-ordinal enum duplicated on both sides), a `level` that is required for HSK and YCT but optional
  for `Other`, a `courseName` required only for `Other`, and a `lessonNumber`. For HSK the user
  also picks the standard, `HskStandard` 2.0 (levels 1–6, the default) or 3.0 (levels 1–9), sent as
  `hskStandard=2|3` by value, not ordinal; the server rejects a level outside the standard's range. Everything the prompt
  needs travels in `csvgen.Options` (`Server/internal/csvgen/options.go`).

Consequences to keep in mind when changing anything here:

- The `ExportType` enum exists twice (`Client/src/models/export-type.ts` and
  `Server/internal/csvgen/options.go`) and is passed over the wire **by ordinal**. Adding or
  reordering a member on one side silently mis-maps the other.
- Adding a new export platform means three coordinated changes: a client `CsvBuilder` (with a
  `CsvHeader` matching what the platform expects on import), an `exportTypeMessages` case
  on the server describing the same columns to the LLM, and the enum entry on both sides.
- A job outlives the connection that started it only if the host keeps the process alive after the
  client leaves. The handler flushes its `202` early with `Connection: close` and goes on working;
  where the platform buffers the response until the handler ends (Vercel's behaviour for a Go
  service is unverified), the client just gets the `202` late and polling still shows the job. A job
  still `running` well past the LLM deadline (its process died) is failed as "interrupted" and its
  call refunded the next time its owner lists jobs.
- Export output format is per-platform: GimKit and Blooket download as `.csv`, Wayground is converted
  to `.xlsx` via `xlsx` before download (`FileExportService.download`).

## The Wayground browser extension

Wayground has no public API for creating quizzes, so `Extension/` drives Wayground's own spreadsheet
import and Publish in the user's logged-in tab, then hands the quiz's share link back. The SPA side
is `WaygroundExtensionService`:
- Whenever Wayground is the chosen platform (on the table or in `Auto` mode), the page offers a
  `WaygroundDelivery` choice: **Tải file** (download the `.xlsx` for a manual import) or **Tiện ích
  tự publish** (hand it to the extension). The extension option is disabled unless
  `<html data-quiztool-extension>` is present; the choice is shared by both pages and remembered in
  `localStorage` (`wayground-delivery`), defaulting to the extension when it is installed.
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
