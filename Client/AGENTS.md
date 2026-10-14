# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

The Angular (v22, standalone components) frontend for QuizTool. It lets a user build a table of
question/answer vocabulary pairs (manually, via CSV import, or via AI generation), then export
them as a CSV formatted for GimKit or Blooket import, or as an `.xlsx` for Wayground. The AI can also
write a "Quiz cử chỉ" quiz, which is not exported anywhere: the app plays it itself, on a full-screen
page that reads the player's gestures from the webcam (see [Gesture quiz](#gesture-quiz-play)). Auth (JWT access token + HttpOnly
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
- `/quiz` (the vocabulary table) and `/play` (the gesture quiz, from a file or the sample) are open to
  anonymous users; only `/ai` (AI generation) and `/play/:jobId` (a gesture quiz taken from one of the
  user's AI jobs) need a login, enforced by `authGuard` (`services/auth.guard.ts`), which redirects to
  `/login?returnUrl=/ai`. `LoginComponent` navigates to `returnUrl` after login (only in-app paths
  are accepted, otherwise `/quiz`). A 401 from the AI endpoint sends the user the same way. The
  table survives these trips (and reloads) because `VocabularyTable` keeps its rows and template as
  a draft in `localStorage` (`vocabulary-table-draft`).

### Vocabulary table & CSV pipeline

`Workspace` (`src/components/workspace/`) is the shell of the two main screens: a horizontal `nz-menu`
(three `routerLink` items, "Tạo thủ công", "Tạo bằng AI" and "Quiz cử chỉ", plus the login/logout item;
the first two are highlighted via `nzMatchRouter`, the third never is because it leaves the frame for
the full-screen `/play` page, see [Gesture quiz](#gesture-quiz-play)) and the title. The menu navigates between its child routes
`/quiz` (`VocabularyTable`) and `/ai` (`AiGeneration`, `src/components/ai-generation/`). The AI
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
   finishes. `AiJobs` (`src/components/ai-jobs/`, below the form) is the history table: client-side search
   (`filterJobs` in `models/ai-job.ts`: accent- and case-insensitive over title, error and the generated
   CSV) and status/mode/platform/course type/HSK standard/level/lesson filters (the last four match the
   lesson fields the server keeps on creative jobs), an eye button that opens the result as a table in a popup (Auto jobs' headerless CSV gets the platform's column names, `CREATIVE_COLUMNS` in `ai-jobs.ts`), delete, and the
   delivery actions per job. The two modes diverge there (see
   [../AGENTS.md](../AGENTS.md#the-two-ai-generation-modes) for the full picture):
   - **`Formatted`** → on "Mở trong bảng", the job's text is cleaned by `AiCsvService.extractCsvContent` (strips markdown
     code fences, or extracts from the first Vietnamese CSV header it finds) → re-parsed by the same
     `CsvImportService.parseCsv` → rows left in `PendingImportService` (in memory) and the app
     navigates to `/quiz`, where `VocabularyTable.ngOnInit` takes them and adds them like any other
     import.
   - **`Auto`** (requires `courseType`/`lessonNumber`/`exportType` in the page's form, plus `level`
     for HSK/YCT — with `hskStandard` 2.0/3.0 for HSK — or `courseName` for `Other`; images are optional here) → the job's CSV
     has no header rows → on "Tải file" (or, for Wayground, "Tiện ích tự publish") `AiJobs.exportJob(job, publish)` passes it to
     `FileExportService.exportFileFromCsvContent`, which
     calls the matching `CsvBuilder.buildFromCsvContent` to prepend the platform's `CsvHeader` and
     downloads (or the extension takes it, when the user clicked the publish button). A Quiz cử chỉ
     job also has "Chơi ngay" (`AiJobs.play(job)`, navigates to `/play/<job id>`), the primary action
     there, with "Tải file" only keeping the quiz. The vocabulary table is never touched in this path.

Export: `exportFile()` validates the form, then `FileExportService` dispatches to `GimkitCsvBuilder`,
`BlooketCsvBuilder`, or `WaygroundCsvBuilder` (all extend `CsvBuilderBase`, selected by the
`exportType` form control, `ExportType` enum) based on the target platform's required CSV shape. A fourth,
`GestureQuizCsvBuilder` (`services/gesture-quiz-csv-builder.ts`), serves only the AI's Quiz cử chỉ output: it
carries the header (`GESTURE_QUIZ_COLUMNS`) for `buildFromCsvContent`, while its `buildFromRows` throws, because
the table's rows have no stages, so the vocabulary table's platform select does not list the platform.
GimKit/Blooket builders synthesize incorrect-answer distractors by randomly sampling other rows'
answers via `Utils.getRandomItem`/`shuffle`, so a builder run needs at least a few rows or the "pick
a distinct wrong answer" loop can spin/repeat. `Utils.escapeCsvField` handles quoting for the
generated CSV (not the same code path as the import parser). `FileExportService.buildFile` then
picks the output format per platform: GimKit/Blooket/Quiz cử chỉ download as `.csv` directly; Wayground is
converted to `.xlsx` via the `xlsx` package first (`FileExportService.buildXlsx`). Both export methods
return an `ExportedFile` (`fileName`, plus the `xlsx` bytes for Wayground) and take a `download` flag.
`buildFileName` makes `<label>-<platform>.csv` with spaces turned into dashes in the platform's name too
(`platformName` of Quiz cử chỉ is "Quiz cử chỉ", so `HSK3-Bai5-Quiz-cử-chỉ.csv`).
For Wayground the table page shows a `WaygroundDelivery` radio (download vs. extension, preference held
by `WaygroundExtensionService.preferredDelivery`); the AI jobs table has no such setting and offers both
buttons on each finished Wayground job, the extension one disabled without `../Extension`. When the
extension is used, the file is not downloaded and `WaygroundExtensionService.sendImport` hands the bytes to it. The
extension imports and publishes the quiz in the user's Wayground tab, and the service later shows the
share link it sends back (see [../AGENTS.md](../AGENTS.md#the-wayground-browser-extension)).

### Gesture quiz (`/play`)

The AI's Quiz cử chỉ output (`ExportType.GestureQuiz`, ordinal 3) is played in the app, not imported
anywhere; the CSV contract, the six-stage ladder and the pass rule are in
[../AGENTS.md](../AGENTS.md#the-gesture-quiz-quiz-cử-chỉ). This section is the client's half.

**Routes.** `app.routes.ts` declares `play` and `play/:jobId` as `loadComponent` routes for `GesturePlay`
(the second with `authGuard`), placed *outside* the `Workspace` route so the game fills the screen with no
menu. They are the app's first lazy routes: the page, the six games and MediaPipe stay out of the initial
bundle, and a player who never opens `/play` never downloads them. `OnlineStatusService` leaves `/play` and
`/play/:jobId` alone when the connection drops (`GESTURE_PLAY_URL`) instead of sending the player to
`/offline`, since a loaded game runs entirely in the browser.

**The page** (`components/gesture-play/`, `GesturePlay`) is a state machine over a `screen` signal:
`loading`/`error` (only for `/play/:jobId`: the job is taken from `AiJobService.jobs()` or, when the list
is empty, fetched once with `refresh()`; a job that is missing, still running, failed or not a GestureQuiz
shows its own message), `load` (`/play`: "Mở file quiz" reads a `.csv` with `FileReader`, "Chơi thử quiz
mẫu" uses `game/demo-quiz.ts`; both go through `CsvImportService.parseCsvRows` and `parseGestureQuiz`, with
a warning when rows were `skipped`), `map` (`GestureStageMap`, `stage-map/`: the six stages with questions,
best result, passed/locked/empty status, the time-mode and sound settings and a progress reset), `intro`
(the stage's hint, camera switch and preview, status chips), `playing` and `result` (`GestureStageResult`,
`stage-result/`: the verdict against the pass mark, the missed questions with their explanations, next
stage / retry / map). `gesture-engine.ts` holds the pure part, with its spec: `prepareQuestion` turns a
`GestureQuestion` into what is played (stage 1 is always `['Đúng', 'Sai']`, stages 2–5 shuffle the correct
answer in with the wrong ones, stage 6 shuffles the chunks to an order that is not the answer),
`judge`/`timeoutReveal`, `correctAnswerText`, `timeLimitFor` (the stage's seconds, ×1.5 or none, per
`TimeMode`) and `titleFromFileName`. The page keeps the run (questions, score, streak, missed list) and
records it with `GestureProgressService.record` when the run finishes (after the last question's feedback).

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
  icon, hint, vision kind, option count, seconds per question), `PASS_RATIO` and `passMark`.

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

**Specs** (Karma/Jasmine, no camera needed): `models/gesture-quiz.spec.ts` (the parser), `services/gesture-progress.service.spec.ts`,
`game/gestures.spec.ts`, `game/hold-select.spec.ts`, `game/vision.service.spec.ts` (with a fake camera; the
MediaPipe-result converters are tested from plain objects), `gesture-engine.spec.ts`, `gesture-play.spec.ts`
(the page against a `FakeVision`), and a `*-game.spec.ts` plus `*-logic.spec.ts` for every game; the Quiz
cử chỉ export is covered in `file-export.service.spec.ts`. None of them runs MediaPipe, so real recognition
(lighting, distance, thresholds) can only be tried by hand on a machine with a webcam.

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

`provideNzI18n(en_US)` is set in `app.config.ts` despite most user-facing
notification strings in the codebase being written in Vietnamese directly at the call site (not via
i18n).
