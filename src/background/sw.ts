import { bookmarkManager } from '@/bookmark';
import { syncEngine } from '@/sync';
import { tokenManager } from '@/auth';
import { localStore } from '@/storage';

const SYNC_ALARM = 'cloudbookmark-sync';
const SYNC_INTERVAL_MINUTES = 5;

async function init(): Promise<void> {
  const hasToken = await tokenManager.hasToken();
  if (!hasToken) {
    console.info('[CloudBookmark] No token configured, skipping sync setup');
    return;
  }

  await bookmarkManager.init();

  bookmarkManager.onDirty(() => {
    syncEngine.sync().catch((err) => {
      console.error('[CloudBookmark] Sync on dirty failed:', err);
    });
  });

  chrome.alarms.create(SYNC_ALARM, {
    periodInMinutes: SYNC_INTERVAL_MINUTES,
    delayInMinutes: 0.1,
  });

  await syncEngine.sync();
}

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    console.info('[CloudBookmark] Extension installed');
    await init();
  } else if (details.reason === 'update') {
    console.info('[CloudBookmark] Extension updated');
    await init();
  }
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === SYNC_ALARM) {
    const hasToken = await tokenManager.hasToken();
    if (!hasToken) return;

    try {
      await syncEngine.sync();
    } catch (err) {
      console.error('[CloudBookmark] Periodic sync failed:', err);
    }
  }
});

chrome.runtime.onStartup.addListener(async () => {
  console.info('[CloudBookmark] Browser started');
  await init();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'SYNC_NOW') {
    syncEngine.sync().then(() => sendResponse({ ok: true })).catch((err) => {
      sendResponse({ ok: false, error: err.message });
    });
    return true;
  }

  if (message.type === 'GET_SYNC_STATE') {
    localStore.getSyncState().then((state) => sendResponse(state));
    return true;
  }

  if (message.type === 'RESOLVE_CONFLICTS') {
    syncEngine
      .resolveConflicts(message.resolutions)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => {
        sendResponse({ ok: false, error: err.message });
      });
    return true;
  }

  return false;
});
