// Holds each import job until the platform tab it opened has finished with it. Jobs are keyed by tab
// id, so a platform page acts only on a job created for its own tab. When the job finishes, the
// result goes back to the QuizTool tab that asked for it.
const JOB_TTL_MS = 10 * 60 * 1000;
// Where each platform's "create a quiz" flow starts; both redirect to their login first if needed.
const START_URLS = {
  wayground: 'https://wayground.com/activity/admin/assessment',
  gimkit: 'https://www.gimkit.com/create',
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message?.type) {
    case 'start-import':
      startImport(message, sender.tab?.id).then(() => sendResponse({ok: true}));
      return true;
    case 'get-job':
      getJob(sender.tab?.id).then(sendResponse);
      return true;
    case 'finish-job':
      finishJob(sender.tab?.id, message);
      return false;
  }
  return false;
});

async function startImport({platform, requestId, title, fileName, base64}, sourceTabId) {
  const tab = await chrome.tabs.create({url: START_URLS[platform]});
  await chrome.storage.session.set({
    [jobKey(tab.id)]: {platform, requestId, title, fileName, base64, sourceTabId, createdAt: Date.now()},
  });
}

async function getJob(tabId) {
  if (tabId === undefined) return null;
  const key = jobKey(tabId);
  const job = (await chrome.storage.session.get(key))[key];
  if (!job) return null;
  if (Date.now() - job.createdAt > JOB_TTL_MS) {
    await chrome.storage.session.remove(key);
    return null;
  }
  return job;
}

// On success the platform tab has done its job and is closed, bringing the teacher back to
// QuizTool. On failure it stays open, showing where it got stuck, so the teacher can finish there.
async function finishJob(tabId, {ok, shareUrl, error}) {
  const job = await getJob(tabId);
  if (!job) return;
  await chrome.storage.session.remove(jobKey(tabId));

  const result = {
    type: 'import-result', platform: job.platform, requestId: job.requestId, title: job.title, ok: !!ok, shareUrl, error,
  };
  try {
    await chrome.tabs.sendMessage(job.sourceTabId, result);
  } catch {
    // The QuizTool tab was closed or reloaded; the teacher still has the platform tab.
    return;
  }
  if (ok) {
    await chrome.tabs.update(job.sourceTabId, {active: true});
    await chrome.tabs.remove(tabId);
  }
}

function jobKey(tabId) {
  return `job:${tabId}`;
}
