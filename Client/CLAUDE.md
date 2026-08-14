# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

The Angular (v20, standalone components) frontend for QuizTool. It lets a user build a table of
question/answer vocabulary pairs (manually, via CSV import, or via AI image import), then export
them as a CSV formatted for either GimKit or Blooket import. Auth (JWT access token + HttpOnly
refresh cookie) and the AI image-to-CSV endpoint are served by the sibling `../Server` Azure
Functions API (see `../Server/CLAUDE.md`).

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
```

There is no e2e test setup and no lint script configured in `package.json`.

## Architecture

### Environments & backend URL

`src/environments/environment.ts` (dev, `apiUrl: http://localhost:7071`) and
`environment.prod.ts` are swapped via the `fileReplacements` production build config in
`angular.json` — there is no `environment.development.ts`, dev is the default file. All HTTP
services read `environment.apiUrl` directly rather than a relative path, since the Angular app and
Functions API are served from different origins.

### Auth flow (access token in memory, refresh token in cookie)

- `AuthService` holds the access token only in memory (a plain field, not persisted) — a page
  reload always starts logged-out until the refresh flow below runs.
- `AuthApiService` calls `POST /api/auth/login` and `POST /api/auth/refresh` with
  `withCredentials: true` so the server's HttpOnly refresh cookie is sent/received; on success it
  pushes the returned `accessToken` into `AuthService`.
- `app.config.ts` calls `AuthApiService.refreshToken()` via `provideAppInitializer`, swallowing
  errors — so on every app boot, an existing refresh cookie silently re-establishes a session
  before any component renders.
- `AuthInterceptor` (registered via the legacy `HTTP_INTERCEPTORS` DI token, not
  `HttpInterceptorFn`) attaches `Authorization: Bearer <token>` to every request, and on a 401
  (except from `/api/auth/refresh` itself, to avoid a loop) transparently calls `refreshToken()`,
  queues any other in-flight requests behind a `BehaviorSubject` until the refresh resolves, then
  retries with the new token. A failed refresh clears the token but does not redirect — routing to
  `/login` happens separately via `authGuard`.
- `authGuard` (a `CanActivateFn`, exported alongside an equivalent `AuthGuard` class that isn't
  wired up in `app.routes.ts`) protects the `quiz` route and redirects to `/login` when
  `AuthService.isLoggedIn()` is false.

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
2. `openImagePopup` → `ImageImportPopupComponent` modal (drag-drop / paste / file-picker for one or
   more images) → `AiCsvService.generateCsvFromImages` posts to the Server's
   `/api/GenerateCsvFromImage` endpoint → response text is cleaned by
   `AiCsvService.extractCsvContent` (strips markdown code fences, or extracts from the first
   Vietnamese CSV header it finds) → re-parsed by the same `CsvImportService.parseCsv`.

Export: `exportCsv()` validates the form, then `CsvExportService` dispatches to `GimkitCsvBuilder`
or `BlooketCsvBuilder` (selected by the `exportType` form control, `ExportType` enum) based on the
target platform's required CSV shape. Both builders synthesize incorrect-answer distractors by
randomly sampling other rows' answers via `Utils.getRandomItem`/`shuffle`, so a builder run needs at
least a few rows or the "pick a distinct wrong answer" loop can spin/repeat. `Utils.escapeCsvField`
handles quoting for the generated CSV (not the same code path as the import parser).

### UI library

ng-zorro-antd (Ant Design for Angular) components are imported individually per-component (e.g.
`NzButtonComponent`, `NzTableModule`) rather than as one shared module, consistent with standalone
component conventions. `provideNzI18n(en_US)` is set in `app.config.ts` despite most user-facing
notification strings in the codebase being written in Vietnamese directly at the call site (not via
i18n).
