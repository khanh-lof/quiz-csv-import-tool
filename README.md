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
| [`Server/`](Server/) | Go API: auth, per-user AI rate limit, LLM-backed CSV generation, PostgreSQL persistence ([README](Server/README.md)) |
| [`Extension/`](Extension/) | Optional Chrome/Edge extension that imports and publishes the Wayground quiz in your logged-in Wayground tab and returns its share link ([install guide, in Vietnamese](Extension/README.md)) |

The client and server are built independently; there is no shared code. The API contract between them
is described in [AGENTS.md](AGENTS.md).

## Features

- **Two AI modes**
  - *Formatted* — the LLM reads the vocabulary off the images into a two-column table that you edit
    before exporting; distractors are generated client-side.
  - *Auto* — the LLM writes a full quiz for the chosen lesson (HSK, YCT or another course) directly in
    the target platform's column layout. Images are optional.
  - Generation runs as a **background job** on the server, so you can leave or close the page while the AI
    works. A history table on the AI page follows each job (it updates by itself), lets you search the
    generated questions and filter by status, mode and platform, and delivers the result: download the file,
    publish it through the extension, or open it in the table to edit.
- **Manual editing** — build or edit the question table by hand, or import an existing CSV.
- **Export** to GimKit (`.csv`), Blooket (`.csv`) or Wayground (`.xlsx`).
- **Accounts** with JWT access tokens and an `HttpOnly` refresh cookie; AI calls are rate-limited per
  user.

## Running locally

Requirements: Node.js 20.19+, Go 1.27+, PostgreSQL 13+, and an OpenAI-compatible chat-completions endpoint
(only needed for AI generation).

1. **Server** (http://localhost:7071):

   ```bash
   cd Server
   cp .env.example .env        # set JWT_SECRET, ADMIN_API_KEY, OPENAI_API_KEY, ...
   docker compose up -d postgres  # or point DATABASE_URL at your own PostgreSQL
   go run ./cmd/server            # creates the tables on start
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

Everything deploys to Render from the root [`render.yaml`](render.yaml) Blueprint: the Angular client as a
static site, the Go API as a web service and a PostgreSQL database. The static site rewrites `/api/*` to the
API, so the browser sees one origin (no CORS, `SameSite=Strict` cookie). The production URLs are not in the repo:

1. In the Render dashboard choose **New → Blueprint**, pick this repository, and fill in the API's secret settings
   when asked (see [`Server/.env.example`](Server/.env.example)). Set `APP_ORIGIN` to the static site's URL.
2. Under the static site's **Redirects/Rewrites**, add two rules in this order: rewrite `/api/*` to
   `<API URL>/api/*`, then rewrite `/*` to `/index.html`.

To bring the data over from the MongoDB used before, run `cmd/migrate-mongo` once (see
[`Server/README.md`](Server/README.md#moving-the-data-from-mongodb)).

The server can also run anywhere as a container ([`Server/Dockerfile`](Server/Dockerfile)), behind a
reverse proxy that serves the client on the same origin over HTTPS.

## Contributing

[AGENTS.md](AGENTS.md) explains how the pieces fit together (the client/server contract, the two AI
modes, rate limiting, retries, upload size and long AI jobs). Each project also has its own `AGENTS.md` with the
details for that side.
