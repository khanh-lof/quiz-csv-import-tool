# QuizTool API

A Go HTTP API that turns photos of Chinese vocabulary into a quiz. Users log in with a JWT-based
auth flow, upload one or more images, and an LLM vision call converts the vocabulary into a CSV of
questions and answers. Users, sessions, AI jobs, assignments and the per-user AI rate limit are stored in
PostgreSQL.

## Requirements

- Go 1.27+
- PostgreSQL 13+ (local, Docker/Podman, or hosted such as Render Postgres)
- An OpenAI-compatible chat-completions endpoint for CSV generation (optional locally — the rest of
  the API works without it)

## Getting started

```bash
cp .env.example .env        # then fill in JWT_SECRET, ADMIN_API_KEY, LLM settings
docker compose up -d postgres  # or point DATABASE_URL at your own PostgreSQL
go run ./cmd/server           # http://localhost:7071; creates the tables on start
```

Or run everything in containers: `docker compose up --build`.

Create a user (the endpoint needs `ADMIN_API_KEY`):

```bash
curl -X POST http://localhost:7071/api/users \
  -H "X-Admin-Key: $ADMIN_API_KEY" -H "Content-Type: application/json" \
  -d '{"username":"alice","password":"secret","roles":["User"]}'
```

## Endpoints

| Method & path | Auth | Purpose |
|---|---|---|
| `POST /api/auth/login` | — | `{username, password}` → `{accessToken}` + `refreshToken` cookie |
| `POST /api/auth/refresh` | refresh cookie | New access token, rotated refresh cookie |
| `POST /api/auth/logout` | refresh cookie | Revoke this device's session |
| `POST /api/auth/logout-all` | refresh cookie | Revoke all sessions of the user |
| `POST /api/users` | `X-Admin-Key` | Create a user |
| `POST /api/csv/jobs` | `Bearer` token, role `User`/`Admin` | Multipart images → starts an AI generation job, `202 {id}` |
| `GET /api/csv/jobs` | `Bearer` token, role `User`/`Admin` | The caller's jobs, newest first, with their CSV results |
| `DELETE /api/csv/jobs/{id}` | `Bearer` token, role `User`/`Admin` | Delete one of the caller's jobs |
| `GET /healthz` | — | Liveness check |

## Configuration

All configuration is via environment variables; `.env.example` lists every one with its default.
`DATABASE_URL` and `JWT_SECRET` are required. The API has no CORS support: it must be served from the
same origin as the web client (the refresh cookie is `SameSite=Strict`).

## Deployment

On Render, the API is the Go web service of the root `render.yaml` Blueprint, next to the client's static
site (which rewrites `/api/*` to it, by a rule set in the dashboard) and the PostgreSQL database.
`DATABASE_URL` and `JWT_SECRET` come from the Blueprint; set `APP_ORIGIN` (the static site's URL), the LLM
settings and `ADMIN_API_KEY` when Render asks for them.

Elsewhere, build the image from `Dockerfile` (static binary on distroless, listens on `PORT`, default 8080 in
the image) and run it anywhere containers run, behind a reverse proxy that serves the client on the
same origin. The refresh cookie is `Secure`, so it must be served over HTTPS in production.

## Migrating users from Cosmos DB

Export the old container as a JSON array (e.g. `SELECT * FROM c` in Cosmos Data Explorer, save the
results), then:

```bash
DATABASE_URL=... go run ./cmd/import-users users.json
```

Password hashes are compatible, so users keep their passwords. Sessions are not migrated; everyone
logs in again.

## Moving the data from MongoDB

The server used MongoDB before. `cmd/migrate-mongo` copies users (with their sessions), AI jobs,
assignments and players into PostgreSQL; stop the old deployment first, then:

```bash
MONGODB_URI=mongodb+srv://... DATABASE_URL=postgres://... go run ./cmd/migrate-mongo
```

Rows already in PostgreSQL are skipped, so it can be run again after a failure.

## Tests

```bash
go test ./...
POSTGRES_TEST_URL=postgres://quiz:quiz@localhost:5432/quiz go test ./internal/store/   # PostgreSQL integration tests
```
