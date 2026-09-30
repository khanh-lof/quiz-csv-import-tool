// Holds each import job until the Wayground tab it opened has finished with it. Jobs are keyed by tab
// id, so a Wayground page acts only on a job created for its own tab.
const JOB_TTL_MS = 10 * 60 * 1000;
// Where Wayground's "create an assessment" flow starts; it redirects to its login first if needed.
const WAYGROUND_START_URL = 'https://wayground.com/activity/admin/assessment';

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message?.type) {
    case 'start-import':
      startImport(message).then(() => sendResponse({ok: true}));
      return true;
    case 'get-job':
      getJob(sender.tab?.id).then(sendResponse);
      return true;
    case 'finish-job':
      if (sender.tab?.id !== undefined) chrome.storage.session.remove(jobKey(sender.tab.id));
      return false;
  }
  return false;
});

async function startImport({title, fileName, base64}) {
  const tab = await chrome.tabs.create({url: WAYGROUND_START_URL});
  await chrome.storage.session.set({
    [jobKey(tab.id)]: {title, fileName, base64, createdAt: Date.now()},
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

function jobKey(tabId) {
  return `job:${tabId}`;
}
