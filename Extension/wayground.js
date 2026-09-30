// Runs on wayground.com. When the background worker holds an import job for this tab, it drives
// Wayground's own UI: Start from scratch → Spreadsheet import → Publish (name, Subject, Grade,
// Language) → reports the quiz's share link back to QuizTool, and the background closes the tab.
// When a step gets stuck, the tab stays open with a banner so the teacher can finish by hand.
class StepTimeout extends Error {}

// What the runner is doing, named in the banner if it gets stuck.
let step = '';

(async () => {
  const job = await chrome.runtime.sendMessage({type: 'get-job'});
  if (!job) return;

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
  const transfer = new DataTransfer();
  transfer.items.add(fileFromJob(job));
  fileInput.files = transfer.files;
  fileInput.dispatchEvent(new Event('change', {bubbles: true}));

  step = 'bấm Import';
  const importButton = await waitFor(() => {
    const button = document.querySelector(WAYGROUND.importButton);
    return button && !button.disabled ? button : null;
  });
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

// Resolves with the first truthy value of `find`, checking on every DOM change.
function waitFor(find, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const check = () => {
      const found = find();
      if (!found) return false;
      observer.disconnect();
      clearTimeout(timer);
      resolve(found);
      return true;
    };
    const observer = new MutationObserver(check);
    const timer = setTimeout(() => {
      observer.disconnect();
      reject(new StepTimeout());
    }, timeoutMs);
    if (!check()) observer.observe(document.documentElement, {childList: true, subtree: true, attributes: true});
  });
}

// Wayground's cards react to a click on their text, not always on the outer element.
function clickDeepest(root, text) {
  const target = [...root.querySelectorAll('*')]
    .find(el => el.childElementCount === 0 && el.textContent.trim() === text) ?? root;
  target.click();
}

// Wayground's inputs are Vue v-model bindings, which update on the `input` event.
function setInputValue(input, value) {
  input.focus();
  input.value = value;
  input.dispatchEvent(new Event('input', {bubbles: true}));
  input.dispatchEvent(new Event('change', {bubbles: true}));
}

function fileFromJob(job) {
  const binary = atob(job.base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new File([bytes], job.fileName,
    {type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
}

function showBanner(text, kind = 'info') {
  let banner = document.getElementById('quiztool-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'quiztool-banner';
    banner.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483647;' +
      'max-width:560px;padding:12px 40px 12px 16px;border-radius:8px;font:14px/1.4 system-ui,sans-serif;' +
      'color:#fff;box-shadow:0 4px 16px rgba(0,0,0,.25)';
    const close = document.createElement('button');
    close.textContent = '×';
    close.setAttribute('aria-label', 'Đóng');
    close.style.cssText = 'position:absolute;top:6px;right:10px;border:0;background:none;color:inherit;font-size:18px;cursor:pointer';
    close.onclick = () => banner.remove();
    banner.append(document.createElement('span'), close);
    document.body.append(banner);
  }
  banner.style.background = {info: '#6b3fa0', done: '#1f8a4c', error: '#b3261e'}[kind];
  banner.firstChild.textContent = text;
}
