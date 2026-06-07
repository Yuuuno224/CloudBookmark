import { bookmarkManager } from '@/bookmark';
import { syncEngine } from '@/sync';
import { tokenManager } from '@/auth';
import { localStore } from '@/storage';
import { changeTracker } from '@/tracker';

async function init(): Promise<void> {
  const hasToken = await tokenManager.hasToken();
  if (!hasToken) {
    console.info('[CloudBookmark] No token configured');
    return;
  }
  await bookmarkManager.init();
  await changeTracker.init();
  console.info('[CloudBookmark] Initialized, manual sync ready');
}

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install' || details.reason === 'update') {
    console.info(`[CloudBookmark] Extension ${details.reason}`);
    await init();
  }
});

chrome.runtime.onStartup.addListener(async () => {
  await init();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'SYNC_NOW') {
    changeTracker.suppress();
    syncEngine.sync().then(() => {
      changeTracker.resume();
      sendResponse({ ok: true });
    }).catch((err) => {
      changeTracker.resume();
      sendResponse({ ok: false, error: err.message });
    });
    return true;
  }

  if (message.type === 'PUSH_NOW') {
    changeTracker.suppress();
    syncEngine.push().then(() => {
      changeTracker.resume();
      sendResponse({ ok: true });
    }).catch((err) => {
      changeTracker.resume();
      sendResponse({ ok: false, error: err.message });
    });
    return true;
  }

  if (message.type === 'PULL_NOW') {
    changeTracker.suppress();
    syncEngine.pull().then((result) => {
      changeTracker.resume();
      sendResponse({ ok: true, conflicts: result.conflicts, applied: result.applied });
    }).catch((err) => {
      changeTracker.resume();
      sendResponse({ ok: false, error: err.message });
    });
    return true;
  }

  if (message.type === 'GET_SYNC_STATE') {
    localStore.getSyncState().then((state) => sendResponse(state));
    return true;
  }

  if (message.type === 'GET_PENDING_CONFLICTS') {
    localStore.getPendingConflicts().then((conflicts) => sendResponse({ conflicts: conflicts || [] }));
    return true;
  }

  if (message.type === 'RESOLVE_CONFLICTS') {
    changeTracker.suppress();
    syncEngine
      .resolveConflicts(message.resolutions)
      .then((result) => {
        changeTracker.resume();
        sendResponse({ ok: true, applied: result.applied });
      })
      .catch((err) => {
        changeTracker.resume();
        sendResponse({ ok: false, error: err.message });
      });
    return true;
  }

  if (message.type === 'GET_CHANGE_LOG') {
    changeTracker
      .getRecentChanges(message.limit || 100)
      .then((records) => sendResponse({ records }));
    return true;
  }

  if (message.type === 'GET_CHANGE_STATS') {
    changeTracker
      .getStats(message.days || 30)
      .then((stats) => sendResponse({ stats }));
    return true;
  }

  if (message.type === 'CLEAR_CHANGE_LOG') {
    changeTracker.clearAll().then(() => sendResponse({ ok: true }));
    return true;
  }

  return false;
});
