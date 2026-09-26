# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

The Angular (v22, standalone components) frontend for QuizTool. It lets a user build a table of
question/answer vocabulary pairs (manually, via CSV import, or via AI generation), then export
them as a CSV formatted for either GimKit or Blooket import. Auth (JWT access token + HttpOnly
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
- Every route is open to anonymous users (`authGuard` in `services/auth.guard.ts` is no longer
  wired into `app.routes.ts`). Only AI generation needs a login: `VocabularyTable.openAiGenerationPopup`
  shows a "Cần đăng nhập" confirm to an anonymous user, which sends them to
  `/login?returnUrl=/quiz?openAi=1`. `LoginComponent` navigates to `returnUrl` after login (only
  in-app paths are accepted, otherwise `/quiz`), and `VocabularyTable.ngOnInit` sees `openAi`,
  strips it from the URL and opens the popup. The table survives that trip (and reloads) because
  `VocabularyTable` keeps its rows and template as a draft in `localStorage` (`vocabulary-table-draft`).

### Vocabulary table & CSV pipeline

`VocabularyTable` (`src/components/vocabulary-table/`) is the main screen: a reactive `FormArray`
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
3. `openAiGenerationPopup` → `AiGenerationPopup` modal (drag-drop / paste / file-picker for one or more
   images, `AIGenerationMode.Formatted` or `.Auto` chosen in the popup's form) →
   `AiCsvService.generateCsvFromImages`/`generateCsvFromImagesCreative` posts to the Server's
   `/api/csv/generate-from-image` endpoint. The two modes diverge from here (see
   [../CLAUDE.md](../CLAUDE.md#the-two-ai-generation-modes) for the full picture):
   - **`Formatted`** → response text is cleaned by `AiCsvService.extractCsvContent` (strips markdown
     code fences, or extracts from the first Vietnamese CSV header it finds) → re-parsed by the same
     `CsvImportService.parseCsv` → rows pushed into the table like any other import.
   - **`Auto`** (requires `courseType`/`lessonNumber`/`exportType` in the popup form, plus `level`
     for HSK/YCT or `courseName` for `Other`; images are optional here) → response is CSV
     rows with no header → passed straight to `FileExportService.exportFileFromCsvContent`, which
     calls the matching `CsvBuilder.buildFromCsvContent` to prepend the platform's `CsvHeader` and
     downloads immediately. The vocabulary table is never touched in this path.

Export: `exportFile()` validates the form, then `FileExportService` dispatches to `GimkitCsvBuilder`,
`BlooketCsvBuilder`, or `WaygroundCsvBuilder` (all extend `CsvBuilderBase`, selected by the
`exportType` form control, `ExportType` enum) based on the target platform's required CSV shape.
GimKit/Blooket builders synthesize incorrect-answer distractors by randomly sampling other rows'
answers via `Utils.getRandomItem`/`shuffle`, so a builder run needs at least a few rows or the "pick
a distinct wrong answer" loop can spin/repeat. `Utils.escapeCsvField` handles quoting for the
generated CSV (not the same code path as the import parser). `FileExportService.download` then
picks the output format per platform: GimKit/Blooket download as `.csv` directly; Wayground is
converted to `.xlsx` via the `xlsx` package first.

### UI library

ng-zorro-antd (Ant Design for Angular) components are imported individually per-component (e.g.
`NzButtonComponent`, `NzTableModule`) rather than as one shared module, consistent with standalone
component conventions. Styling is centralized so every library component looks the same on every screen, including
overlays (modals, confirms, dropdowns, notifications) that render outside any component:
- `src/theme.less` sets ng-zorro's Less variables (primary pink, border color, radius, …).
- `src/styles.css` holds the design tokens (`--qt-*` custom properties on `:root`), the page
  background, the `.qt-centered-page` layout helper, `.text-error`, and global overrides of `.ant-*`
  classes for what Less variables can't express (gradient buttons/headers, 2px borders, focus glow).
- Component stylesheets hold only layout and sizing. Don't restyle library colors there or reach
  for `::ng-deep` without `:host` (that leaks globally); add or change a global override instead,
  and use `nzType`/`nzSize` (e.g. `nzType="primary"` for the main action) rather than CSS.

`provideNzI18n(en_US)` is set in `app.config.ts` despite most user-facing
notification strings in the codebase being written in Vietnamese directly at the call site (not via
i18n).
