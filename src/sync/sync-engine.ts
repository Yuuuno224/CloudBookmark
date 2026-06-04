import type {
  BookmarkTree,
  BookmarkNode,
  SyncMetadata,
  Tombstone,
  DeletedRecord,
  ConflictEntry,
} from '@/types';
import { GistApiClient, GistApiError, RateLimitExceededError } from '@/api';
import { tokenManager } from '@/auth';
import { localStore } from '@/storage';
import { bookmarkManager } from '@/bookmark';
import { nowISO, sha256, generateId } from '@/utils/helpers';

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

      const remoteBookmarks = this.parseGistFile<BookmarkTree>(
        gist,
        'bookmarks.json',
      );
      const remoteMetadata = this.parseGistFile<SyncMetadata>(
        gist,
        'metadata.json',
      );
      const remoteDeleted = this.parseGistFile<DeletedRecord>(
        gist,
        'deleted.json',
      );

      const hasRemoteChange = remoteVersion !== localVersion;
      const hasLocalChange = syncState.isDirty;
      const isFirstSync = localVersion === null;

      if (hasRemoteChange && hasLocalChange) {
        const conflicts = await this.detectConflicts(remoteBookmarks);
        if (conflicts.length > 0) {
          await localStore.setSyncState({
            status: 'conflict',
            lastError: `${conflicts.length} conflicts detected`,
          });
          throw new SyncConflictError(conflicts);
        }
      }

      if (hasRemoteChange && !isFirstSync) {
        await this.pull(remoteBookmarks, remoteDeleted);
      }

      if (hasLocalChange || !hasRemoteChange || isFirstSync) {
        await this.push(api, gistId);
      }

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
      const message =
        err instanceof Error ? err.message : 'Unknown sync error';
      await localStore.setSyncState({
        status: 'error',
        lastError: message,
      });
      throw err;
    }
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
    const checksum = await sha256(JSON.stringify(tree.roots));
    await localStore.setLastChecksum(checksum);
    return gist.id;
  }

  private async pull(
    remoteTree: BookmarkTree,
    remoteDeleted: DeletedRecord,
  ): Promise<void> {
    await this.applyTombstones(remoteDeleted);
    await bookmarkManager.applyRemoteTree(remoteTree);
  }

  private async push(api: GistApiClient, gistId: string): Promise<void> {
    const tree = await bookmarkManager.getBookmarkTree();
    const checksum = await sha256(JSON.stringify(tree.roots));
    const lastChecksum = await localStore.getLastChecksum();

    if (checksum === lastChecksum) return;

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

    await localStore.setLastChecksum(checksum);
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

  private async detectConflicts(
    remoteTree: BookmarkTree,
  ): Promise<ConflictEntry[]> {
    const conflicts: ConflictEntry[] = [];
    const localTree = await bookmarkManager.getBookmarkTree();

    const localMap = this.buildNodeMap(localTree);
    const remoteMap = this.buildNodeMap(remoteTree);

    for (const [id, localNode] of localMap) {
      const remoteNode = remoteMap.get(id);
      if (!remoteNode) continue;

      if (
        localNode.updatedAt !== remoteNode.updatedAt &&
        localNode.title !== remoteNode.title &&
        localNode.url !== remoteNode.url
      ) {
        conflicts.push({
          id,
          localValue: localNode,
          remoteValue: remoteNode,
          timestamp: nowISO(),
        });
      }
    }

    return conflicts;
  }

  private buildNodeMap(tree: BookmarkTree): Map<string, BookmarkNode> {
    const map = new Map<string, BookmarkNode>();
    const walk = (node: BookmarkNode) => {
      map.set(node.id, node);
      if (node.children) {
        for (const child of node.children) {
          walk(child);
        }
      }
    };
    walk(tree.roots.bookmark_bar);
    walk(tree.roots.other);
    walk(tree.roots.mobile);
    return map;
  }

  async resolveConflicts(
    resolutions: { id: string; resolution: 'local' | 'remote' | 'both' }[],
  ): Promise<void> {
    const remoteTree: BookmarkTree | null = null;
    if (!remoteTree) return;

    const remoteMap = this.buildNodeMap(remoteTree);
    const localTree = await bookmarkManager.getBookmarkTree();
    const localMap = this.buildNodeMap(localTree);

    for (const { id, resolution } of resolutions) {
      const local = localMap.get(id);
      const remote = remoteMap.get(id);

      if (resolution === 'remote' && remote) {
        // remote wins: apply remote to local
      } else if (resolution === 'local' && local) {
        // local wins: will be pushed on next sync
      } else if (resolution === 'both' && local && remote) {
        // keep both: create a copy of remote with new id
        const copy: BookmarkNode = {
          ...remote,
          id: generateId(),
          title: `${remote.title} (copy)`,
          createdAt: nowISO(),
          updatedAt: nowISO(),
        };
        await localStore.putBookmark(copy);
      }
    }

    await localStore.setSyncState({ status: 'idle', isDirty: true });
    await this.sync();
  }

  async isFirstSync(): Promise<boolean> {
    const state = await localStore.getSyncState();
    return state.lastSyncVersion === null;
  }
}

export const syncEngine = new SyncEngine();
