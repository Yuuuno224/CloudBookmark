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

export class SyncEngine {
  #syncPromise: Promise<void> | null = null;
  private apiClient: GistApiClient | null = null;

  private async getApiClient(): Promise<GistApiClient> {
    const token = await tokenManager.getToken();
    if (!token) throw new Error('No token configured');
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

  private async _doSync(): Promise<void> {
    try {
      await localStore.setSyncState({ status: 'syncing', lastError: null });

      const api = await this.getApiClient();
      const gistId = await this.ensureGist(api);
      const gist = await api.getGist(gistId);

      const remoteVersion = gist.history?.[0]?.version || null;
      const syncState = await localStore.getSyncState();
      const localVersion = syncState.lastSyncVersion;
      const isFirstSync = localVersion === null;

      const remoteTree = this.parseGistFile<BookmarkTree>(gist, 'bookmarks.json');
      const remoteDeleted = this.parseGistFile<DeletedRecord>(gist, 'deleted.json');
      const remoteNodes = flattenTree(remoteTree);

      const localTree = await bookmarkManager.getBookmarkTree();
      const localNodes = this.flattenLocalTree(localTree);

      const baseNodes = (await localStore.getBaseState()) || [];

      let mergedNodes: BookmarkNode[];
      let conflicts: ConflictEntry[];

      if (isFirstSync && baseNodes.length === 0) {
        const result = threeWayMerge([], localNodes, remoteNodes);
        mergedNodes = result.merged;
        conflicts = result.conflicts;
      } else {
        const result = threeWayMerge(baseNodes, localNodes, remoteNodes);
        mergedNodes = result.merged;
        conflicts = result.conflicts;
      }

      if (conflicts.length > 0) {
        await localStore.setSyncState({
          status: 'conflict',
          lastError: `${conflicts.length} conflicts detected (auto-resolved with LWW)`,
        });
      }

      await this.applyTombstones(remoteDeleted);

      const mergedTree = rebuildTree(mergedNodes);
      mergedTree.checksum = await sha256(JSON.stringify(mergedTree.roots));

      await bookmarkManager.applyMergedTree(mergedTree);

      const finalTree = await bookmarkManager.getBookmarkTree();
      const finalNodes = flattenTree(finalTree);
      await localStore.putBookmarks(finalNodes);
      await localStore.setBaseState(finalNodes);

      const pushChecksum = await sha256(JSON.stringify(finalTree.roots));
      const lastChecksum = await localStore.getLastChecksum();

      if (pushChecksum !== lastChecksum) {
        const deviceId = await localStore.getDeviceId();
        const metadata: SyncMetadata = {
          schemaVersion: 1,
          devices: {
            [deviceId]: {
              name: 'Current Device',
              lastSyncAt: nowISO(),
              lastSyncVersion: remoteVersion || '',
            },
          },
        };

        const localTombstones = await localStore.getAllTombstones();
        const deleted: DeletedRecord = { tombstones: localTombstones };

        await api.updateSyncGist(
          gistId,
          JSON.stringify(finalTree, null, 2),
          JSON.stringify(metadata, null, 2),
          JSON.stringify(deleted, null, 2),
        );

        await localStore.setLastChecksum(pushChecksum);
      }

      const updatedGist = await api.getGist(gistId);
      const newVersion = updatedGist.history?.[0]?.version || null;
      await localStore.setSyncState({
        status: conflicts.length > 0 ? 'conflict' : 'idle',
        lastSyncAt: nowISO(),
        lastSyncVersion: newVersion,
        isDirty: false,
      });
    } catch (err) {
      if (err instanceof SyncConflictError) throw err;
      const message = err instanceof Error ? err.message : 'Unknown sync error';
      await localStore.setSyncState({ status: 'error', lastError: message });
      throw err;
    }
  }

  private flattenLocalTree(tree: BookmarkTree): BookmarkNode[] {
    return flattenTree(tree);
  }

  private parseGistFile<T>(gist: { files: Record<string, { content: string }> }, filename: string): T {
    const file = gist.files[filename];
    if (!file?.content) throw new Error(`Gist file ${filename} not found`);
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

      try {
        await chrome.bookmarks.remove(tombstone.id);
      } catch {
        try {
          await chrome.bookmarks.removeTree(tombstone.id);
        } catch {
          // already removed
        }
      }
      await localStore.addTombstone(tombstone);
    }
  }

  async resolveConflicts(
    resolutions: { id: string; resolution: 'local' | 'remote' | 'both' }[],
  ): Promise<void> {
    await localStore.setSyncState({ status: 'idle', isDirty: true });
    await this.sync();
  }

  async isFirstSync(): Promise<boolean> {
    const state = await localStore.getSyncState();
    return state.lastSyncVersion === null;
  }
}

export const syncEngine = new SyncEngine();
