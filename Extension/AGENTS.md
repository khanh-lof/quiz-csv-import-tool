# AGENTS.md

This file provides guidance to AI when working with code in this repository.

## What this is

An optional Chrome extension (Manifest V3, plain JavaScript, no build step and no dependencies) that
takes the file QuizTool generates (an `.xlsx` for Wayground, a `.csv` for Gimkit) and, in the user's own
logged-in Wayground or Gimkit tab, imports it, publishes the quiz and sends the quiz's share link back to
QuizTool. One extension serves both platforms, so a teacher installs a single download. Neither platform has a
public API for creating quizzes, so the extension clicks through their own UI the way the user would.

## Running it

Open `chrome://extensions`, turn on Developer mode, click **Load unpacked** and pick this folder.
After editing a file, press the extension's reload button and reload the QuizTool and Wayground tabs.
There are no tests. Check changes by exporting to Wayground from `npm start` in `../Client`.
[README.md](README.md) is the step-by-step install and usage guide for teachers (in Vietnamese, like
the app's UI). Keep it in step when the flow, the supported origins or the banner texts change.

## How it fits together

- `bridge.js` (content script on QuizTool's pages; the origins are the first `matches` entry in
  `manifest.json`) sets `data-quiztool-extension` on `<html>` so the SPA can tell the extension is
  installed. It forwards `window.postMessage({source: 'quiztool', type: 'wayground-import', title,
  fileName, base64})` to the background worker, accepting it only from the page itself. The shape is
  hand-kept in step with `Client/src/services/publish-extension.service.ts`. The request type is
  `wayground-import` or `gimkit-import`; the platform picks the content script that runs.
- `background.js` opens the platform's start page (`START_URLS`: Wayground's `/activity/admin/assessment`,
  Gimkit's `https://www.gimkit.com/create`) in a new tab and stores the
  job (with its `platform`) in `chrome.storage.session` under that tab's id (dropped after 10 minutes),
  together with the QuizTool tab it came from. When the job finishes, it sends `{type: 'import-result',
  platform, requestId, title, ok, shareUrl, error}` to that QuizTool tab, where `bridge.js` re-posts it to the
  page as `{source: 'quiztool-extension', type: '<platform>-import-result', ...}`. On success it also closes
  the platform tab and brings the QuizTool tab forward. On failure the platform tab stays open so the
  teacher can finish there.
- `common.js` holds what both content scripts share: `waitFor`, `setInputValue` (the native value setter, since
  Vue and React both ignore a plain `input.value = ...`), `setInputFile`, `fileFromJob` and `showBanner`.
- `wayground.js` (content script on wayground.com) asks the background for its tab's job. With no job
  (or one for another platform) it does nothing, so ordinary Wayground browsing is untouched. With one, it goes: Start from scratch
  → Import existing files → Spreadsheet → sets the file on the modal's file input → Import → Publish,
  which opens the quiz settings modal. There it sets the name and picks the Subject, Grade and Language
  from `PUBLISH_SETTINGS`; Wayground won't publish without a Subject and Grade. It then clicks the
  modal's Publish and waits for the quiz page, `/activity/admin/quiz/<id>`. The share link is built
  from that id; it is what Share → "Share with teachers" → Copy Link gives. Wayground may move
  between these pages in-page or with a full page load, so each stage also resumes when the script
  starts on that page. A banner shows progress, or the step it got stuck on when a step doesn't
  appear within its timeout. A logged-out user lands on Wayground's login page, where it waits.
  Wayground brings the user back to the start page after login, and the script resumes there.
- `selectors.js` is the **only** place Wayground's DOM is referenced. It uses `data-testid`/aria
  attributes and visible text, since Wayground's class names are generated. When Wayground changes
  its UI, re-record the ids there. The start page's own "Import via template" is a paid feature, so
  the free Start from scratch → Spreadsheet path is used instead. `PUBLISH_SETTINGS` there holds the
  fixed Subject/Grade/Language (`World Languages` / `University` / `Tiếng Việt`), written exactly as
  Wayground's dropdowns show them. Visibility is left at "Publicly visible", the only free choice.
- `gimkit.js` (content script on www.gimkit.com) does the same for Gimkit, for a job whose `platform` is
  `gimkit`: on `/create` it fills New Kit (the name cut to Gimkit's 30 characters, Language and Subject from
  `GIMKIT_SETTINGS`), clicks Next and clicks a cover photo, which creates the kit and opens `/create/<id>/editor`.
  There it opens Import from Spreadsheet and sets the CSV on the dialog's file input, which imports on the spot and
  returns to the editor; then it waits for "All changes saved", clicks All Done (to `/me`) and builds the share
  link, `https://www.gimkit.com/view/<id>` (the kit's public page, what its Share tab shows), from the id. Gimkit
  kits are public by default. Gimkit is a React app, so a restart on a full page load must not repeat a step: the
  kit id and whether the CSV is in are kept in the tab's `sessionStorage` (`quiztool-gimkit`), and a restart on
  the editor skips a finished import. Two Ant Design quirks: a select opens on `mousedown`, not click, and the
  picture of a cover photo is the element *before* its "Image by …" credit link, which opens Pexels.
- `gimkit-selectors.js` is the **only** place Gimkit's DOM is referenced. Gimkit has no `data-testid` and its class
  names are generated, so it uses Ant Design's stable `ant-*` classes, roles and visible text. Re-record them there
  when Gimkit changes its UI. Recorded against a logged-in free-trial account; Gimkit's login page is where a
  logged-out user waits, and it brings them back to `/create`.
