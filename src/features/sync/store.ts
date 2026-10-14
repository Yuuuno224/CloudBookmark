/**
 * 本地状态存储 + 同步状态
 * ========================
 *
 * SyncStore 是 SyncService 需要的"存档接口"的真实实现：
 * 基准快照、身份表、待处理冲突、备份都存在 IndexedDB 里；
 * 同步状态（很小、界面要实时看）存在 chrome.storage.local 里。
 */

import type { PendingSync, SyncLogEntry, SyncState } from '@/core/types';
import { BLOB, blobStore, snapshotStore, syncLogStore, uidMapStore } from '@/platform/blob-store';
import { kvStore } from '@/platform/kv';
import { defaultSyncState } from '@/features/settings';
import type { SyncStore } from './service';

export const syncStore: SyncStore = {
  loadBase: () => snapshotStore.getBase(),
  saveBase: (snapshot) => snapshotStore.saveBase(snapshot),
  loadUidMap: () => uidMapStore.load(),
  saveUidMap: (map) => uidMapStore.save(map),
  loadPending: () => blobStore.get<PendingSync>(BLOB.pending),
  savePending: (pending) =>
    pending === null ? blobStore.del(BLOB.pending) : blobStore.set(BLOB.pending, pending),
  saveBackup: (which, snapshot) => snapshotStore.saveBackup(which, snapshot),
  loadBackup: (which) => snapshotStore.getBackup(which),
};

// ---------------------------------------------------------------------------
// 同步状态
// ---------------------------------------------------------------------------

/**
 * 状态更新的串行队列。
 * 同步过程中会连续更新好几次状态，如果并发读-改-写，后面的更新可能覆盖前面的，
 * 所以这里用一条 Promise 链把写入排好队。
 */
let stateQueue: Promise<void> = Promise.resolve();

export async function readSyncState(): Promise<SyncState> {
  const stored = await kvStore.get('syncState');
  return { ...defaultSyncState(), ...(stored ?? {}) };
}

export function patchSyncState(patch: Partial<SyncState>): Promise<void> {
  stateQueue = stateQueue.then(async () => {
    const current = await readSyncState();
    await kvStore.set('syncState', { ...current, ...patch });
  });
  return stateQueue;
}

// ---------------------------------------------------------------------------
// 同步历史
// ---------------------------------------------------------------------------

/** 最多保留多少条同步历史。 */
const SYNC_LOG_LIMIT = 200;

export async function addSyncLog(entry: SyncLogEntry): Promise<void> {
  await syncLogStore.add(entry);
  // 偶尔清理一次，不必每条都查数量
  if (Math.random() < 0.05) await syncLogStore.trim(SYNC_LOG_LIMIT);
}

export async function listSyncLog(limit = 50): Promise<SyncLogEntry[]> {
  return syncLogStore.recent(limit);
}

export async function clearSyncLog(): Promise<void> {
  await syncLogStore.clear();
}
