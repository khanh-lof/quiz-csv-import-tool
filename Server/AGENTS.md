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
  (tests) implementations.
- `internal/csvgen` — creative-mode option parsing, the two prompts (embedded from `prompts/*.txt`),
  and the OpenAI-compatible client (`/chat/completions` for the formatted mode, `/responses` for the
  creative mode).

## Commands

```bash
go build ./...
go vet ./...
go test ./...                                    # Mongo integration tests are skipped…
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
  `MONGODB_JOBS_COLLECTION` (default `Jobs`, the AI generation jobs)
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
  `courseType`, `lessonNumber`, plus `level` (HSK/YCT) or `courseName` (`Other`) — parsed by
  `csvgen.ParseCreativeOptions` (400 with the message on failure). Images are optional only in
  creative mode. The LLM call runs under `LLM_TIMEOUT_SECONDS`; hitting it fails the job with
  `errorStatus` 504 ("AI generation timed out."), other LLM failures with 502. Either failure refunds the
  rate-limit slot (`RefundAICall`) so the user can resubmit without losing quota. See [../AGENTS.md](../AGENTS.md#the-two-ai-generation-modes) for the client half.

Auth is net/http middleware (`middleware.go`), composed per route in `Server.Handler`: `authenticate`
stores the validated `*auth.Claims` in the request context under an unexported key
(`auth.NewContext` / `auth.FromContext`); `requireRole` must sit inside it and fails closed (401) if
it finds no claims. Protect a new route by wrapping it the same way rather than checking tokens in
the handler.

The plain-text error bodies and status codes are part of the contract with the client and were kept
identical to the former .NET implementation; `internal/api/api_test.go` pins them down.

There is no CORS handling: the API is only ever called from the SPA's own origin (Vercel Services in
production, the `ng serve` proxy locally), which is also why the refresh cookie can be
`SameSite=Strict`. Putting the SPA on another origin would need CORS back and a `SameSite=None`
cookie.

`csvgen`:

- `ExportType` (`GimKit`/`Blooket`/`Wayground`) and `CourseType` (`Hsk`/`Yct`/`Other`) are passed by
  **ordinal** and must stay in the same order as `Client/src/models/export-type.ts` and
  `course-type.ts`. `exportTypeMessages` must describe the same columns as the client's CsvBuilders.
- Prompts live in `prompts/*.txt` (`go:embed`); CRLF from a Windows checkout is normalized at use.
- `post` retries transient gateway failures (429, 502/503/504, transport errors), up to 5 attempts
  within the caller's deadline; this is the only retry layer (the client does not re-send) — see `retry.go` and [../AGENTS.md](../AGENTS.md#retrying-ai-requests). Non-2xx answers
  become `*StatusError` (status, gateway `error.code`, `Retry-After`); each attempt's
  `x-request-id` is logged.
- `ExtractCSVContent` strips code fences / leading prose the model sometimes adds.
- The creative mode uses the Responses API because Wayground requests carry the `web_search` tool:
  the model searches Pexels for the Image Link column and builds `images.pexels.com` URLs from the
  photo IDs it finds (Wikimedia is banned; Wayground cannot load it). Other platforms have no image
  column and get no tool. An `incomplete` response (output token cap hit) fails the call rather than
  returning cut-off rows. The `OPENAI_BASE_URL` gateway must support `/responses` with `web_search`,
  and requires `max_output_tokens` to be set.

Jobs (`internal/store/jobs*.go`): `store.Jobs` is implemented by `MongoJobs` (collection
`MONGODB_JOBS_COLLECTION`) and `MemoryJobs` (tests), and every method is scoped to a username. A `Job`
holds the request's metadata (title, mode, export type ordinal, intelligence, image count — never the
images — and, for a creative job, the lesson: course type ordinal, course name, HSK standard, level and
lesson number, which `listJobs` returns so the client can filter by them), `status` (`running`/`done`/`failed`), the raw model `csv`, `errorStatus`/`errorMessage`, the
rate-limit `roundStart` (for refunds) and timestamps. `Complete`/`Fail` only touch a job that is still
`running`, so an expired job is never revived by a late answer; `Prune` never deletes a running job.
`MongoJobs.EnsureIndexes` (username + createdAt) is, like the users' one, not called on start.

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
