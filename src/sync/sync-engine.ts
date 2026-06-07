import type {
  BookmarkTree,
  BookmarkNode,
  SyncMetadata,
  DeletedRecord,
  ConflictEntry,
} from '@/types';
import { GistApiClient } from '@/api';
import { tokenManager } from '@/auth';
import { localStore } from '@/storage';
import { bookmarkManager } from '@/bookmark';
import { nowISO, sha256 } from '@/utils/helpers';
import { threeWayMerge, flattenTree, rebuildTree } from './merge';

const TOMBSTONE_TTL_DAYS = 30;

export class SyncConflictError extends Error {
  constructor(public conflicts: ConflictEntry[]) {
    super('Sync conflicts detected');
    this.name = 'SyncConflictError';
  }
}

export interface PullResult {
  conflicts: ConflictEntry[];
  applied: boolean;
}

export class SyncEngine {
  #syncPromise: Promise<void> | null = null;
  #pushPromise: Promise<void> | null = null;
  #pullPromise: Promise<PullResult> | null = null;
  private apiClient: GistApiClient | null = null;

  private async getApiClient(): Promise<GistApiClient> {
    const token = await tokenManager.getToken();
    if (!token) throw new Error('未配置 Token');
    if (!this.apiClient) {
      this.apiClient = new GistApiClient(token);
    } else {
      this.apiClient.setToken(token);
    }
    return this.apiClient;
  }

