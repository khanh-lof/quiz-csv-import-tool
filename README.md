# QuizTool

QuizTool turns a Chinese (HSK/YCT) or English lesson into a quiz file you can import into
[GimKit](https://www.gimkit.com), [Blooket](https://www.blooket.com) or
[Wayground](https://wayground.com), or into a quiz QuizTool plays itself as a webcam gesture game. Pick a
textbook lesson (or upload photos), let an LLM write the questions, and download a `.csv` / `.xlsx` in the target
platform's import format.

## Repository layout

| Directory | What it is |
|---|---|
| [`Client/`](Client/) | Angular 22 single-page app (ng-zorro-antd) |
| [`Server/`](Server/) | Go API: auth, per-user AI rate limit, LLM-backed generation, question bank, assignments, MongoDB persistence ([README](Server/README.md)) |
| [`Extension/`](Extension/) | Optional Chrome/Edge extension that imports and publishes the quiz in your logged-in Wayground or Gimkit tab and returns its share link ([install guide, in Vietnamese](Extension/README.md)) |
| [`Textbooks/`](Textbooks/) | Source material of the textbooks whose lessons the server sends to the model ([README](Textbooks/README.md)) |

The client and server are built independently; there is no shared code. The API contract between them
is described in [AGENTS.md](AGENTS.md).

## Features

- **Two AI modes**
  - *Formatted* — the LLM reads the vocabulary off the images into a two-column table that you edit
    before exporting; distractors are generated client-side.
  - *Auto* — the LLM writes a full quiz for the chosen textbook lessons directly in the target platform's
    column layout, from the lesson's own material. A question bank reuses stored questions where it can.
  - Generation runs as a **background job** on the server, so you can leave or close the page while the AI
    works. A history table ("AI › Lịch sử") follows each job (it updates by itself), lets you search the
    generated questions and filter by status, mode and platform, and delivers the result: download the file,
    publish it through the extension, play it, or open it in the table to edit.
- **Chinese and English** quizzes, chosen with a switch on the AI page.
- **Game** — a gesture quiz played in the browser with a webcam (also mouse, touch or keyboard).
- **Giao bài** — a teacher hands a Game to students as a link; they play without an account and the teacher
  watches the leaderboard.
- **Ghép bộ thủ** — an exercise page where the learner completes characters by choosing the missing component.
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
variables (see [`Server/.env.example`](Server/.env.example)) to the project, `APP_ORIGIN` being the
project's own URL and `CLOUDINARY_URL` a free [Cloudinary](https://cloudinary.com) account's API environment
variable: it keeps each job's images for 30 days, so a failed job can be retried and an interrupted one resumed.

Creative AI jobs (the quizzes the model writes) can run longer than a Vercel function may, so they run on a
second, AI-only Go server (`Server/cmd/ai-server`) on Render's free plan, which the Vercel server forwards them to:

1. In the Render dashboard choose **New → Blueprint**, pick this repository ([`render.yaml`](render.yaml)), and enter
   the same `MONGODB_URI`, `JWT_SECRET`, `CLOUDINARY_URL` and LLM settings as the Vercel project, plus a new
   `AI_SERVER_SECRET` (at least 32 bytes, e.g. `openssl rand -base64 48`).
2. In the Vercel project, set `AI_SERVER_URL` to the Render service's URL and `AI_SERVER_SECRET` to the same
   value, then redeploy. Render refuses job requests without it.

Without step 2 every job runs on Vercel. The free Render service sleeps after 15 minutes without requests; the
first creative job after that waits about a minute for it to wake. When Render stops it in the middle of a job (a
restart or a deploy), it runs the job again once it is back, by itself.

The server can also run anywhere as a container ([`Server/Dockerfile`](Server/Dockerfile)), behind a
reverse proxy that serves the client on the same origin over HTTPS.

## Contributing

Read [AGENTS.md](AGENTS.md) first, then the `AGENTS.md` of the project you are changing.
