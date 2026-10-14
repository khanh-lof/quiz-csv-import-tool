# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

The Angular (v22, standalone components) frontend for QuizTool. It lets a user build a table of
question/answer vocabulary pairs (manually, via CSV import, or via AI generation), then export
them as a CSV formatted for GimKit or Blooket import, or as an `.xlsx` for Wayground. The AI can also
write a "Game" quiz, which is not exported anywhere: the app plays it itself, on a full-screen
page that reads the player's gestures from the webcam (see [Gesture quiz](#gesture-quiz-play)), and a teacher
can give that quiz to students as a link and watch their ranking (see [Giao bài](#giao-bài-assignments)). Auth (JWT access token + HttpOnly
refresh cookie) and the AI image-to-CSV endpoint are served by the sibling `../Server` Go API
(see `../Server/AGENTS.md`).

## Commands

Run from this directory (`Client/`):

```bash
npm start              # ng serve, dev config, http://localhost:4200
npm run dev-start       # same as above, explicit --configuration development
npm run build           # ng build (production config by default)
npm run watch           # ng build --watch --configuration development
npm test                # ng test (Karma + Jasmine)
```

To run a single spec file, pass it to the Karma builder, e.g.:
```bash
ng test --include='**/csv-import.service.spec.ts'
ng test --watch=false --browsers=ChromeHeadless   # one-shot run, e.g. for CI
```

There is no e2e test setup and no lint script configured in `package.json`.

## Architecture

### Backend URL

There are no environment files: every HTTP service calls the API by relative URL (`/api/...`),
because the API is always on the SPA's own origin. In production the root `vercel.json` routes
`/api/*` to the Go service of the same deployment (the client's build command, output dir and SPA
fallback live in its `client` service); locally `ng serve` proxies `/api` to
`http://localhost:7071` via `proxy.conf.json` (the `proxyConfig` option in `angular.json`).

### Auth flow (access token in memory, refresh token in cookie)

- `AuthService` holds the access token only in memory (a plain field, not persisted) — a page
  reload always starts logged-out until the refresh flow below runs.
- `AuthService` calls `POST /api/auth/login` and `POST /api/auth/refresh`; being same-origin, the
  browser sends and stores the server's HttpOnly `SameSite=Strict` refresh cookie on its own. On
  success it pushes the returned `accessToken` into `AuthService`.
- `app.config.ts` calls `AuthService.refreshToken()` via `provideAppInitializer`, swallowing
  errors — so on every app boot, an existing refresh cookie silently re-establishes a session
  before any component renders.
- `AuthInterceptor` (registered via the legacy `HTTP_INTERCEPTORS` DI token, not
  `HttpInterceptorFn`) attaches `Authorization: Bearer <token>` to every request, and on a 401
  (except from `/api/auth/refresh` itself, to avoid a loop) transparently calls `refreshToken()`,
  queues any other in-flight requests behind a `BehaviorSubject` until the refresh resolves, then
  retries with the new token. A failed refresh clears the token but does not redirect.
- `/quiz` (the vocabulary table), `/play` (the gesture quiz, from a file or the sample) and `/play/s/:code`
  (a student's link to an assignment, which has no account) are open to anonymous users; only `/ai` (AI
  generation), `/ai-history` (its history), `/play/:jobId` (a gesture quiz taken from one of the user's AI jobs), `/play/preview/:assignmentId`
  and the `/assignments` pages need a login, enforced by `authGuard` (`services/auth.guard.ts`), which redirects to
  `/login?returnUrl=/ai`. `LoginComponent` navigates to `returnUrl` after login (only in-app paths
  are accepted, otherwise `/quiz`). A 401 from the AI endpoint sends the user the same way. The
  table survives these trips (and reloads) because `VocabularyTable` keeps its rows and template as
  a draft in `localStorage` (`vocabulary-table-draft`).

### Vocabulary table & CSV pipeline

`Workspace` (`src/components/workspace/`) is the shell of the main screens: a collapsible side menu (an
inline `nz-menu` built from `NAV`: "Quiz thủ công", then the groups "AI" with "Tạo quiz" and "Lịch sử", and
"Game" with "Chơi game" and "Bài đã giao", plus the login/logout item at its foot and, at its
top, the collapse switch: a double-left/double-right icon button with a tooltip), a breadcrumb (`breadcrumbFor`, with its spec: group › page, and "Bảng xếp hạng" under "Bài đã giao" on an
assignment's ranking, which is why that page has no back link) and the title. The pages are highlighted via
`nzMatchRouter`, "Chơi game" never is because it leaves the frame for the full-screen `/play` page (see
[Gesture quiz](#gesture-quiz-play)). The groups are open whenever the menu is; collapsed, the menu shows only
icons and the groups become fly-outs. The wide layout remembers the collapse in `localStorage`
(`workspace-nav-collapsed`); under 768px the menu always starts collapsed and, opened, lies over the page
until a page is picked. The menu navigates between its child routes
`/quiz` (`VocabularyTable`), `/ai` (`AiGeneration`, `src/components/ai-generation/`), `/ai-history` (`AiJobs`, below) and the teacher's
`/assignments` pages (see [Giao bài](#giao-bài-assignments)); `WorkspaceMode` knows all four, and logging out
on any page but `/quiz`, which all need a login, falls back to `/quiz`. The AI
request runs on the server (see below), so `/ai` can be left freely once it has been sent. Each screen has a `UsageGuide` (`src/components/usage-guide/`), a "Hướng dẫn sử dụng" button above the table or AI form
that opens the how-to in a popup (`nz-modal`), so the page keeps its full width; keep its text in step with the screen when the flow changes.

`VocabularyTable` (`src/components/vocabulary-table/`) is the manual screen: a reactive `FormArray`
of `question`/`answer` `FormGroup`s (`QuestionDefinitionForm`), with a form-level
`duplicateValidator` that cross-checks all rows for duplicate questions or answers and tags the
offending controls with a custom `duplicate` error (see `Utils.addError`/`removeError`, which
merge/split error keys without clobbering other validators' errors on the same control).

Three ways to populate rows, all converging on `QuestionDefinition[]`:
1. Manual row add/edit/delete in the table.
2. `importFromCsv` → `CsvImportService.parseCsv`, a hand-rolled RFC4180-ish CSV parser (handles
   quoted fields, escaped quotes, `\r\n`/`\n`) that locates the question/answer columns by matching
   diacritic-stripped headers `"cauhoi"`/`"dapan"` (i.e. Vietnamese "Câu hỏi"/"Đáp án" with accents
   removed), falling back to columns 0/1 if headers don't match.
3. The `/ai` page, `AiGeneration` (drag-drop / paste / file-picker for one or more images,
   `AIGenerationMode.Formatted` or `.Auto` chosen in the page's form) →
   `AiCsvService.submitFormatted`/`submitCreative` posts it to the Server's `/api/csv/jobs`, which answers
   `202 {id}` at once and goes on working. The page then shows a "Đã gửi yêu cầu" notice; the result is
   not awaited. `AiJobService` (root service) keeps the user's jobs in a signal (`GET /api/csv/jobs`),
   polling every 3 s while any job runs (`watch(idlePolls)`; stops after N answers without a running job
   or 10 failed ones, and is reset by `AuthService.cleared$` on logout) and announcing each job that
   finishes. `AiJobs` (`src/components/ai-jobs/`, the page of "AI › Lịch sử" in the menu, `/ai-history`) is the history table: client-side search
   (`filterJobs` in `models/ai-job.ts`: accent- and case-insensitive over title, error and the generated
   CSV) and status/mode/platform/course type/HSK standard/level/lesson filters (the last four match the
   lesson fields the server keeps on creative jobs), a "Thao tác" dropdown (`⋯`) on each finished row, which holds every action of the job: "Xem kết quả" (the result as a table in a popup; Auto jobs' headerless CSV gets the platform's column names, `CREATIVE_COLUMNS` in `ai-jobs.ts`), the delivery actions below, and "Xóa" (confirmed in a modal, because a popconfirm cannot live inside a menu item). A running job has no menu.
   The delivery actions per job: The two modes diverge there (see
   [../AGENTS.md](../AGENTS.md#the-two-ai-generation-modes) for the full picture):
   - **`Formatted`** → on "Mở trong bảng", the job's text is cleaned by `AiCsvService.extractCsvContent` (strips markdown
     code fences, or extracts from the first Vietnamese CSV header it finds) → re-parsed by the same
     `CsvImportService.parseCsv` → rows left in `PendingImportService` (in memory) and the app
     navigates to `/quiz`, where `VocabularyTable.ngOnInit` takes them and adds them like any other
     import.
   - **`Auto`** (requires `courseType`/`lessonNumber`/`exportType` in the page's form, plus `level`
     for HSK/YCT — with `hskStandard` 2.0/3.0 for HSK — or `courseName` for `Other`, and for Game
     `gestureStages`, a checkbox per game with at least one ticked, and `questionsPerStage`, 4–10; images are
     optional here. The two quiz controls are validated only for that platform, their limits and the sanitizers
     that read them back from the saved settings are `models/gesture-quiz-options.ts`, and `AiCsvService` sends
     them only for GestureQuiz; the form defaults to HSK 3.0) → the job's CSV
     has no header rows → on "Tải file" (or, for Wayground, "Tiện ích tự publish") `AiJobs.exportJob(job, publish)` passes it to
     `FileExportService.exportFileFromCsvContent`, which
     calls the matching `CsvBuilder.buildFromCsvContent` to prepend the platform's `CsvHeader` and
     downloads (or the extension takes it, when the user clicked the publish button). A Game
     job also has "Chơi ngay" (`AiJobs.play(job)`, navigates to `/play/<job id>`), the primary action
     there, with "Tải file" only keeping the quiz, and "Giao bài" (`AiJobs.assign(job)`, which opens
     `AssignDialog`, see [Giao bài](#giao-bài-assignments)). The vocabulary table is never touched in this path.

**Textbooks.** `models/textbook.ts` (`TEXTBOOKS`, `textbookFor(courseType, hskStandard, level)`, with its spec) is a
hand-kept mirror of the server's registry of curated books (`Server/internal/csvgen/textbooks.go`): HSK 3.0 levels 1–3
and YCT 6 for now. For these the server sends the lesson's real material to the AI, so no photo is needed. In Auto
mode `AiGeneration` looks the book up from course type, standard and level (the `textbook` getter, like `maxLevel`)
and shows under the Cấp/Bài row either "Dùng giáo trình …" or a muted "Chưa có giáo trình …" line; the Bài box is
capped at the book's `lessons` (100 without a book), and a lesson left over the cap (HSK 3.0 level 3 lesson 18, then
level 1) gets a `max` error from the form validator like the level's, so the form cannot be submitted. Adding a book
means editing both lists together; the server also checks the lesson number (400 `Lesson must be 1 to <M> …`).

Export: `exportFile()` validates the form, then `FileExportService` dispatches to `GimkitCsvBuilder`,
`BlooketCsvBuilder`, or `WaygroundCsvBuilder` (all extend `CsvBuilderBase`, selected by the
`exportType` form control, `ExportType` enum) based on the target platform's required CSV shape. A fourth,
`GestureQuizCsvBuilder` (`services/gesture-quiz-csv-builder.ts`), serves only the AI's Game output: it
carries the header (`GESTURE_QUIZ_COLUMNS`) for `buildFromCsvContent`, while its `buildFromRows` throws, because
the table's rows have no stages, so the vocabulary table's platform select does not list the platform.
GimKit/Blooket builders synthesize incorrect-answer distractors by randomly sampling other rows'
answers via `Utils.getRandomItem`/`shuffle`, so a builder run needs at least a few rows or the "pick
a distinct wrong answer" loop can spin/repeat. `Utils.escapeCsvField` handles quoting for the
generated CSV (not the same code path as the import parser). `FileExportService.buildFile` then
picks the output format per platform: GimKit/Blooket/Game download as `.csv` directly; Wayground is
converted to `.xlsx` via the `xlsx` package first (`FileExportService.buildXlsx`). Both export methods
return an `ExportedFile` (`fileName`, plus the `xlsx` bytes for Wayground) and take a `download` flag.
`buildFileName` makes `<label>-<platform>.csv` with spaces turned into dashes in the platform's name too
(`platformName` of Game is "Game", so `HSK3-Bai5-Game.csv`).
For Wayground the table page shows a `WaygroundDelivery` radio (download vs. extension, preference held
by `WaygroundExtensionService.preferredDelivery`); the AI jobs table has no such setting and offers both
buttons on each finished Wayground job, the extension one disabled without `../Extension`. When the
extension is used, the file is not downloaded and `WaygroundExtensionService.sendImport` hands the bytes to it. The
extension imports and publishes the quiz in the user's Wayground tab, and the service later shows the
share link it sends back (see [../AGENTS.md](../AGENTS.md#the-wayground-browser-extension)).

### Gesture quiz (`/play`)

The AI's Game output (`ExportType.GestureQuiz`, ordinal 3) is played in the app, not imported
anywhere; the CSV contract, the stage ladder (1 to 6 of the six games, chosen on the AI form) and the pass rule are in
[../AGENTS.md](../AGENTS.md#the-gesture-quiz-game). This section is the client's half.

**Routes.** `app.routes.ts` declares four `loadComponent` routes for `GesturePlay`, placed *outside* the
`Workspace` route so the game fills the screen with no menu: `play` (a file or the sample), `play/s/:code` (a
student's assignment, no guard), `play/preview/:assignmentId` and `play/:jobId` (both with `authGuard`).
The page picks its *mode* from which parameter the route has (see [Giao bài](#giao-bài-assignments)).
These were the app's first lazy routes: the page, the six games and MediaPipe stay out of the initial
bundle, and a player who never opens `/play` never downloads them. `OnlineStatusService` leaves every
`/play` URL alone when the connection drops (`GESTURE_PLAY_URL` matches `/play` and anything below it, so
`/play/:jobId`, `/play/s/:code` and `/play/preview/...` too) instead of sending the player to `/offline`,
since a loaded game runs entirely in the browser (a student's result that cannot be sent is queued, see
below).

**The page** (`components/gesture-play/`, `GesturePlay`) is a state machine over a `screen` signal:
`loading`/`error` (every mode but `/play`; for `/play/:jobId` the job is taken from `AiJobService.jobs()` or,
when the list is empty, fetched once with `refresh()`, and a job that is missing, still running, failed or
not a GestureQuiz shows its own message; the other two fetch their quiz from the server), `join` (a student's
first screen on `/play/s/:code`, `ShareJoin`), `load` (`/play`: "Mở file quiz" reads a `.csv` with `FileReader`, "Chơi thử quiz
mẫu" uses `game/demo-quiz.ts`; both go through `CsvImportService.parseCsvRows` and `parseGestureQuiz`, with
a warning when rows were `skipped`), `map` (`GestureStageMap`, `stage-map/`: a card for each stage the quiz has, numbered by its
position (`stagePosition`), with its questions, best result and passed/locked status, the time-mode and sound settings and a progress reset), `intro`
(the stage's hint, camera switch and preview, status chips), `playing` and `result` (`GestureStageResult`,
`stage-result/`: the verdict against the pass mark, the missed questions with their explanations, next
stage / retry / map). `gesture-engine.ts` holds the pure part, with its spec: `prepareQuestion` turns a
`GestureQuestion` into what is played (stage 1 is always `['Đúng', 'Sai']`, stages 2–5 shuffle the correct
answer in with the wrong ones, stage 6 shuffles the chunks to an order that is not the answer),
`judge`/`timeoutReveal`, `correctAnswerText`, `timeLimitFor` (the stage's seconds, ×1.5 or none, per
`TimeMode`) and `titleFromFileName`. The page keeps the run (questions, score, streak, missed list) and
records it with `GestureProgressService.record` when the run finishes (after the last question's feedback);
a teacher's preview does not record, and a student's run is also reported to the server (see
[Giao bài](#giao-bài-assignments)).

**The engine** (`src/game/`, shared by the page and the games):
- `stage-game.ts` is the contract between the page and a game. `StageGameBase` is an abstract directive:
  inputs `question` (`QuestionView`), `reveal` (`Reveal | null`), `paused`, `cameraActive`; output `choose`
  (a `Choice`: the index into `options`, or for stage 6 the chunks in the order pointed at); a `ready` signal
  (a face game holds it false until the player's neutral pose is calibrated, and the page's timer waits);
  and the hooks `onFrame(frame, now)` and `tick(dt, now)`. Each game component provides itself as
  `StageGameBase` (`useExisting`), so the page reaches whichever one is on screen with a single
  `viewChild(StageGameBase)`. The page owns shuffling, judging, the timer, the score and the feedback; a game
  only turns input into a `Choice` and shows the `reveal` it is sent, and while a `reveal` is set or the page
  is `paused` it must ignore all input and not emit.
- `vision.service.ts` (`VisionService`, root) owns the camera and both MediaPipe models. `startCamera` never
  throws (every failure becomes a `cameraState` and a Vietnamese `cameraMessage`: the quiz stays playable
  with the mouse), the one `<video>` element is reused for the whole session (the page moves it into the
  stage or the intro preview and mirrors it with CSS; MediaPipe is fed the unmirrored frame, so a game that
  draws on the preview flips x itself with `mirrorX`/`mapToStage`), and `detect(kind, now)` returns the latest
  `HandFrame` (landmarks + canned gesture, from MediaPipe's GestureRecognizer) or `FaceFrame` (landmarks +
  blendshapes, from the FaceLandmarker), or `null` when there is nothing new.
- `gestures.ts` has the pure detectors, tested with synthetic landmarks: `HoldGate` ("return to neutral,
  then hold one choice"), `TiltGate`/`eyeRoll`/`headSignal`, `countExtendedFingers` (index to pinky; the thumb
  is ignored), `PinchDetector`, `BiteDetector` (jawOpen blendshape), `thumbChoice`, `segHit` (a slash tested
  as a segment, so a fast swipe cannot jump over a fruit between two frames), the 1-euro smoothers and the
  mapping helpers. `hold-select.ts` adds what the two hold-a-pose games (true/false and finger count) share:
  `HoldSelector` (a `HoldGate` plus its sounds), `StableReading` (a pose must be reported several frames in a
  row before it counts) and the key/ring helpers. `game-audio.ts` (`GameAudio`) synthesizes every sound with
  Web Audio (no files) and must be `resume()`d from a user gesture. `stages.ts` is the `STAGES` table (game,
  icon, hint, vision kind, option count, seconds per question), `PASS_RATIO`, `passMark` and `stagePosition`
  (the number a stage is shown with: its position among the stages a quiz has, while the stage number stays
  the game's identity in data). The intro, the HUD and the result (`StageRunResult.position`) show it too.

**The loop.** `GesturePlay` runs one `requestAnimationFrame` loop outside the Angular zone (one frame every
16 ms must not trigger change detection): while a stage is playing and not paused it calls
`vision.detect(def.vision, now)` → `game.onFrame` → `game.tick`, then either advances after a judged answer
(2.5 s after a right one, 4 s after a wrong one, so the explanation can be read) or runs the question's
timer, which only counts while `game.ready()`. Whatever a frame changes on screen goes through a signal, or
through `inZone` when the whole page must be checked (a game's `choose` can arrive from the loop). A hidden tab
pauses the game; `P` pauses and `Enter` moves on after a judged answer.

**Games** live in `components/gesture-play/games/<kind>-game/` (`true-false-game`, `head-tilt-game`,
`frog-bite-game`, `fruit-slice-game`, `finger-count-game`, `word-order-game`), each a component plus its
template/stylesheet and a `*-logic.ts` (`fruit-slice-physics.ts` for the fruit game) with the rules as pure
functions. The two face games share `head-tilt-game/face-common.ts` (head pose, the one-second calibration
of the neutral pose, status messages) and `face-calibration-panel.ts`; `face-fixture.ts` makes synthetic
`FaceFrame`s for specs only. Besides the camera every game takes mouse or touch, and keys (digits pick the
option; the head-tilt game also ← →; the frog moves with ← ↓ → and bites with Space; the word-order game uses
digits for tiles and Backspace to undo).

**MediaPipe loading.** `@mediapipe/tasks-vision` is pinned to `1.1.0` (exact, no range) and imported with a
dynamic `import()` inside `VisionService.loadRuntime` (the rest of the file only imports its *types*), so it
becomes a lazy chunk fetched when a player turns the camera on. The WASM runtime is not bundled: an `assets`
glob in `angular.json` copies only the two builds it needs, `vision_wasm_internal` and
`vision_wasm_nosimd_internal`, from `node_modules/@mediapipe/tasks-vision/wasm` to `/mediapipe/wasm`, and
`FilesetResolver.forVisionTasks('/mediapipe/wasm')` loads it from the app's own origin. The models
(`gesture_recognizer.task`, `face_landmarker.task`, float16) are too big to ship and are fetched from
`storage.googleapis.com/mediapipe-models/…`, first the kind the opened stage needs, then (once that one is
ready and the camera is on) the other kind the quiz needs, in the background and never while playing. Both
models try the GPU delegate and fall back to the CPU one. A load has a 30 s timeout; a model that fails 6 detections in a row is dropped and rebuilt on the next
`ensureModel`. A model that cannot be loaded does not block the game: the chips and a notice say so and the
mouse and keyboard still work. Upgrading MediaPipe means checking that the two WASM file names above still
exist.

**Storage.** `GestureProgressService` keeps `localStorage['gesture-quiz-progress']`: per quiz `key` (a content
hash from `parseGestureQuiz`, not the title), the stages passed and the best result of each. A stage is
unlocked when every earlier stage that has questions is passed (`isUnlocked`); `record` re-reads the storage
before writing so a second tab's progress is not overwritten, and a pass is never taken back. The player's
settings (`GestureSettingsService`, `localStorage['gesture-quiz-settings']`: `timeMode`, `sound`, and `useCamera`,
which makes the next stage or visit start the camera by itself and is cleared when the player turns the camera
off or it cannot be started) are separate. Both stores are sanitized on load and survive blocked storage.
A student's progress on an assignment lives in the same store under its own key (`asg:<CODE>:<playerId>`),
and the player's `timeMode` setting is ignored for an assignment, see [Giao bài](#giao-bài-assignments).

**Specs** (Karma/Jasmine, no camera needed): `models/gesture-quiz.spec.ts` (the parser), `services/gesture-progress.service.spec.ts`,
`game/gestures.spec.ts`, `game/hold-select.spec.ts`, `game/vision.service.spec.ts` (with a fake camera; the
MediaPipe-result converters are tested from plain objects), `gesture-engine.spec.ts`, `gesture-play.spec.ts`
(the page against a `FakeVision`, including its shared and preview modes), and a `*-game.spec.ts` plus `*-logic.spec.ts` for every game; the Quiz
cử chỉ export is covered in `file-export.service.spec.ts`. None of them runs MediaPipe, so real recognition
(lighting, distance, thresholds) can only be tried by hand on a machine with a webcam.

### Giao bài (assignments)

A teacher gives a finished Game job to students, who play it by link with no account; the rules
(snapshot, code, player token, result and ranking contract, closing) are in
[../AGENTS.md](../AGENTS.md#giao-bài-assignments). This section is the client's half. The shapes of the API
are `src/models/assignment.ts` (`Assignment`, `AssignmentDetail`, `RankedPlayer`, `SharedQuiz`, `NewAssignment`,
`AssignmentChange`, kept in step with the Go JSON by hand), which also holds the pure helpers: `shareUrl`
(`<origin>/play/s/<code>`), `stageCountsOf` (the question count of each stage of a parsed quiz, sent when
assigning), `isOpenAt` and `assignmentStatusText` (recomputed from the two times, since the `open` flag is only
as fresh as the response), `assignmentErrorMessage` (the server's plain-text bodies in Vietnamese) and
`rankingCsv`.

**Routes and menu.** Inside `Workspace`, `assignments` (`AssignmentList`) and `assignments/:id`
(`AssignmentRanking`) are lazy `loadComponent` routes with `authGuard`, and "Bài đã giao" (`trophy` icon,
`nzMatchRouter`) is their menu item. `play/s/:code` and `play/preview/:assignmentId` are the two `GesturePlay`
routes added for this (see above for their guards).

**Services.**
- `AssignmentService` (`services/assignment.service.ts`, the teacher's side) is stateless HTTP: `create`,
  `list`, `get`, `update`, `remove`, `removePlayer`. Every page asks the server for what it shows, so the
  list and a ranking page never disagree over an old copy. `remove`/`removePlayer` treat a 404 as done, like an
  AI job's delete.
- `SharedPlayService` (`services/shared-play.service.ts`, the student's side, used only by the lazy page):
  `load(code)` and `join(code, name)`; `identity(code)` and `forget(code)` over
  `localStorage['gesture-shared-players']` (`{CODE: {playerId, token, name}}`); `submit(code, {stage, correct,
  total})` and `flush(code)` over `localStorage['gesture-shared-pending']`. `submit` never errors, its result
  says what became of the run: `saved`; `queued` (the server could not be reached, status 0, or failed, 5xx:
  the run goes to the pending queue); `closed` (410); `rejected` (any other final answer, such as 400 or 403,
  or no identity on this device; a 403, which means the teacher removed the student, also forgets the
  identity). It makes the `runId` once (`crypto.randomUUID()`, with a hex fallback because a classroom may open
  the link over plain http on a local network, where `randomUUID` does not exist), and a queued entry keeps its
  own token and `runId`, so a resend, even after a reload or a "Không phải bạn?", is the same run and the
  server counts it once. `flush` resends
  the code's queue oldest first, one at a time, re-reading the stored queue before each send (a second tab may
  have delivered one); an answer that is final, good or bad, takes the entry out, a transient one leaves the
  rest for next time. A successful `submit` flushes the queue by itself, and the page flushes after opening a
  quiz the device already joined, after joining, and on the window's `online` event (shared mode only). The
  queue holds at most 200 runs. Both values are sanitized on read and fall back to memory when `localStorage` is blocked.

**`GesturePlay` modes.** `mode` (`local` | `job` | `shared` | `preview`) is taken from the route's parameters
(`code`, `assignmentId`, `jobId`, none) and re-evaluated when they change under the same component:

| | `local` | `job` | `shared` | `preview` |
|---|---|---|---|---|
| Route | `/play` | `/play/:jobId` | `/play/s/:code` | `/play/preview/:assignmentId` |
| Quiz comes from | a file or the sample | `AiJobService` | `SharedPlayService.load` | `AssignmentService.get`, the snapshot |
| Topbar link | Về bảng quiz, Mở quiz khác | Về lịch sử AI | none | Về bảng xếp hạng |
| Progress key | the quiz's hash | the quiz's hash | `asg:<CODE>:<playerId>` | the quiz's hash, never written |
| Time mode | the player's setting | the player's setting | the teacher's, fixed | the teacher's, fixed |
| Map | locks, reset | locks, reset | locks, no reset | every stage open, no reset |
| Before a stage | | | the closed check | |
| Finished run | recorded locally | recorded locally | recorded locally, reported | nothing recorded or sent |

- **Shared mode.** `quiz` is `baseQuiz` under the key `asg:<CODE>:<playerId>` (the code upper-cased), so
  `GestureProgressService` keeps each student's locks and bests apart from other students' and from the same
  quiz played as a file or a job (a student who joins again under a new name starts over). A quiz the device
  already joined goes straight to the map, otherwise to the `join` screen, which is `ShareJoin`
  (`gesture-play/share-join/`: inputs `title`, `label`, `closesAt`, `error`, `busy`, output `join` with the
  trimmed name). It only collects the name: the page does the join and words the failure in `joinProblem`
  (`Name taken`, `Assignment is full`, a bad name, offline). The map shows "👤 name · Không phải bạn?" (a link that
  forgets the identity and returns to the join screen) and the closing time, projected into `GestureStageMap`.
  The timer reads `effectiveTimeMode`, the teacher's `assignmentTimeMode` before the player's own setting.
  A student has no way out of the page, and the error cards (not found, closed, could not load) have no link.
- **The check before each stage** (`guardSharedStage`, for opening a stage's intro, replaying it and "Màn tiếp
  theo"): the stored identity must still be there (a rejected result or another tab may have removed it,
  otherwise the join screen comes back), the stage must be open for this student, and the page asks the server
  again (`SharedPlayService.load`, with a 4 s timeout, behind a spinner "Đang kiểm tra bài…"). A 404 or 410
  shows the error card ("Không tìm thấy bài này", or "Bài này đã đóng"); any other failure (offline, slow, 5xx) lets the student play,
  because their result is queued, and an answer refreshes the label and closing time. The locks of the map are
  the client's own (`GestureProgressService.isUnlocked`); the server does not know the order.
- **Saving the result.** `finishRun` calls `saveResult` in shared mode, which sets `saveState` to `saving`,
  then to the outcome of `submit`; `GestureStageResult` shows it from its `saveState` input (the texts are
  `SAVE_TEXT`: "Đang lưu kết quả…", "Đã lưu kết quả cho thầy cô ✓", queued, closed, rejected). A counter
  (`submitSeq`) stops a slow answer of an older run overwriting a newer run's state, and the request is not tied
  to the page, so a student who leaves right after finishing does not cancel it.
- **Preview.** The teacher's try-out of an assignment: `loadPreview` takes `AssignmentService.get`'s snapshot
  and time mode, every stage with questions is open (`allOpen` on the map, `openIntro` skips the lock check),
  `finishRun` works the verdict out with `passMark` instead of recording, and `hasNext` is true whenever a later
  stage has questions (so `GestureStageResult` offers "Màn tiếp theo" on `hasNext` alone, not only after a
  pass). No result is recorded or sent anywhere. A banner says so on every screen but loading and error,
  and the result screen's `preview` input shows that in place of a save state. It reads (never writes) the
  quiz's own progress key, so the map may show the teacher's earlier results of the same quiz from `/play`. It
  works on a closed assignment, and a missing one gets an error card with a link to `/assignments`.
- **Inputs added to the map and the result.** `GestureStageMap`: `lockedTimeMode` (the teacher's mode, shown as
  text instead of the radios), `allowReset` (false hides "Chơi lại từ đầu": a student's results are the
  teacher's), `allOpen`, and a content projection above its summary. `GestureStageResult`: `saveState` and
  `preview`.

**Teacher components** (`src/components/assignments/`, all with their own spec):
- `AssignDialog` (`assign-dialog/`, `app-assign-dialog`: input `job`, `[(open)]`, output `created`) is mounted by
  `AiJobs` and opened by "Giao bài" on a done GestureQuiz job. It parses the job's CSV the way the game does
  (`extractCsvContent`, `parseCsvRows`, `parseGestureQuiz`) to show the question count and build `stageCounts`,
  and refuses a quiz with no questions. The form is the label (optional, 60 characters), the closing time
  (`DeadlinePicker`) and the time mode (all students share it); "Xem thử" there opens the plain job,
  `/play/<job id>`, in a new tab. After `create` the dialog shows the link (`ShareLink`), "Xem thử" (now
  `/play/preview/<id>`) and "Xem bảng xếp hạng". It starts over each time it is opened.
- `DeadlinePicker` (`deadline-picker/`: `value = model<Date | null>()`) offers no closing time, 45 minutes,
  the end of today, or a time picked with a native `datetime-local` input (no `nz-date-picker`). The presets are
  the pure `deadlineFromPreset(preset, now, custom)` in `deadline-picker-logic.ts` (the end of today is 23:59,
  or of tomorrow when under 10 minutes of today are left), with `toLocalInputValue`/`fromLocalInputValue`,
  which refuses a date that does not exist (31 February). A closing time in the past is flagged, since the
  server refuses it.
- `ShareLink` (`share-link/`: inputs `code`, `qrSize`) shows the link with a copy button (the field is selected
  for Ctrl+C when the clipboard is not available), an `nz-qrcode` of it and the code.
- `AssignmentList` (`assignment-list/`, `/assignments`): a table of the assignments, newest first, with the
  title and label, the status tag (`assignmentStatusText`), the student count and when it was assigned. Row
  actions, all in one "Thao tác" dropdown: "Xếp hạng", copy link, QR (a popup with `ShareLink`), "Đóng bài" (confirmed in a modal) or "Mở lại" (a popup
  with `DeadlinePicker`: a reopen always sends a closing time or `null`, because the server refuses one that
  would close at once), and "Xóa" (confirmed in a modal, it also deletes the students' results). A 30 s tick makes an
  assignment whose closing time passes show as closed without a reload.
- `AssignmentRanking` (`assignment-ranking/`, `/assignments/:id`, with `assignment-ranking-logic.ts` for the
  pure parts: `shouldPoll`, `medal`, `stageCell`, `fileNameFor`). The header has the status and time mode and
  the actions: copy link, QR (a big code for a projector), "Xem thử" (`/play/preview/<id>`), "Đóng bài" and
  "Hẹn giờ đóng" while it is open, "Mở lại" when closed, "Tải bảng điểm" and "Toàn màn hình" (full-screens the
  ranking card, not the page). The table shows the server's order: rank (🥇🥈🥉 for the top three, "–" for a
  student with no result), name, stages passed, correct over possible, one column per stage of the quiz (headed "Màn <position>", best
  `correct/total`, ✓ when passed), attempts, last played, and a confirmed "remove student". It polls
  `GET assignments/{id}` every 5 s while `shouldPoll` (open, or less than 5 minutes after the effective close,
  which mirrors the server's `ResultGrace`) and the tab is visible; otherwise there is only the "Làm mới"
  button, and a tab that comes back to the front catches up at once. Requests are numbered and an answer older
  than the one on screen is dropped, so a poll sent before a close or a removal cannot undo it; a change's
  answer is merged into the page keeping the students; a failed poll keeps the last data and says "Chưa cập
  nhật được"; a 404 shows a not-found state. "Tải bảng điểm" is `rankingCsv` (stage columns headed `Màn 1 (Chém hoa quả)`, a BOM so Excel reads UTF-8, CRLF
  line ends, a leading apostrophe on a name that starts with `=`, `+`, `-`, `@`, tab or CR so a spreadsheet does
  not run it as a formula), named `<title>[-<label>]-bang-xep-hang.csv` by `fileNameFor`.

**Specs** (Karma/Jasmine): `models/assignment.spec.ts`, `services/assignment.service.spec.ts`,
`services/shared-play.service.spec.ts` (join and identity, every `submit` outcome, the queue and `flush`, blocked
storage), one per component under `components/assignments/` plus `assignment-ranking-logic.spec.ts` and
`deadline-picker-logic.spec.ts`, `gesture-play/share-join/share-join.spec.ts`, and in `gesture-play.spec.ts` the
groups "a shared quiz (a student)" (opening and joining, quizzes that cannot be opened, the map and topbar,
progress, the check before a stage, saving a result) and "a preview (the teacher)". `GestureStageMap` and
`GestureStageResult` have no spec of their own: their new inputs are covered through the page spec.

### UI library

ng-zorro-antd (Ant Design for Angular) components are imported individually per-component (e.g.
`NzButtonComponent`, `NzTableModule`) rather than as one shared module, consistent with standalone
component conventions. Styling is centralized so every library component looks the same on every screen, including
overlays (modals, confirms, dropdowns, notifications) that render outside any component:
- `src/theme.less` sets ng-zorro's Less variables (primary pink, border color, radius, …).
- `src/styles.css` holds the design tokens (`--qt-*` custom properties on `:root`), the page
  background, the `.qt-centered-page` layout helper, `.text-error`, and global overrides of `.ant-*`
  classes for what Less variables can't express (gradient buttons/headers, 2px borders, focus glow).
  `--qt-font-han` is the font stack of the gesture quiz's hanzi: Latin UI fonts first (they have no CJK
  glyphs, so Vietnamese and pinyin keep a readable face), then the Kai (handwriting-style) faces, so only
  the hanzi fall through to a Kai font. Use it on text that shows Chinese characters instead of naming
  a CJK font.
- Component stylesheets hold only layout and sizing. Don't restyle library colors there or reach
  for `::ng-deep` without `:host` (that leaks globally); add or change a global override instead,
  and use `nzType`/`nzSize` (e.g. `nzType="primary"` for the main action) rather than CSS.
- Read https://ng.ant.design/llms-full.txt and understand NG-ZORRO components. Use this knowledge when writing code with NG-ZORRO
`provideNzI18n(en_US)` is set in `app.config.ts` despite most user-facing
notification strings in the codebase being written in Vietnamese directly at the call site (not via
i18n).