  async sync(): Promise<void> {
    if (this.#syncPromise) return this.#syncPromise;
    this.#syncPromise = this._doSync();
    try {
      await this.#syncPromise;
    } finally {
      this.#syncPromise = null;
    }
  }

  async push(): Promise<void> {
    if (this.#pushPromise) return this.#pushPromise;
    this.#pushPromise = this._doPush();
    try {
      await this.#pushPromise;
    } finally {
      this.#pushPromise = null;
    }
  }

  async pull(): Promise<PullResult> {
    if (this.#pullPromise) return this.#pullPromise;
    this.#pullPromise = this._doPull();
    try {
      return await this.#pullPromise;
    } finally {
      this.#pullPromise = null;
    }
  }

  async pullWithResolutions(
    resolutions: { id: string; resolution: 'local' | 'remote' | 'both' }[],
  ): Promise<PullResult> {
    if (this.#pullPromise) return this.#pullPromise;
    this.#pullPromise = this._doPullWithResolutions(resolutions);
    try {
      return await this.#pullPromise;
    } finally {
      this.#pullPromise = null;
    }
  }

  private async _doSync(): Promise<void> {
    try {
      await localStore.setSyncState({ status: 'syncing', lastError: null });

      const api = await this.getApiClient();
      const gistId = await this.ensureGist(api);
      const gist = await api.getGist(gistId);

      const remoteTree = this.parseGistFile<BookmarkTree>(gist, 'bookmarks.json');
      const remoteDeleted = this.parseGistFile<DeletedRecord>(gist, 'deleted.json');
      const remoteNodes = flattenTree(remoteTree);

      const localTree = await bookmarkManager.getBookmarkTree();
      const localNodes = flattenTree(localTree);

      const baseNodes = (await localStore.getBaseState()) || [];
      const syncState = await localStore.getSyncState();
      const isFirstSync = syncState.lastSyncVersion === null;

      const effectiveBase = isFirstSync && baseNodes.length === 0 ? [] : baseNodes;
      const result = threeWayMerge(effectiveBase, localNodes, remoteNodes);

      if (result.conflicts.length > 0) {
        await localStore.setPendingConflicts(result.conflicts);
        await localStore.setSyncState({
          status: 'conflict',
          lastError: `${result.conflicts.length} 个冲突需要解决`,
        });

        const newVersion = gist.history?.[0]?.version || null;
        await localStore.setSyncState({
          status: 'conflict',
          lastSyncAt: nowISO(),
          lastSyncVersion: newVersion,
        });
        return;
      }

      await this.applyTombstones(remoteDeleted);

      const mergedTree = rebuildTree(result.merged);
      mergedTree.checksum = await sha256(JSON.stringify(mergedTree.roots));

      await bookmarkManager.applyMergedTree(mergedTree);

      const finalTree = await bookmarkManager.getBookmarkTree();
      const finalNodes = flattenTree(finalTree);
      await localStore.putBookmarks(finalNodes);
      await localStore.setBaseState(finalNodes);

      await this.pushToRemote(api, gistId, finalTree);

      const updatedGist = await api.getGist(gistId);
      const newVersion = updatedGist.history?.[0]?.version || null;
      await localStore.setSyncState({
        status: 'idle',
        lastSyncAt: nowISO(),
        lastSyncVersion: newVersion,
        isDirty: false,
      });
    } catch (err) {
      if (err instanceof SyncConflictError) throw err;
      const message = err instanceof Error ? err.message : '未知同步错误';
      await localStore.setSyncState({ status: 'error', lastError: message });
      throw err;
    }
  }

  private async _doPush(): Promise<void> {
    try {
      await localStore.setSyncState({ status: 'syncing', lastError: null });

      const api = await this.getApiClient();
      const gistId = await this.ensureGist(api);

      const localTree = await bookmarkManager.getBookmarkTree();

      await this.pushToRemote(api, gistId, localTree);

      const finalNodes = flattenTree(localTree);
      await localStore.putBookmarks(finalNodes);
      await localStore.setBaseState(finalNodes);

      const updatedGist = await api.getGist(gistId);
      const newVersion = updatedGist.history?.[0]?.version || null;
      await localStore.setSyncState({
        status: 'idle',
        lastSyncAt: nowISO(),
        lastSyncVersion: newVersion,
        isDirty: false,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : '上传失败';
      await localStore.setSyncState({ status: 'error', lastError: message });
      throw err;
    }
  }

  private async _doPull(): Promise<PullResult> {
    try {
      await localStore.setSyncState({ status: 'syncing', lastError: null });

      const api = await this.getApiClient();
      const gistId = await this.ensureGist(api);
      const gist = await api.getGist(gistId);

      const remoteTree = this.parseGistFile<BookmarkTree>(gist, 'bookmarks.json');
      const remoteDeleted = this.parseGistFile<DeletedRecord>(gist, 'deleted.json');
      const remoteNodes = flattenTree(remoteTree);

      const localTree = await bookmarkManager.getBookmarkTree();
      const localNodes = flattenTree(localTree);

      const baseNodes = (await localStore.getBaseState()) || [];
      const syncState = await localStore.getSyncState();
      const isFirstSync = syncState.lastSyncVersion === null;

      const effectiveBase = isFirstSync && baseNodes.length === 0 ? [] : baseNodes;
      const result = threeWayMerge(effectiveBase, localNodes, remoteNodes);

      if (result.conflicts.length > 0) {
        await localStore.setSyncState({
          status: 'conflict',
          lastError: `${result.conflicts.length} 个冲突需要解决`,
        });
        await localStore.setPendingConflicts(result.conflicts);
        return { conflicts: result.conflicts, applied: false };
      }

      await this.applyTombstones(remoteDeleted);

      const mergedTree = rebuildTree(result.merged);
      mergedTree.checksum = await sha256(JSON.stringify(mergedTree.roots));

      await bookmarkManager.applyMergedTree(mergedTree);

      const finalTree = await bookmarkManager.getBookmarkTree();
      const finalNodes = flattenTree(finalTree);
      await localStore.putBookmarks(finalNodes);
      await localStore.setBaseState(finalNodes);

      const newVersion = gist.history?.[0]?.version || null;
      await localStore.setSyncState({
        status: 'idle',
        lastSyncAt: nowISO(),
        lastSyncVersion: newVersion,
        isDirty: false,
      });

      return { conflicts: [], applied: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : '下载失败';
      await localStore.setSyncState({ status: 'error', lastError: message });
      throw err;
    }
  }

  private async _doPullWithResolutions(
    resolutions: { id: string; resolution: 'local' | 'remote' | 'both' }[],
  ): Promise<PullResult> {
    try {
      await localStore.setSyncState({ status: 'syncing', lastError: null });

      const pendingConflicts = await localStore.getPendingConflicts();
      if (!pendingConflicts || pendingConflicts.length === 0) {
        return this._doPull();
      }

      const resolutionMap = new Map(resolutions.map((r) => [r.id, r.resolution]));

      const api = await this.getApiClient();
      const gistId = await this.ensureGist(api);
      const gist = await api.getGist(gistId);

      const remoteTree = this.parseGistFile<BookmarkTree>(gist, 'bookmarks.json');
      const remoteDeleted = this.parseGistFile<DeletedRecord>(gist, 'deleted.json');
      const remoteNodes = flattenTree(remoteTree);

      const localTree = await bookmarkManager.getBookmarkTree();
      const localNodes = flattenTree(localTree);

      const baseNodes = (await localStore.getBaseState()) || [];

      const result = threeWayMerge(baseNodes, localNodes, remoteNodes);

      const resolvedNodes = this.applyResolutions(result.merged, result.conflicts, resolutionMap);

      await this.applyTombstones(remoteDeleted);

      const mergedTree = rebuildTree(resolvedNodes);
      mergedTree.checksum = await sha256(JSON.stringify(mergedTree.roots));

      await bookmarkManager.applyMergedTree(mergedTree);

      const finalTree = await bookmarkManager.getBookmarkTree();
      const finalNodes = flattenTree(finalTree);
      await localStore.putBookmarks(finalNodes);
      await localStore.setBaseState(finalNodes);
      await localStore.setPendingConflicts(null);

      const newVersion = gist.history?.[0]?.version || null;
      await localStore.setSyncState({
        status: 'idle',
        lastSyncAt: nowISO(),
        lastSyncVersion: newVersion,
        isDirty: false,
      });

      return { conflicts: [], applied: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : '下载失败';
      await localStore.setSyncState({ status: 'error', lastError: message });
      throw err;
    }
  }

  private applyResolutions(
    merged: BookmarkNode[],
    conflicts: ConflictEntry[],
    resolutionMap: Map<string, 'local' | 'remote' | 'both'>,
  ): BookmarkNode[] {
    const mergedMap = new Map(merged.map((n) => [n.id, n]));

    for (const conflict of conflicts) {
      const resolution = resolutionMap.get(conflict.id) || 'remote';
      const localNode = conflict.localValue as BookmarkNode;
      const remoteNode = conflict.remoteValue as BookmarkNode;

      switch (resolution) {
        case 'local':
          mergedMap.set(conflict.id, localNode);
          break;
        case 'remote':
          mergedMap.set(conflict.id, remoteNode);
          break;
        case 'both':
          mergedMap.set(conflict.id, localNode);
          const remoteCopy: BookmarkNode = {
            ...remoteNode,
            id: `${remoteNode.id}-remote`,
          };
          mergedMap.set(remoteCopy.id, remoteCopy);
          break;
      }
    }

    return Array.from(mergedMap.values());
  }

  private async pushToRemote(
    api: GistApiClient,
    gistId: string,
    tree: BookmarkTree,
  ): Promise<void> {
    const pushChecksum = await sha256(JSON.stringify(tree.roots));
    const lastChecksum = await localStore.getLastChecksum();

    if (pushChecksum !== lastChecksum) {
      const deviceId = await localStore.getDeviceId();
      const metadata: SyncMetadata = {
        schemaVersion: 1,
        devices: {
          [deviceId]: {
            name: 'Current Device',
            lastSyncAt: nowISO(),
            lastSyncVersion: '',
          },
        },
      };

      const localTombstones = await localStore.getAllTombstones();
      const deleted: DeletedRecord = { tombstones: localTombstones };

      await api.updateSyncGist(
        gistId,
        JSON.stringify(tree, null, 2),
        JSON.stringify(metadata, null, 2),
        JSON.stringify(deleted, null, 2),
      );

      await localStore.setLastChecksum(pushChecksum);
    }
  }

  private parseGistFile<T>(gist: { files: Record<string, { content: string }> }, filename: string): T {
    const file = gist.files[filename];
    if (!file?.content) throw new Error(`Gist 文件 ${filename} 未找到`);
    return JSON.parse(file.content) as T;
  }

  private async ensureGist(api: GistApiClient): Promise<string> {
    const existingId = await localStore.getGistId();
    if (existingId) return existingId;

    const existing = await api.findSyncGist();
    if (existing) {
      await localStore.setGistId(existing.id);
      return existing.id;
    }

    const tree = await bookmarkManager.getBookmarkTree();
    const deviceId = await localStore.getDeviceId();
    const metadata: SyncMetadata = {
      schemaVersion: 1,
      devices: {
        [deviceId]: {
          name: 'Current Device',
          lastSyncAt: nowISO(),
          lastSyncVersion: '',
        },
      },
    };
    const deleted: DeletedRecord = { tombstones: [] };

    const gist = await api.createSyncGist(
      JSON.stringify(tree, null, 2),
      JSON.stringify(metadata, null, 2),
      JSON.stringify(deleted, null, 2),
    );

    await localStore.setGistId(gist.id);
    const localNodes = flattenTree(tree);
    await localStore.setBaseState(localNodes);
    const checksum = await sha256(JSON.stringify(tree.roots));
    await localStore.setLastChecksum(checksum);
    return gist.id;
  }

  private async applyTombstones(remoteDeleted: DeletedRecord): Promise<void> {
    const now = Date.now();
    const ttl = TOMBSTONE_TTL_DAYS * 24 * 60 * 60 * 1000;

    for (const tombstone of remoteDeleted.tombstones) {
      const deletedAt = new Date(tombstone.deletedAt).getTime();
      if (now - deletedAt > ttl) continue;

      const browserId = bookmarkManager.toBrowserId(tombstone.id);
      try {
        await chrome.bookmarks.remove(browserId);
      } catch {
        try {
          await chrome.bookmarks.removeTree(browserId);
        } catch { /* already removed */ }
      }
      await localStore.addTombstone(tombstone);
    }
  }

  async resolveConflicts(
    resolutions: { id: string; resolution: 'local' | 'remote' | 'both' }[],
  ): Promise<PullResult> {
    return this.pullWithResolutions(resolutions);
  }

  async isFirstSync(): Promise<boolean> {
    const state = await localStore.getSyncState();
    return state.lastSyncVersion === null;
  }
}

export const syncEngine = new SyncEngine();
