# QuizTool API

A Go HTTP API that turns photos of Chinese vocabulary into a quiz. Users log in with a JWT-based
auth flow, upload one or more images, and an LLM vision call converts the vocabulary into a CSV of
questions and answers. Users, sessions and the per-user AI rate limit are stored in MongoDB.

## Requirements

- Go 1.27+
- MongoDB (local, Docker, or a hosted cluster such as Atlas)
- An OpenAI-compatible chat-completions endpoint for CSV generation (optional locally — the rest of
  the API works without it)

## Getting started

```bash
cp .env.example .env        # then fill in JWT_SECRET, ADMIN_API_KEY, LLM settings
docker compose up -d mongo  # or point MONGODB_URI at your own MongoDB
go run ./cmd/server         # http://localhost:7071
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
| `POST /api/csv/generate-from-image` | `Bearer` token, role `User`/`Admin` | Multipart images → `text/csv` |
| `GET /healthz` | — | Liveness check |

## Configuration

All configuration is via environment variables; `.env.example` lists every one with its default.
`MONGODB_URI` and `JWT_SECRET` are required. Set `ALLOWED_ORIGINS` to the exact origin(s) of the
web client — the browser sends the refresh cookie cross-origin only to allowed origins.

## Deployment

Build the image from `Dockerfile` (static binary on distroless, listens on `PORT`, default 8080 in
the image) and run it anywhere containers run. The refresh cookie is `Secure; SameSite=None`, so the
API must be served over HTTPS in production.

## Migrating users from Cosmos DB

Export the old container as a JSON array (e.g. `SELECT * FROM c` in Cosmos Data Explorer, save the
results), then:

```bash
MONGODB_URI=... go run ./cmd/import-users users.json
```

Password hashes are compatible, so users keep their passwords. Sessions are not migrated; everyone
logs in again.

## Tests

```bash
go test ./...
MONGODB_TEST_URI=mongodb://localhost:27017 go test ./internal/store/   # MongoDB integration tests
```
