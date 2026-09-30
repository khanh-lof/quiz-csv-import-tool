// Runs on QuizTool's own pages. Tells the SPA the extension is installed, passes its import requests
// on to the background worker, and hands the results back to the page. The message shapes are
// hand-kept in step with Client/src/services/wayground-extension.service.ts.
document.documentElement.dataset.quiztoolExtension = chrome.runtime.getManifest().version;

window.addEventListener('message', event => {
  // Only the page itself, never a frame or another window, may start an import.
  if (event.source !== window || event.origin !== window.location.origin) return;
  const data = event.data;
  if (!data || data.source !== 'quiztool' || data.type !== 'wayground-import') return;
  if (typeof data.base64 !== 'string' || typeof data.fileName !== 'string') return;

  chrome.runtime.sendMessage({
    type: 'start-import',
    requestId: String(data.requestId ?? ''),
    title: String(data.title ?? ''),
    fileName: data.fileName,
    base64: data.base64,
  });
});

chrome.runtime.onMessage.addListener(message => {
  if (message?.type !== 'import-result') return;
  window.postMessage({
    source: 'quiztool-extension',
    type: 'wayground-import-result',
    requestId: message.requestId,
    title: message.title,
    ok: message.ok,
    shareUrl: message.shareUrl,
    error: message.error,
  }, window.location.origin);
});
