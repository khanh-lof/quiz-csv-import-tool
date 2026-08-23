# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An Azure Functions (isolated worker, .NET 10) HTTP API. It issues JWTs for login, and uses an LLM
vision call to convert an uploaded image of Chinese vocabulary into a CSV (Vietnamese meaning +
pinyin question / Chinese-character answer), gated by JWT auth and a per-user rate limit stored in
Cosmos DB.

## Commands

Build:
```bash
dotnet build QuizTool.sln
```

Run locally (Azure Functions Core Tools host, port 7071):
```bash
dotnet run --project QuizTool/QuizTool.csproj
```

There are no test projects in this solution currently.

### Local configuration

The Functions host reads settings from `QuizTool/local.settings.json` (gitignored, not present in a
fresh clone — create it yourself). Required app settings, based on env vars read via
`Environment.GetEnvironmentVariable`:

- `JWT_SECRET` (required to issue/validate tokens), `JWT_ISSUER`, `JWT_AUDIENCE` (optional — validation
  of issuer/audience is skipped if unset)
- `JWT_ACCESS_TOKEN_EXPIRES_MINUTES` (default 15), `JWT_REFRESH_TOKEN_EXPIRES_DAYS` (default 30)
- `COSMOS_ENDPOINT`, `COSMOS_KEY` — if either is missing, Cosmos-backed services are not registered
  and auth/user-creation/CSV-generation endpoints that depend on `ICosmosUserRepository` will fail
  DI resolution
- `COSMOS_DATABASE` (default `QuizDb`), `COSMOS_CONTAINER` (no default — must be set for the container
  to resolve correctly)
- `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `LLM_MODEL` — used only by `CsvGenerationController` when
  calling the OpenAI-compatible `/chat/completions` endpoint
- `CALL_COUNT_ACCEPTED_IN_A_ROUND` (default 2), `ROUND_MINUTES` (default 1) — rate limit for AI calls
  per user
- `MAX_REFRESH_TOKENS_PER_USER` (default 5) — cap on concurrent refresh tokens (devices/sessions) per
  user; oldest entries are evicted once a new login would exceed the cap

## Architecture

Three HTTP-triggered function controllers, each a plain class with `[Function(...)]` methods (no
ASP.NET Core controllers/routing — this is the Functions isolated-worker model):

- **`TokenController`** (`auth/login`, `auth/refresh`, `auth/logout`, `auth/logout-all`, anonymous) —
  issues access tokens and rotates refresh tokens via `IAuthenticationService`. Refresh tokens are set
  as an `HttpOnly; Secure; SameSite=None` cookie (see `SetRefreshTokenCookie`), not returned in the
  JSON body. A user can hold multiple concurrent refresh tokens (one per device/session, capped by
  `MAX_REFRESH_TOKENS_PER_USER`); `auth/logout` revokes just the calling device's token, `auth/logout-all`
  revokes every token for that user.
- **`UsersController`** (`users`, requires Function/Admin key via `AuthorizationLevel.Admin`) —
  creates users directly against `ICosmosUserRepository`, hashing passwords with `PasswordHasher`.
- **`CsvGenerationController`** (function name `GenerateCsvFromImage`, route `csv/generate-from-image`,
  anonymous trigger but manually validates a `Bearer` JWT inside the method body) — accepts
  multipart/form-data with one or more image files, enforces the AI-call rate limit
  (`AiCallCountInRound` / `StartRoundTime` on `QuizToolUser`), sends all images in a single
  OpenAI-compatible chat-completions request with base64 `image_url` content parts, and returns the
  parsed CSV as `text/csv`.

  Two request shapes, chosen by the `isCreative` query param (see
  [../CLAUDE.md](../CLAUDE.md#the-two-ai-generation-modes) for the client-side half of this):
  - `isCreative` absent/false → `SimpleWordQuestionService` (`ISimpleWordQuestionService`): a short prompt asking for a
    two-column CSV (`Câu hỏi`/`Đáp án`) with header included.
  - `isCreative=true` → also requires `exportType`, `hskLevel`, `lessonNumber` query params (400 if
    missing/invalid) → `CreativeRequestService` (`ICreativeRequestService`), a long HSK-teacher system prompt, plus
    `GetAdditionalUserMessagesForExportType` appending the exact column layout for the target
    platform (`Models/ExportType.cs`: `GimKit`/`Blooket`/`Wayground`, passed by ordinal — keep in
    sync with `Client/src/models/export-type.ts`). This mode asks the LLM to return rows **without**
    a header, since the client prepends one itself.

Auth flow: `TokenController` → `AuthenticationService` (in `Services/`) → `ICosmosUserRepository`.
`AuthenticationService` resolves `ICosmosUserRepository` from `IServiceProvider` at call time rather
than via constructor injection, since the repository is only registered when Cosmos env vars are
present (see `Program.cs`) — if it's absent, auth always returns `Valid = false` rather than throwing.

JWT handling is split: `JwtTokenIssuer` creates tokens (used by `AuthenticationService`),
`JwtAuth.ValidateToken`/`HasAnyRole` validate tokens and check role claims (used directly inside
`CsvGenerationController`, not via ASP.NET Core auth middleware — there is no `[Authorize]` attribute
pattern here).

`CsvGenerationController.ExtractCsvContent` strips markdown code fences / leading prose from the LLM
response before returning it, since the model isn't always compliant with the "CSV only" system
prompt.

Data model: `QuizToolUser` (`Models/QuizToolUser.cs`) is the single Cosmos document type, partitioned
by `/username`, holding password hash, roles, a list of `RefreshTokenEntry` (one per active
device/session), and AI-call rate-limit state (`AiCallCountInRound`, `StartRoundTime`) in one document.
Refresh-token mutations in `CosmosUserRepository` use ETag-guarded optimistic concurrency
(`MutateUserWithRetryAsync`) since concurrent logins/refreshes from different devices touch the same
document's token list.
