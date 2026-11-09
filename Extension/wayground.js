// Runs on wayground.com. When the background worker holds an import job for this tab, it drives
// Wayground's own UI: Start from scratch → Spreadsheet import → Publish (name, Subject, Grade,
// Language) → reports the quiz's share link back to QuizTool, and the background closes the tab.
// When a step gets stuck, the tab stays open with a banner so the teacher can finish by hand.
// The helpers (waitFor, showBanner, ...) are in common.js.

// What the runner is doing, named in the banner if it gets stuck.
let step = '';

(async () => {
  const job = await chrome.runtime.sendMessage({type: 'get-job'});
  if (job?.platform !== 'wayground') return;

  // Wayground sends a logged-out user to its login page and back afterwards; wait there.
  if (WAYGROUND.loginPath.test(location.pathname)) {
    showBanner('Đăng nhập Wayground, QuizTool sẽ tự tạo quiz tiếp sau đó.');
    return;
  }

  try {
    if (WAYGROUND.startPath.test(location.pathname)) {
      step = 'mở "Start from scratch"';
      const card = await waitFor(() => [...document.querySelectorAll(WAYGROUND.creationOption)]
        .find(el => el.textContent.includes(WAYGROUND.startFromScratchText)));
      showBanner('QuizTool đang tạo quiz…');
      clickDeepest(card, WAYGROUND.startFromScratchText);
      // Wayground may open the editor in-page or as a new page load; in the latter case this script
      // stops here and runs again on the editor.
      await waitFor(() => WAYGROUND.editorPath.test(location.pathname));
    }

    if (WAYGROUND.editorPath.test(location.pathname)) {
      showBanner('QuizTool đang import câu hỏi…');
      await importSpreadsheet(job);
      showBanner('QuizTool đang publish quiz…');
      await publish(job.title);
      // Publish lands on the quiz's page, again either in-page or as a new page load.
      step = 'chờ publish xong';
      await waitFor(() => WAYGROUND.publishedPath.test(location.pathname), 60_000);
    }

    const published = location.pathname.match(WAYGROUND.publishedPath);
    if (!published) return;
    const shareUrl = WAYGROUND.shareUrl(published[1]);
    // Shown in case the tab stays open (the QuizTool tab was closed in the meantime).
    showBanner(`QuizTool đã publish quiz. Link chia sẻ: ${shareUrl}`, 'done');
    chrome.runtime.sendMessage({type: 'finish-job', ok: true, shareUrl});
  } catch (error) {
    const reason = error instanceof StepTimeout ? `không ${step} được` : String(error);
    showBanner(`QuizTool dừng lại (${reason}). Làm tiếp bằng tay trong tab này nhé; ` +
      `file ${job.fileName} cũng đã được tải về.`, 'error');
    chrome.runtime.sendMessage({type: 'finish-job', ok: false, error: reason});
  }
})();

async function importSpreadsheet(job) {
  step = 'mở "Import existing files → Spreadsheet"';
  (await waitFor(() => document.querySelector(WAYGROUND.sheetsButton))).click();

  step = 'chọn file';
  const fileInput = await waitFor(() => document.querySelector(WAYGROUND.importFileInput));
  // Wayground reads the file on `input`; the helper fires the events in the order a real file picker does.
  setInputFile(fileInput, fileFromJob(job));

  // Wayground parses the spreadsheet before it enables Import: about 5 s for its 6-row sample, longer
  // for a full lesson.
  step = 'bấm Import';
  const importButton = await waitFor(() => {
    const button = document.querySelector(WAYGROUND.importButton);
    return button && !button.disabled ? button : null;
  }, 60_000);
  importButton.click();
  await waitFor(() => !document.querySelector(WAYGROUND.importModal), 60_000);
}

// Publish opens the quiz settings modal; Wayground refuses to publish until Subject and Grade are set.
async function publish(title) {
  step = 'mở Publish';
  (await waitFor(() => document.querySelector(WAYGROUND.publishButton))).click();
  await waitFor(() => document.querySelector(WAYGROUND.settingsModal));

  if (title) {
    step = 'đặt tên quiz';
    const input = await waitFor(() => document.querySelector(WAYGROUND.nameInput));
    setInputValue(input, title.slice(0, Number(input.maxLength) > 0 ? input.maxLength : 64));
  }
  step = `chọn Subject "${PUBLISH_SETTINGS.subject}"`;
  await choose(WAYGROUND.subjectSelect, PUBLISH_SETTINGS.subject);
  step = `chọn Grade "${PUBLISH_SETTINGS.grade}"`;
  await choose(WAYGROUND.gradeSelect, PUBLISH_SETTINGS.grade);
  step = `chọn Language "${PUBLISH_SETTINGS.language}"`;
  await choose(WAYGROUND.languageSelect, PUBLISH_SETTINGS.language);

  step = 'bấm Publish';
  (await waitFor(() => document.querySelector(`${WAYGROUND.settingsModal} ${WAYGROUND.settingsPrimary}`))).click();
}

// Opens one of the settings modal's dropdowns and picks the option with exactly this text.
async function choose(selectSelector, optionText) {
  const select = await waitFor(() => document.querySelector(`${WAYGROUND.settingsModal} ${selectSelector}`));
  if (select.innerText.trim() === optionText) return;
  select.click();
  const option = await waitFor(() => [...document.querySelectorAll(WAYGROUND.selectOption)]
    .find(el => el.innerText.trim() === optionText), 5_000);
  option.click();
  await waitFor(() => select.innerText.trim() === optionText, 5_000);
}

// Wayground's cards react to a click on their text, not always on the outer element.
function clickDeepest(root, text) {
  const target = [...root.querySelectorAll('*')]
    .find(el => el.childElementCount === 0 && el.textContent.trim() === text) ?? root;
  target.click();
}
