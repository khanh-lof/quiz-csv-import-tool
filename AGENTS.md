# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

QuizTool turns photos of a Chinese (HSK) lesson into a quiz file that can be imported into GimKit,
Blooket, or Wayground. It is one git repo holding two independently built and independently deployed
projects:

- `Client/` — Angular 20 SPA (standalone components, ng-zorro-antd).
- `Server/` — Go (`net/http`) API with MongoDB persistence. Runs as a standalone binary / Docker
  image (`Server/Dockerfile`).

Both deploy together as one Vercel project via [Vercel Services](https://vercel.com/docs/services),
configured in the root `vercel.json`: the `client` service (Angular preset, SPA fallback to
`index.html`) and the `server` service (Go preset, which runs `Server/cmd/server` listening on
`PORT`). Top-level rewrites send `/api/*` and `/healthz` to `server` — with the path unchanged, so
the Go mux still sees `/api/...` — and everything else to `client`. The Vercel project's Root
Directory must be the repo root, and the server's env vars (`MONGODB_URI`, `JWT_SECRET`, …) are set
in the same project.

Each half has its own `AGENTS.md` with the detail for that side — read
[Client/AGENTS.md](Client/AGENTS.md) or [Server/AGENTS.md](Server/AGENTS.md) before working inside
either directory. This file covers only what spans both.

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
| — (no client caller) | `auth/logout`, `auth/logout-all` (`auth_handlers.go`) |
| — (admin only, `X-Admin-Key` header) | `users` (`auth_handlers.go`) |
| `AiCsvService.generateCsvFromImages*` | `csv/generate-from-image` (`internal/api/csv_handler.go`) |

Two things make the wiring non-obvious:

- **Same-origin everywhere, no CORS.** On Vercel the SPA and API are services of one deployment
  (every preview included); locally the `ng serve` proxy puts them on one origin too. The server
  therefore has no CORS handling, and the refresh token is an `HttpOnly; Secure; SameSite=Strict`
  cookie (`Secure` is accepted on `http://localhost`). Serving the SPA and API from different
  origins is not supported: the browser would block the calls and never send the cookie, breaking
  the silent-refresh-on-boot flow in `app.config.ts`.
- **Auth is split across two mechanisms.** The access token is a Bearer JWT the client attaches via
  `AuthInterceptor`; only `csv/generate-from-image` requires it, and validates it by hand at the top
  of the handler (`auth.JWT.Parse`) — there is no auth middleware.
  The refresh token lives only in the cookie and is never in a JSON body.

## The two AI generation modes

This is the one feature that only makes sense by reading both sides. The image-import popup
(`ImageImportPopup`) offers `AIGenerationMode.Formatted` and `AIGenerationMode.Auto`, and they take
completely different paths through the system:

- **`Formatted`** → `POST csv/generate-from-image` with no query params → server's simple prompt
  (`Server/internal/csvgen/prompts/simple_system.txt`, two columns, `Câu hỏi`/`Đáp án`) → client parses the CSV
  with `CsvImportService.parseCsv` and **emits rows into the vocabulary table**, where the user edits
  them and later exports via `FileExportService.exportFile` (client-side builders synthesize the
  distractors).
- **`Auto`** (sent as `isCreative=true`, alongside `exportType`, `courseType`, `lessonNumber`, and
  `level`/`courseName` depending on the course) → server's creative prompt
  (`csvgen.buildCreativeRequest`, `prompts/creative_system.txt`), a long Chinese-teacher prompt that is told the exact
  column layout of the *target platform* via `exportTypeMessages` and asked to
  return **rows without a header** → client never touches the table: it prepends the header through
  `CsvBuilderBase.buildFromCsvContent` and downloads immediately. **Images are optional in this
  mode**: with none attached the prompt tells the model to work from the standard word list of the
  identified lesson instead. The lesson is identified by `CourseType` (`Hsk`/`Yct`/`Other`, another
  by-ordinal enum duplicated on both sides), a `level` that is required for HSK and YCT but optional
  for `Other`, a `courseName` required only for `Other`, and a `lessonNumber`. Everything the prompt
  needs travels in `csvgen.Options` (`Server/internal/csvgen/options.go`).

Consequences to keep in mind when changing anything here:

- The `ExportType` enum exists twice (`Client/src/models/export-type.ts` and
  `Server/internal/csvgen/options.go`) and is passed over the wire **by ordinal**. Adding or
  reordering a member on one side silently mis-maps the other.
- Adding a new export platform means three coordinated changes: a client `CsvBuilder` (with a
  `CsvHeader` matching what the platform expects on import), an `exportTypeMessages` case
  on the server describing the same columns to the LLM, and the enum entry on both sides.
- Export output format is per-platform: GimKit and Blooket download as `.csv`, Wayground is converted
  to `.xlsx` via `xlsx` before download (`FileExportService.download`).

## Rate limiting

AI calls are capped per user (`CALL_COUNT_ACCEPTED_IN_A_ROUND` per `ROUND_MINUTES`), with the counter
stored on the user's MongoDB document. The client has no matching UI state — it discovers the limit
only as a `403` with a plain-text body from `csv/generate-from-image`, which surfaces as a generic
error notification.

## Upload size and LLM timeout (Vercel limits)

Vercel functions reject request bodies over 4.5 MB (413) and stop after 300 s by default (504). The
two sides guard against both:

- The client shrinks images before upload (`ImageCompressionService.compressForUpload`): JPEG,
  longest side 2048 px, stepping down in size/quality until the batch fits a 4 MB budget, else it
  refuses the upload itself.
- The server bounds each LLM call with `LLM_TIMEOUT_SECONDS` (default 280, under Vercel's limit) and
  answers `504 AI generation timed out.` The call still counts against the rate limit.
- `ImageImportPopup.showGenerationError` maps 413 (or the client's own refusal) and 504 (the
  server's, or Vercel's own) to messages asking the user to send fewer images or retry.
