// Helpers shared by the content scripts that drive a platform's own pages (wayground.js, gimkit.js).
// Content scripts listed in one manifest entry share a scope, so these are plain globals.
class StepTimeout extends Error {}

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

// The platforms' inputs are framework-controlled (Vue v-model, React): they update on the `input` event, and
// React ignores a plain `input.value = ...` because it tracks the value itself. The native setter goes around
// that tracking.
function setInputValue(input, value) {
  input.focus();
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value').set.call(input, value);
  input.dispatchEvent(new Event('input', {bubbles: true}));
  input.dispatchEvent(new Event('change', {bubbles: true}));
}

// Puts a file in a platform's file input and fires the events a real file picker fires.
function setInputFile(input, file) {
  const transfer = new DataTransfer();
  transfer.items.add(file);
  input.files = transfer.files;
  input.dispatchEvent(new Event('input', {bubbles: true}));
  input.dispatchEvent(new Event('change', {bubbles: true}));
}

// The job's file, which the QuizTool page sent as base64: an .xlsx for Wayground, a .csv for Gimkit.
function fileFromJob(job) {
  const binary = atob(job.base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const type = /\.csv$/i.test(job.fileName)
    ? 'text/csv'
    : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  return new File([bytes], job.fileName, {type});
}

// A progress banner at the bottom of the platform's page; `colors` is {info, done, error}.
function showBanner(text, kind = 'info', colors = {info: '#6b3fa0', done: '#1f8a4c', error: '#b3261e'}) {
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
  banner.style.background = colors[kind];
  banner.firstChild.textContent = text;
}
