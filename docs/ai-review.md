# AI features review

Read-only review of AI generation (server `csvgen` + job handlers, client `/ai`, `/ai-history`, radicals edit), 2026-11-05.
Line numbers are from the working tree on that date. It includes the uncommitted TIME LIMIT change in `client.go`, `prompts.go` and `language.go`.

**Do first (15 min):** check whether Vercel holds back the `202`:

```bash
curl -s -o /dev/null -w "%{time_starttransfer}s\n" -X POST "https://<prod>/api/csv/jobs?isCreative=true&..." -H "Authorization: Bearer <token>" -F x=
```

If the time is close to the generation time rather than under 2 s, finding 1 is real. In that case it decides the roadmap.

---

## Findings, most important first

### 1. The "submit and leave" flow may not work on Vercel, and the client depends on it

- `Server/internal/api/csv_handler.go:169-178` writes the `202`, then flushes on a best-effort basis. `runJob` keeps going inside the same handler (`:72-74`).
  - Vercel's Go runtime is Beta and not on Fluid compute, and it has no `waitUntil`. The response is probably buffered until the handler returns. This is not yet verified.
- `Client/src/components/ai-generation/ai-generation.ts:447-456` keeps the "Đang gửi…" overlay up and the page inert until the `202` arrives. If the `202` is buffered, the user stares at an upload spinner for 1–5 min.
  - Leaving the page unsubscribes (`takeUntilDestroyed`), which aborts the fetch. Whether Vercel then kills the function is unknown.
- **Fix:** verify first with the command above. If the `202` is buffered, take the worker route (roadmap step 4). Interim client fix: show "Đang gửi…" only until the upload body is sent (`HttpClient` `reportProgress` upload event). After that, treat the job as submitted and poll. **2 h** client.

### 2. Model output is never validated, so broken or empty quizzes are stored as "done"

- `Server/internal/csvgen/client.go:88` returns `ExtractCSVContent(content)` unchecked. Three outcomes all complete the job as `done`:
  - an empty answer;
  - prose;
  - rows with the wrong field count.
- `prompts/creative_system.txt:370-385` (HANDLING UNCLEAR INPUT) tells the model to answer "clarification required" *as CSV rows*. The server cannot tell that answer from a quiz, so the teacher downloads a junk file.
- `ExtractCSVContent` keeps only the first fenced block (`client.go:246`).
- **Fix:** add `ValidateRows(exportType, csv)` using `encoding/csv`. It checks:
  - the field count per platform (the columns listed in `prompts.go:178-200`);
  - a minimum row count;
  - Wayground `Question Type` values;
  - Game `Stage` values within the chosen stages;
  - a non-empty answer.
- On failure, run **one** repair call that sends the rows plus the error list (short, cheap). Otherwise fail with a distinct reason (see 3).
- Also give the model an explicit refusal row, such as `#UNCLEAR,<reason>`, that the server maps to a clear failure.
- **1 day** with tests.

### 3. Failures lose their reason, for the user and for you

- `csv_handler.go:210-214` folds every non-timeout error into `502 "AI generation failed."`:
  - a truncated answer (`length`/`incomplete`);
  - 401 bad key;
  - 402 out of balance;
  - bad JSON (radicals);
  - an exhausted retry.
- The client then shows "Thử lại sau ít phút." (`Client/src/models/ai-job.ts:358`). That message is wrong advice for a truncated answer (fewer questions or stages would help) and for 402 (only the admin can fix it).
- There is no stored record of model, attempts, duration or tokens:
  - `client.go:126` logs the **whole response body** at Info on every attempt. That can be hundreds of KB, and it is user content. It logs no `usage` and no duration.
  - The job document keeps none of these either.
- **Fix:**
  1. Add `errorCode` to the job, with the values `truncated`, `provider_config`, `overloaded`, `bad_output`, `timeout` and `interrupted`. Map each to its own Vietnamese message in `failedJobMessage`.
  2. Parse `usage` (`prompt_tokens`/`input_tokens`, cached tokens, output tokens) and store `model`, `attempts`, `durationMs` and tokens on the job.
  3. Log one summary line per call instead of the body. Keep the body only at Debug, or on decode failure, truncated to about 2 KB.
- **4 h.**

### 4. Long calls wait silently for 280 s, and a stall is only found at the deadline

