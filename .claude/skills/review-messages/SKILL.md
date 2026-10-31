---
name: review-messages
description: Review every user-facing message in the Client (notifications, hints, helper text, empty states, modal text) against the Client/AGENTS.md message rule, and report or fix what is too long, unneeded, missing or badly worded. Use when the user asks to review, audit, shorten or clean up UI messages, toasts or Vietnamese wording.
---

# Review user messages

The rule, in `Client/AGENTS.md` ("UI library"): messages shown to the user are short and don't explain much,
and exist only when the user could not tell how to use the feature without them. A self-evident control or
result needs no message. All UI text is Vietnamese, written at the call site (no i18n).

Default scope is the whole `Client/src`; if the user names files or a diff (`git diff`), review only those.
Report first; edit only when the user asked for fixes.

## 1. Find every message

Grep `Client/src` (skip `*.spec.ts`) for:
- `notificationService.(success|info|warning|error|blank|create)` and `nzMessage`/`message.` calls;
- `nzTitle`, `nzContent`, `nzOkText`, `nzPlaceHolder`, `nzPopconfirmTitle`, `nzTooltipTitle`, `*nzModalTitle`;
- template text in `.html`: `<p>`, `<small>`, `<li>`, `class="*hint*|*help*|*empty*|*muted*"`, and `message:` in
  `errorMessage` template contexts;
- string constants that become UI text (`helpText`, `*_LABELS`, `*_ERRORS`, `fail(...)` messages, getters
  returning hint strings).

## 2. Judge each one

For each message decide **keep / shorten / remove / add**:
- **Remove** when the result is visible anyway (a file downloaded, rows appeared, a dialog closed, a page
  navigated), when it repeats the title, or when it only restates the button the user just pressed.
- **Keep (short)** when it tells something the user cannot see or guess: where a result went ("Kết quả ở AI ›
  Lịch sử"), what to do next in a non-obvious step (open a Game file on the Game page, take the link from Mã QR
  when the clipboard failed, the file was downloaded because the extension failed), why an action was refused,
  or a rule with a number (limits, pass percent).
- **Shorten** everything else: drop "Vui lòng", "bạn", "nhé/nhaa/nàa", explanations of why, and sentences that
  describe internals ("AI chạy trên máy chủ"). One short clause per body; the title carries the main point.
- **Add** when a non-obvious step or failure has no message at all.

Check the wording too:
- correct, natural Vietnamese (no doubled words like "trước trước", no literal English calques);
- same term for the same thing across the app (e.g. "nền tảng" vs "template", "link" vs "đường dẫn",
  "màn", "Giao bài", "Lịch sử");
- consistent capitalisation and ending punctuation (bodies end with "."; titles don't);
- tone matches the title and the neighbouring messages.

## 3. Check the code around each change

- A notification body may be `''` when the title says it all: ng-zorro has no title-only call and renders an
  empty description block, which is acceptable.
- Removing a message must not leave dead code: unused imports, variables, getters, CSS classes, or an
  element that renders empty (wrap it in `@if`).
- Notification bodies are HTML (`innerHTML`): anything from a user, a job title or the server must stay escaped
  (`escapeHtml`).
- Specs that assert the old text (`toHaveBeenCalledWith(...)`, `toContain(...)`) must change with it.
- `Client/AGENTS.md` and the root `AGENTS.md` quote some messages ("Đã gửi yêu cầu", "Hết lượt dùng AI",
  "Không có quyền", "Tạo lại", button labels); update them if one changes. Server error strings matched by the
  client (`TEACHER_ERRORS`, join messages) are contracts, not UI text: never reword those.

## 4. Verify and report

If you edited: from `Client/`, run `npx ng build` and `npx ng test --watch=false --browsers=ChromeHeadless`.

Report a prioritised list, each item `file:line`, the current text, the verdict and the proposed text:
1. bugs left by edits (dead code, empty elements, stale specs/docs);
2. messages removed or missing that the user needs;
3. messages still too long or unneeded;
4. wording and consistency.
