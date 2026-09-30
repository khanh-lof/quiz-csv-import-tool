# QuizTool

QuizTool turns photos of a Chinese (HSK/YCT) lesson into a quiz file you can import into
[GimKit](https://www.gimkit.com), [Blooket](https://www.blooket.com) or
[Wayground](https://wayground.com). Upload the pages, let an LLM extract the vocabulary (or write the
questions itself), review the result, and download a `.csv` / `.xlsx` in the target platform's import
format.

## Repository layout

| Directory | What it is |
|---|---|
| [`Client/`](Client/) | Angular 20 single-page app (ng-zorro-antd) |
| [`Server/`](Server/) | Go API: auth, per-user AI rate limit, LLM-backed CSV generation, MongoDB persistence ([README](Server/README.md)) |
| [`Extension/`](Extension/) | Optional Chrome/Edge extension that imports the Wayground `.xlsx` into your logged-in Wayground tab ([install guide, in Vietnamese](Extension/README.md)) |

The client and server are built independently; there is no shared code. The API contract between them
is described in [AGENTS.md](AGENTS.md).

## Features

- **Two AI modes**
  - *Formatted* — the LLM reads the vocabulary off the images into a two-column table that you edit
    before exporting; distractors are generated client-side.
  - *Auto* — the LLM writes a full quiz for the chosen lesson (HSK, YCT or another course) directly in
    the target platform's column layout, and the file downloads immediately. Images are optional.
- **Manual editing** — build or edit the question table by hand, or import an existing CSV.
- **Export** to GimKit (`.csv`), Blooket (`.csv`) or Wayground (`.xlsx`).
- **Accounts** with JWT access tokens and an `HttpOnly` refresh cookie; AI calls are rate-limited per
  user.

## Running locally

Requirements: Node.js 20.19+, Go 1.27+, MongoDB, and an OpenAI-compatible chat-completions endpoint
(only needed for AI generation).

1. **Server** (http://localhost:7071):

   ```bash
   cd Server
   cp .env.example .env        # set JWT_SECRET, ADMIN_API_KEY, OPENAI_API_KEY, ...
   docker compose up -d mongo  # or point MONGODB_URI at your own MongoDB
   go run ./cmd/server
   ```

2. **Create a user** (needs `ADMIN_API_KEY` from `.env`):

   ```bash
   curl -X POST http://localhost:7071/api/users -H "X-Admin-Key: $ADMIN_API_KEY" -H "Content-Type: application/json" -d '{"username":"alice","password":"secret","roles":["User"]}'
   ```

3. **Client** (http://localhost:4200):

   ```bash
   cd Client
   npm install
   npm start
   ```

   `ng serve` proxies `/api` to the server on 7071, so open only http://localhost:4200. The client and
   API must share one origin — there is no CORS support.

## Tests

```bash
cd Client && npm test
cd Server && go test ./...
```

## Deployment

Both halves deploy together as one Vercel project using
[Vercel Services](https://vercel.com/docs/services), configured in the root [`vercel.json`](vercel.json):
`/api/*` and `/healthz` go to the Go `server` service, everything else to the Angular `client` service.
Set the Vercel project's Root Directory to the repository root and add the server's environment
variables (see [`Server/.env.example`](Server/.env.example)) to the project.

The server can also run anywhere as a container ([`Server/Dockerfile`](Server/Dockerfile)), behind a
reverse proxy that serves the client on the same origin over HTTPS.

## Contributing

[AGENTS.md](AGENTS.md) explains how the pieces fit together (the client/server contract, the two AI
modes, rate limiting, retries and Vercel limits). Each project also has its own `AGENTS.md` with the
details for that side.
