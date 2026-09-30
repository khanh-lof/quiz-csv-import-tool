// Runs on QuizTool's own pages. Tells the SPA the extension is installed and passes its import
// requests on to the background worker. The message shape is hand-kept in step with
// Client/src/services/wayground-extension.service.ts.
document.documentElement.dataset.quiztoolExtension = chrome.runtime.getManifest().version;

window.addEventListener('message', event => {
  // Only the page itself, never a frame or another window, may start an import.
  if (event.source !== window || event.origin !== window.location.origin) return;
  const data = event.data;
  if (!data || data.source !== 'quiztool' || data.type !== 'wayground-import') return;
  if (typeof data.base64 !== 'string' || typeof data.fileName !== 'string') return;

  chrome.runtime.sendMessage({
    type: 'start-import',
    title: String(data.title ?? ''),
    fileName: data.fileName,
    base64: data.base64,
  });
});