- The calls are non-streaming (`client.go:108-146`), which causes three problems:
  - The client cannot show progress.
  - A stalled generation is found only when the 280 s deadline hits.
  - A timeout throws away everything already written.
- Wayground (`web_search`, 64k tokens, `prompts.go:145-148`) and large Game quizzes (`:149-151`) are the jobs that hit it.
- The retry policy (`retry.go:283-295`) is sound for transient errors, but a slow generation cannot be retried within one invocation.
- **Fix:** stream (`stream: true`, SSE).
  - Stall detection: no delta for about 60 s → abort and retry while time remains.
  - Progress: write `rowsSoFar` to the job every about 10 s, and the client shows "Đã viết 12/30 câu".
  - On timeout, keep the complete rows and fail as `timeout` with "lưu được N câu". Delivering a partial quiz is optional.
  - Streaming also removes the blank-line keep-alive case (`retry.go:273-277`).
- **1.5 days** server, **0.5 day** client.

### 5. "Tạo lại" with images is unreliable on Vercel

- `Server/internal/api/retry_images.go:17-20` keeps images in process memory. On Vercel the next request often reaches another instance, so `retryable` reads false and the user re-uploads. `retryState` (`csv_handler.go:358`) also reports `retryable` per instance, so it flickers between polls.
- **Fix:** add a MongoDB collection `RetryImages` with a TTL index on `expiresAt` (1 h). It holds `{jobId, username, images[]}`, which stays under the 16 MB document limit because uploads are under 4 MB. **2–3 h.**

### 6. Polling stops silently and is not resumed after a reload

- `Client/src/services/ai-job.service.ts:56-58` stops polling after 10 failed polls (about 30 s offline) and nothing restarts it.
- `watch()` is called only from `/ai-history` (`ai-jobs.ts:164`) and after a submit (`ai-generation.ts:454`). After a reload on any other page, a running job's "AI đã tạo xong" toast never fires.
- Polling runs at a fixed 3 s on hidden tabs, which is 20–100 requests per job.
- The server does fail abandoned jobs (`csv_handler.go:270-281`), but only when the client lists them.
- **Fix:**
  - Call `refresh()` and then `watch()` on login or app start.
  - Restart polling on `online` and `visibilitychange`.
  - Poll every 10 s while `document.hidden`.
- **3 h.**

### 7. Waiting gives no sense of time

- `ai-jobs.html:84-88` shows "Đang chạy" and a spinner, with no elapsed time and no idea of how long is normal.
- The tab title is unchanged, there is no browser notification, and the done toast has no link (`ai-job.service.ts:115-116`).
- **Fix:**
  - Show `mm:ss` from `createdAt`, plus a soft hint "thường 1–4 phút".
  - Set `document.title` to "(1) Đang tạo…".
  - Add a "Xem" link in the done toast.
  - Optionally use `Notification` when the tab is hidden.
- After 4, show the row progress here. **3 h.**

### 8. The rate limit is a 403 that the client must guess at

- `csv_handler.go:146` answers `403 "You have reached the limit for AI calls."`. The client tells it apart from the role check only by whether the body is empty (`Client/src/services/ai-refusal.ts:8-10`). It shows "Thử lại sau ít phút" with no time. The defaults are 2 calls per 1 min (`Server/internal/config/config.go:137-138`), so the real wait is under a minute.
- The radicals revise path does not route refusals through `notifyAiRefusal` (`radicals-play.ts:231-247`).
- **Fix:**
  - Answer `429` with `Retry-After` and `{remaining, resetAt}`, as login already does.
  - Add `remaining` to `GET csv/jobs`.
  - Show "Còn N lượt" by the submit button and "Thử lại lúc HH:mm:ss".
- **4 h** across both sides.

### 9. Token cost: about 30 % of the creative system prompt is irrelevant to most platforms

- `prompts/creative_system.txt:180-301` (IMAGE USAGE, about 9.7 KB ≈ 2.5k tokens) is sent to GimKit, Blooket and Game. The prompt itself says to ignore it there (`:188`).
- The whole system prompt is about 33 KB ≈ 8–9k tokens per call.
- **Fix:** wrap the section in `{{if .HasImages}}`. Keep the system prompt byte-identical per (language, platform) so DeepSeek's prefix cache still hits.
- **1 h**, plus a quality spot check on 3 quizzes.

