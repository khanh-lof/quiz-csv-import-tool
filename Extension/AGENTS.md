# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An optional Chrome extension (Manifest V3, plain JavaScript, no build step and no dependencies) that
imports the Wayground `.xlsx` QuizTool generates straight into the user's own logged-in Wayground
tab. Wayground has no public API for creating quizzes, so the extension clicks through Wayground's
own UI the way the user would. It never publishes: it stops once the questions are imported, and the
user reviews them and clicks Publish.

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
  hand-kept in step with `Client/src/services/wayground-extension.service.ts`.
- `background.js` opens `https://wayground.com/activity/admin/assessment` in a new tab and stores the
  job in `chrome.storage.session` under that tab's id (dropped after 10 minutes).
- `wayground.js` (content script on wayground.com) asks the background for its tab's job. With no job
  it does nothing, so ordinary Wayground browsing is untouched. With one, it goes: Start from scratch
  → quiz settings (sets the name) → Import existing files → Spreadsheet → sets the file on the modal's
  file input → Import. It shows a banner with progress, and a banner saying which step it got stuck
  on if a step doesn't appear within its timeout. A logged-out user lands on Wayground's login page,
  where it waits. Wayground brings the user back to the start page after login, and the script
  resumes there.
- `selectors.js` is the **only** place Wayground's DOM is referenced. It uses `data-testid`/aria
  attributes and visible text, since Wayground's class names are generated. When Wayground changes
  its UI, re-record the ids there. The start page's own "Import via template" is a paid feature, so
  the free Start from scratch → Spreadsheet path is used instead.
