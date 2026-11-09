// Runs on www.gimkit.com. When the background worker holds an import job for this tab, it drives Gimkit's own
// UI: New Kit (name, language, subject, cover photo) → Import from Spreadsheet → All Done → reports the kit's
// share link back to QuizTool, and the background closes the tab. When a step gets stuck, the tab stays open
// with a banner so the teacher can finish by hand.

// What the runner is doing, named in the banner if it gets stuck.
let step = '';

// Gimkit may move between pages in-page or with a full page load, which restarts this script. The kit's id and
// whether its questions are in survive that in the tab's session storage, so a restart neither makes a second
// kit nor imports the questions twice.
const STATE_KEY = 'quiztool-gimkit';
const readState = () => {
  try {
    return JSON.parse(sessionStorage.getItem(STATE_KEY) ?? '{}');
  } catch {
    return {};
  }
};
const writeState = patch => sessionStorage.setItem(STATE_KEY, JSON.stringify({...readState(), ...patch}));

(async () => {
  const job = await chrome.runtime.sendMessage({type: 'get-job'});
  if (job?.platform !== 'gimkit') return;
  // A job from an earlier attempt must not leave its kit id behind for this one.
  if (readState().requestId !== job.requestId) sessionStorage.removeItem(STATE_KEY);
  writeState({requestId: job.requestId});

  // Gimkit sends a logged-out user to its login page and back afterwards; wait there.
  if (GIMKIT.loginPath.test(location.pathname)) {
    banner('Đăng nhập Gimkit, QuizTool sẽ tự tạo kit tiếp sau đó.');
    return;
  }

  try {
    if (GIMKIT.createPath.test(location.pathname)) {
      banner('QuizTool đang tạo kit…');
      await createKit(job.title);
      // The editor opens in-page or as a new page load; in the latter case this script stops here and
      // runs again on the editor.
      step = 'mở trang soạn kit';
      await waitFor(() => GIMKIT.editorPath.test(location.pathname));
    }

    const editor = location.pathname.match(GIMKIT.editorPath);
    if (editor) {
      writeState({kitId: editor[1]});
      if (!readState().imported) {
        banner('QuizTool đang import câu hỏi…');
        await importSpreadsheet(job);
        writeState({imported: true});
      }
      step = 'bấm All Done';
      banner('QuizTool đang lưu kit…');
      await savedByGimkit();
      (await waitFor(() => findButton(GIMKIT.buttonAllDoneText))).click();
      step = 'chờ lưu kit xong';
      await waitFor(() => GIMKIT.kitsPath.test(location.pathname), 30_000);
    }

    const kitId = readState().kitId;
    if (!kitId || !GIMKIT.kitsPath.test(location.pathname)) return;
    const shareUrl = GIMKIT.shareUrl(kitId);
    // Shown in case the tab stays open (the QuizTool tab was closed in the meantime).
    banner(`QuizTool đã tạo kit. Link chia sẻ: ${shareUrl}`, 'done');
    chrome.runtime.sendMessage({type: 'finish-job', ok: true, shareUrl});
  } catch (error) {
    const reason = error instanceof StepTimeout ? `không ${step} được` : String(error);
    banner(`QuizTool dừng lại (${reason}). Làm tiếp bằng tay trong tab này nhé; ` +
      `file ${job.fileName} cũng đã được tải về.`, 'error');
    chrome.runtime.sendMessage({type: 'finish-job', ok: false, error: reason});
  }
})();

// The progress banner, in a purple close to Gimkit's own.
function banner(text, kind = 'info') {
  showBanner(text, kind, {info: '#6a3fb5', done: '#1f8a4c', error: '#b3261e'});
}

// New Kit: name, language, subject, then a cover photo, whose choice creates the kit.
async function createKit(title) {
  step = 'đặt tên kit';
  const input = await waitFor(() => document.querySelector(GIMKIT.nameInput));
  setInputValue(input, title.slice(0, GIMKIT_SETTINGS.maxNameLength));

  const [language, subject] = await waitFor(() => {
    const selects = document.querySelectorAll(GIMKIT.select);
    return selects.length >= 2 ? [...selects] : null;
  });
  step = `chọn Language "${GIMKIT_SETTINGS.language}"`;
  await choose(language, GIMKIT_SETTINGS.language);
  step = `chọn Subject "${GIMKIT_SETTINGS.subject}"`;
  await choose(subject, GIMKIT_SETTINGS.subject);

  step = 'bấm Next';
  const next = await waitFor(() => {
    const button = findButton(GIMKIT.buttonNextText, GIMKIT.modal);
    return button && !button.disabled ? button : null;
  });
  next.click();

  step = 'chọn ảnh bìa';
  const credit = await waitFor(() => [...document.querySelectorAll(GIMKIT.coverPhotoCredit)]
    .find(el => el.textContent.trim().startsWith(GIMKIT.coverPhotoCreditText)));
  credit.previousElementSibling.click();
}

// Import from Spreadsheet: the dialog takes the CSV as soon as the file is chosen, then returns to the editor.
async function importSpreadsheet(job) {
  step = 'mở "Import from Spreadsheet"';
  const menuItem = await waitFor(() => [...document.querySelectorAll('*')]
    .find(el => el.childElementCount === 0 && el.textContent.trim() === GIMKIT.importMenuText));
  menuItem.click();
  await waitFor(() => GIMKIT.spreadsheetPath.test(location.pathname));

  step = 'chọn file';
  setInputFile(await waitFor(() => document.querySelector(GIMKIT.fileInput)), fileFromJob(job));

  step = 'import file';
  await waitFor(() => !GIMKIT.spreadsheetPath.test(location.pathname), 60_000);
}

// Gimkit saves the kit as it changes and says so at the bottom of the editor's menu. Waits for that, but a
// kit whose message never shows (Gimkit rewording it) is still finished.
async function savedByGimkit() {
  try {
    await waitFor(() => document.body.innerText.includes(GIMKIT.saved), 10_000);
  } catch (error) {
    if (!(error instanceof StepTimeout)) throw error;
  }
}

// Opens one of the New Kit dialog's Ant Design selects and picks the option with exactly this text. Ant Design
// opens a select on mouse down, not on click, and its list is virtual, so the text is typed to bring the option
// into the list.
async function choose(select, optionText) {
  const shown = () => select.querySelector(GIMKIT.selectValue)?.textContent.trim();
  if (shown() === optionText) return;
  select.querySelector(GIMKIT.selectSelector).dispatchEvent(new MouseEvent('mousedown', {bubbles: true}));
  setInputValue(select.querySelector('input'), optionText);
  const option = await waitFor(() => [...document.querySelectorAll(GIMKIT.selectOption)]
    .find(el => el.textContent.trim() === optionText), 5_000);
  option.click();
  await waitFor(() => shown() === optionText, 5_000);
}

function findButton(text, scope = 'body') {
  return [...document.querySelector(scope)?.querySelectorAll('button') ?? []]
    .find(button => button.textContent.trim() === text);
}