### 10. Large jobs are one serial call; fan-out would cut wall time

- A Game of 6 stages × 5 questions, or a 5-lesson quiz, is one long generation. Size drives both latency and timeout risk (`prompts.go:149-151`).
- **Fix:** for Game, run one call per stage in parallel goroutines (`errgroup`). Share a fixed word allocation per stage to avoid repeats, then concatenate the results. Each call is short and well under the deadline, and the per-stage calls show progress for free.
  - Cost: the system prompt repeats per call, mostly at cache-hit prices.
- Radicals already splits into 2 calls (`radicals.go:77-113`).
- **1 day.**

### Smaller items

- **Images are not checked on the server.** `readImages` (`csv_handler.go:410-437`) accepts any part type, any count, and up to 50 MB (`:24`). Add an image MIME allow-list and a count cap matching the client. The client has no count cap either (`ai-generation.ts:595-625`) and decodes all bitmaps at once (`image-compression.service.ts:255`), which risks memory on phones. **2 h.**
- **The model is not stored per job.** `modelFor` (`client.go:49-58`) picks by "Độ thông minh", but the job does not record which model ran, so quality and latency per model cannot be compared. Handled by 3.
- **Radicals JSON.** `decodeJSONAnswer` (`radicals.go:461-472`) does not retry a bad JSON answer (`retry.go:372-375`), so one malformed answer fails the job. Use `response_format: json_object` if the provider supports it on `/responses`. Otherwise use the repair call from 2. **2 h.**
- **Radicals edit errors.** `Client/src/models/radicals-edit.ts:82-93` matches the server's English text exactly. Error codes would hold up better (same `errorCode` idea as 3). **1.5 h.**
- **No cancel.** A running job cannot be cancelled or deleted (`ai-jobs.html:100`). This becomes cheap once there is a worker or streaming: a `cancelled` flag that the loop checks. **3 h.**
- **Mobile.** The 9-column jobs table scrolls horizontally, so the action button can sit off-screen (`ai-jobs.css:63-66`). Tooltip-only hints (`ai-generation.html:129-139`, `ai-jobs.html:162`) do not show on touch. Use a card list under 768 px. **2–3 h.**
- **Test gaps:**
  - Server: no test for empty or malformed model output, and no prompt quality eval. A golden set of about 5 lessons × platforms scored by a checker script would catch prompt regressions.
  - Client: `ai-jobs` has no spec. Also untested: `showGenerationError`, `notifyAiRefusal`, `MAX_FAILED_POLLS`, and `failedJobMessage` per status.
  - **1 day** in total.

The existing retry and refund design (`retry.go`, `csv_handler.go:216-218`, `:278-281`) is solid and tested (`retry_test.go`, `api_test.go:541-631`). Keep it.

---

## Roadmap

Ranked by value against effort. Steps 1–3 are about 2 days and need no infrastructure change.

| # | Step | Findings | Time |
|---|---|---|---|
| 1 | Verify the 202 on prod; reason codes, usage and duration on the job; logging fix | 1, 3 | 0.5 day |
| 2 | Output validation + one repair call; MongoDB TTL retry images | 2, 5 | 1.5 days |
| 3 | Client: resume polling, elapsed timer, title badge, 429 + quota display | 6, 7, 8 | 1 day |
| 4 | Long requests, by outcome of step 1, cheapest first: <br>a. `202` arrives early: stream + stall detection + progress (finding 4), then Game fan-out (10). <br>b. `202` buffered: move generation to a worker. The handler only inserts a `queued` job; a small always-on container (Fly.io, Render or Cloud Run, same Go binary with `-worker`) claims jobs with `findOneAndUpdate` (`queued → running`, plus a lease). This removes the 300 s limit and the in-memory problems. Streaming then adds progress. <br>c. On Pro only: `maxDuration: 800` in `vercel.json` `services.server` buys headroom but does not fix buffering. | 1, 4, 10 | a: 2–3 days, b: 2 days + hosting, c: 10 min |
| 5 | Prompt trim (IMAGE USAGE conditional) + golden-set eval | 9, tests | 1 day |

Not recommended: Vercel Queues (Beta, HTTP API only from Go), Vercel Workflow (no Go), or Cron-driven processing (at most daily on Hobby).
