# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

QuizTool turns photos of a Chinese (HSK) lesson into a quiz file that can be imported into GimKit,
Blooket, or Wayground. It is one git repo holding two independently built and independently deployed
projects:

- `Client/` — Angular 20 SPA (standalone components, ng-zorro-antd). Deployed to Vercel.
- `Server/` — Azure Functions isolated worker, .NET 10 (`QuizTool`), plus the `QuizTool.Data` class
  library holding the EF Core Cosmos persistence layer. Deployed to Azure Function App `quiz-tool`.

Each half has its own `CLAUDE.md` with the detail for that side — read
[Client/CLAUDE.md](Client/CLAUDE.md) or [Server/CLAUDE.md](Server/CLAUDE.md) before working inside
either directory. This file covers only what spans both.

There is no root-level build, no workspace/solution tying the two halves together, and no shared code or
generated client — the contract between them is hand-written on both sides and must be kept in sync
manually.

## Commands

Client (run from `Client/`):
```bash
npm start        # ng serve → http://localhost:4200
npm test         # Karma + Jasmine (only spec: csv-import.service.spec.ts)
npm run build    # runs scripts/set-env.js first (prebuild), then ng build
```

Server (run from `Server/`):
```bash
dotnet build QuizTool.slnx
dotnet run --project QuizTool/QuizTool.csproj   # Functions host on http://localhost:7071
```

Running the full app locally means starting both: the SPA on 4200 and the Functions host on 7071.
There are no tests on the server side.

## The client/server contract

All Functions routes are prefixed `/api` by the Functions host. The client builds every URL as
`${environment.apiUrl}/api/...`:

| Client caller | Server endpoint |
|---|---|
| `AuthApiService.login` / `.refreshToken` | `auth/login`, `auth/refresh` (`TokenController`, anonymous) |
| — (no client caller) | `auth/logout`, `auth/logout-all` (`TokenController`) |
| — (admin/Function key only) | `users` (`UsersController`, `AuthorizationLevel.Admin`) |
| `AiCsvService.generateCsvFromImages*` | `csv/generate-from-image` (`CsvGenerationController`) |

Two things make the wiring non-obvious:

- **Cross-origin by design.** Client and server are always on different origins (4200/7071 locally,
  Vercel/Azure in production), so every auth-relevant request sets `withCredentials: true` and the
  server sets the refresh token as an `HttpOnly; Secure; SameSite=None` cookie. Changing origins,
  cookie flags, or CORS config breaks the silent-refresh-on-boot flow in `app.config.ts`.
- **Auth is split across two mechanisms.** The access token is a Bearer JWT the client attaches via
  `AuthInterceptor`; `CsvGenerationController` validates it by hand inside the method body
  (`JwtAuth.ValidateToken`), since Functions isolated worker has no `[Authorize]` middleware here.
  The refresh token lives only in the cookie and is never in a JSON body.

### Backend URL configuration

`Client/src/environments/environment.ts` (dev) hardcodes `http://localhost:7071`.
`environment.prod.ts` is **generated at build time** by `Client/scripts/set-env.js` (npm `prebuild`
hook) from the `API_URL` env var, which Vercel injects from Project Settings per environment. So the
production backend URL is not in source — do not hand-edit `environment.prod.ts`, and remember that
a local `npm run build` without `API_URL` set silently produces a bundle pointing at
`https://localhost`.

## The two AI generation modes

This is the one feature that only makes sense by reading both sides. The image-import popup
(`ImageImportPopup`) offers `AIGenerationMode.Formatted` and `AIGenerationMode.Auto`, and they take
completely different paths through the system:

- **`Formatted`** → `POST csv/generate-from-image` with no query params → server's
  `SimpleWordQuestionService` (`ISimpleWordQuestionService`) prompt (two columns, `Câu hỏi`/`Đáp án`) → client parses the CSV
  with `CsvImportService.parseCsv` and **emits rows into the vocabulary table**, where the user edits
  them and later exports via `FileExportService.exportFile` (client-side builders synthesize the
  distractors).
- **`Auto`** (sent as `isCreative=true`, alongside required `exportType`, `hskLevel`,
  `lessonNumber`) → server's `CreativeRequestService` (`ICreativeRequestService`), a long HSK-teacher prompt that is told the exact
  column layout of the *target platform* via `GetAdditionalUserMessagesForExportType` and asked to
  return **rows without a header** → client never touches the table: it prepends the header through
  `CsvBuilderBase.buildFromCsvContent` and downloads immediately.

Consequences to keep in mind when changing anything here:

- The `ExportType` enum exists twice (`Client/src/models/export-type.ts` and
  `Server/QuizTool/Models/ExportType.cs`) and is passed over the wire **by ordinal**. Adding or
  reordering a member on one side silently mis-maps the other.
- Adding a new export platform means three coordinated changes: a client `CsvBuilder` (with a
  `CsvHeader` matching what the platform expects on import), a `GetAdditionalUserMessagesFor…` case
  on the server describing the same columns to the LLM, and the enum entry on both sides.
- Export output format is per-platform: GimKit and Blooket download as `.csv`, Wayground is converted
  to `.xlsx` via `xlsx` before download (`FileExportService.download`).

## Rate limiting

AI calls are capped per user (`CALL_COUNT_ACCEPTED_IN_A_ROUND` per `ROUND_MINUTES`), with the counter
stored on the user's Cosmos document. The client has no matching UI state — it discovers the limit
only as a `403` with a plain-text body from `csv/generate-from-image`, which surfaces as a generic
error notification.
