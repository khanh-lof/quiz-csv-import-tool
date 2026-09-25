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
`MONGODB_URI` and `JWT_SECRET` are required — the server refuses to start without them.

- `PORT` (default 7071 — the client's `ng serve` proxy points there)
- `MONGODB_URI`, `MONGODB_DATABASE` (default `QuizDb`), `MONGODB_COLLECTION` (default `Users`)
- `JWT_SECRET`, `JWT_ISSUER`, `JWT_AUDIENCE` (issuer/audience validation skipped if unset)
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
  Refresh rotates the token.
- **Users** (`auth_handlers.go`): `users`, admin-only via `X-Admin-Key` (replaces the Azure Functions
  admin key). 409 if the user exists.
- **CSV** (`csv_handler.go`): `csv/generate-from-image`. Validates the `Bearer` JWT by hand, requires
  the `User` or `Admin` role, reads a multipart body of zero or more files, enforces the rate limit,
  and returns `text/csv`. `isCreative=true` switches to the creative prompt and requires `exportType`,
  `courseType`, `lessonNumber`, plus `level` (HSK/YCT) or `courseName` (`Other`) — parsed by
  `csvgen.ParseCreativeOptions` (400 with the message on failure). Images are optional only in
  creative mode. The LLM call runs under `LLM_TIMEOUT_SECONDS`; hitting it answers
  `504 AI generation timed out.` (other LLM failures stay `502`). See [../AGENTS.md](../AGENTS.md#the-two-ai-generation-modes) for the client half.

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
- `ExtractCSVContent` strips code fences / leading prose the model sometimes adds.
- The creative mode uses the Responses API because Wayground requests carry the `web_search` tool:
  the model searches Pexels for the Image Link column and builds `images.pexels.com` URLs from the
  photo IDs it finds (Wikimedia is banned; Wayground cannot load it). Other platforms have no image
  column and get no tool. An `incomplete` response (output token cap hit) fails the call rather than
  returning cut-off rows. The `OPENAI_BASE_URL` gateway must support `/responses` with `web_search`,
  and requires `max_output_tokens` to be set.

Data model (`internal/store`): one `User` document per user in one collection, `_id` = username,
holding `passwordHash`, `roles`, `createdAt`, `refreshTokens` (`token`, `expiresAt`, `createdAt`),
`aiCallCountInRound`, `startRoundTime`, and `version`.

- Refresh-token changes go through `UpdateRefreshTokens`: read, apply the mutation, write back only
  if `version` is unchanged (`$inc` on success), retry up to 5 times. This keeps concurrent logins
  from different devices from dropping each other's tokens. Documents without `version` count as 0.
  The token policy itself (prune expired, cap, rotate) lives in `auth.Service`, not the store.
- `TryConsumeAICall` enforces the rate limit atomically with two conditional updates (increment
  within a running round under the limit, else start a new round) instead of read-then-write.
- `EnsureIndexes` creates the `refreshTokens.token` index used by `FindByRefreshToken`. The server
  does not call it (it would slow every serverless cold start); `cmd/import-users` does, or create
  the index once by hand. Without it, refresh lookups scan the collection — fine for few users.

Password hashes are `iterations.base64(salt).base64(key)` with PBKDF2-HMAC-SHA256 — the same format
the .NET version wrote, so users imported with `cmd/import-users` keep their passwords. Access
tokens are HS256 with `unique_name`/`role` claims, validated with 2 minutes of clock skew.
