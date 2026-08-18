# QuizTool

An Azure Functions (isolated worker, .NET 10) HTTP API that turns a photo of Chinese vocabulary
into a quiz. Users log in with a JWT-based auth flow, upload one or more images, and an LLM vision
call converts the vocabulary into a CSV of questions (Vietnamese meaning / pinyin) and answers
(Chinese characters). AI calls are rate-limited per user, with state stored in Cosmos DB.

## Architecture

Three HTTP-triggered function controllers (Azure Functions isolated-worker model — no ASP.NET Core
controllers/routing):

- **`TokenController`** — `auth/login`, `auth/refresh`, `auth/logout`, `auth/logout-all`. Issues
  access tokens and rotates refresh tokens via `IAuthenticationService`. Refresh tokens are set as an
  `HttpOnly; Secure; SameSite=None` cookie, not returned in the JSON body. Each user can hold multiple
  concurrent refresh tokens (one per device/session); `logout` revokes the calling device's token,
  `logout-all` revokes every token for that user.
- **`UsersController`** — `users` (requires a Function/Admin key). Creates users directly against
  `ICosmosUserRepository`, hashing passwords with `PasswordHasher`.
- **`CsvGenerationController`** — `csv/generate-from-image` (anonymous trigger, validates a `Bearer`
  JWT inside the method body). Accepts multipart/form-data with one or more image files, enforces the
  per-user AI-call rate limit, sends all images in a single OpenAI-compatible chat-completions
  request with base64 `image_url` content parts, and returns the parsed CSV as `text/csv`. A
  `isCreative` query flag switches between a simple two-column vocabulary prompt and a longer
  HSK-teacher prompt tailored to the target export platform's column layout (`hskLevel`,
  `lessonNumber`, `exportType` query params required in that mode).

Auth flow: `TokenController` → `AuthenticationService` → `ICosmosUserRepository`. The repository is
resolved from `IServiceProvider` at call time (not constructor injection) since it's only registered
when Cosmos env vars are present — if absent, auth calls fail closed (`Valid = false`) instead of
throwing.

JWT handling is split into two pieces: `JwtTokenIssuer` creates tokens (used by
`AuthenticationService`), and `JwtAuth` validates tokens / checks role claims (used directly inside
`CsvGenerationController`).

Data model: `QuizToolUser` (`Models/QuizToolUser.cs`) is the single Cosmos document type, partitioned
by `/username`. It holds the password hash, roles, a list of `RefreshTokenEntry` (one per active
device/session), and AI-call rate-limit state (`AiCallCountInRound`, `StartRoundTime`). Refresh-token
mutations use ETag-guarded optimistic concurrency since concurrent logins/refreshes from different
devices touch the same document.

## Requirements

- .NET 10 SDK
- Azure Functions Core Tools (for local hosting)
- A Cosmos DB account (for auth/user storage) and an OpenAI-compatible LLM endpoint (for CSV
  generation) — both optional locally; endpoints that depend on them fail gracefully if unconfigured

## Getting started

Build:

```bash
dotnet build QuizTool.sln
```

Run locally (Azure Functions Core Tools host, port 7071):

```bash
dotnet run --project QuizTool/QuizTool.csproj
```

### Local configuration

The Functions host reads settings from `QuizTool/local.settings.json` (gitignored — create it
yourself in a fresh clone). Required app settings, read via `Environment.GetEnvironmentVariable`:

| Setting | Notes |
|---|---|
| `JWT_SECRET` | Required to issue/validate tokens |
| `JWT_ISSUER`, `JWT_AUDIENCE` | Optional — issuer/audience validation is skipped if unset |
| `JWT_ACCESS_TOKEN_EXPIRES_MINUTES` | Default 15 |
| `JWT_REFRESH_TOKEN_EXPIRES_DAYS` | Default 30 |
| `COSMOS_ENDPOINT`, `COSMOS_KEY` | If either is missing, Cosmos-backed services aren't registered and endpoints depending on `ICosmosUserRepository` fail DI resolution |
| `COSMOS_DATABASE` | Default `QuizDb` |
| `COSMOS_CONTAINER` | No default — must be set |
| `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `LLM_MODEL` | Used by `CsvGenerationController` for the `/chat/completions` call |
| `CALL_COUNT_ACCEPTED_IN_A_ROUND` | Default 2 — AI-call rate limit per user |
| `ROUND_MINUTES` | Default 1 — rate limit window |
| `MAX_REFRESH_TOKENS_PER_USER` | Default 5 — oldest refresh tokens are evicted once a new login would exceed the cap |

There are no test projects in this solution currently.
