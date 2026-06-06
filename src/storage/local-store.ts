import { openDB, type IDBPDatabase } from 'idb';
import type { BookmarkNode, SyncState, Tombstone, ChangeRecord } from '@/types';

const DB_NAME = 'cloudbookmark';
const DB_VERSION = 2;

interface CloudBookmarkDB {
  bookmarks: BookmarkNode & { parentId?: string };
  tombstones: Tombstone;
  syncMeta: { key: string; value: unknown };
  changeRecords: ChangeRecord;
}

let dbInstance: IDBPDatabase<CloudBookmarkDB> | null = null;

async function getDB(): Promise<IDBPDatabase<CloudBookmarkDB>> {
  if (dbInstance) return dbInstance;
  dbInstance = await openDB<CloudBookmarkDB>(DB_NAME, DB_VERSION, {
    upgrade(db, oldVersion) {
      if (!db.objectStoreNames.contains('bookmarks')) {
        const store = db.createObjectStore('bookmarks', { keyPath: 'id' });
        store.createIndex('parentId', 'parentId');
      }
      if (!db.objectStoreNames.contains('tombstones')) {
        db.createObjectStore('tombstones', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('syncMeta')) {
        db.createObjectStore('syncMeta', { keyPath: 'key' });
      }
      if (oldVersion < 2 && !db.objectStoreNames.contains('changeRecords')) {
        const store = db.createObjectStore('changeRecords', { keyPath: 'id' });
        store.createIndex('timestamp', 'timestamp');
        store.createIndex('action', 'action');
        store.createIndex('bookmarkId', 'bookmarkId');
      }
    },
  });
  return dbInstance;
}

export class LocalStore {
  async getAllBookmarks(): Promise<BookmarkNode[]> {
    const db = await getDB();
    return db.getAll('bookmarks');
  }

  async getBookmark(id: string): Promise<BookmarkNode | undefined> {
    const db = await getDB();
    return db.get('bookmarks', id);
  }

  async getChildren(parentId: string): Promise<BookmarkNode[]> {
    const db = await getDB();
    return db.getAllFromIndex('bookmarks', 'parentId', parentId);
  }

  async putBookmark(node: BookmarkNode): Promise<void> {
    const db = await getDB();
    await db.put('bookmarks', node);
  }

  async putBookmarks(nodes: BookmarkNode[]): Promise<void> {
    const db = await getDB();
    const tx = db.transaction('bookmarks', 'readwrite');
    for (const node of nodes) {
      await tx.store.put(node);
    }
    await tx.done;
  }

  async deleteBookmark(id: string): Promise<void> {
    const db = await getDB();
    await db.delete('bookmarks', id);
  }

  async clearBookmarks(): Promise<void> {
    const db = await getDB();
    await db.clear('bookmarks');
  }

  async addTombstone(tombstone: Tombstone): Promise<void> {
    const db = await getDB();
    await db.put('tombstones', tombstone);
  }

  async getAllTombstones(): Promise<Tombstone[]> {
    const db = await getDB();
    return db.getAll('tombstones');
  }

  async removeTombstone(id: string): Promise<void> {
    const db = await getDB();
    await db.delete('tombstones', id);
  }

  async clearTombstones(): Promise<void> {
    const db = await getDB();
    await db.clear('tombstones');
  }

  async getSyncState(): Promise<SyncState> {
    const db = await getDB();
    const state = await db.get('syncMeta', 'syncState');
    return (
      state?.value || {
        status: 'idle',
        lastSyncAt: null,
        lastSyncVersion: null,
        lastError: null,
        isDirty: false,
      }
    ) as SyncState;
  }

  async setSyncState(state: Partial<SyncState>): Promise<void> {
    const db = await getDB();
    const current = await this.getSyncState();
    await db.put('syncMeta', {
      key: 'syncState',
      value: { ...current, ...state },
    });
  }

  async getGistId(): Promise<string | null> {
    const db = await getDB();
    const record = await db.get('syncMeta', 'gistId');
    return (record?.value as string) || null;
  }

  async setGistId(gistId: string): Promise<void> {
    const db = await getDB();
    await db.put('syncMeta', { key: 'gistId', value: gistId });
  }

  async getDeviceId(): Promise<string> {
    const db = await getDB();
    const record = await db.get('syncMeta', 'deviceId');
    if (record?.value) return record.value as string;
    const deviceId = `device-${crypto.randomUUID().slice(0, 8)}`;
    await db.put('syncMeta', { key: 'deviceId', value: deviceId });
    return deviceId;
  }

  async getLastChecksum(): Promise<string | null> {
    const db = await getDB();
    const record = await db.get('syncMeta', 'lastChecksum');
    return (record?.value as string) || null;
  }

  async setLastChecksum(checksum: string): Promise<void> {
    const db = await getDB();
    await db.put('syncMeta', { key: 'lastChecksum', value: checksum });
  }

  async getBaseState(): Promise<BookmarkNode[] | null> {
    const db = await getDB();
    const record = await db.get('syncMeta', 'baseState');
    return (record?.value as BookmarkNode[]) || null;
  }

  async setBaseState(nodes: BookmarkNode[]): Promise<void> {
    const db = await getDB();
    await db.put('syncMeta', { key: 'baseState', value: nodes });
  }

  async addChangeRecord(record: ChangeRecord): Promise<void> {
    const db = await getDB();
    await db.put('changeRecords', record);
  }

  async getChangeRecordCount(): Promise<number> {
    const db = await getDB();
    return db.count('changeRecords');
  }

  async getRecentChangeRecords(limit = 50): Promise<ChangeRecord[]> {
    const db = await getDB();
    const all = await db.getAllFromIndex('changeRecords', 'timestamp');
    return all.reverse().slice(0, limit);
  }

  async getChangeRecordsSince(since: string): Promise<ChangeRecord[]> {
    const db = await getDB();
    const all = await db.getAllFromIndex('changeRecords', 'timestamp');
    return all.filter((r) => r.timestamp >= since);
  }

  async trimChangeRecords(keepCount: number): Promise<void> {
    const db = await getDB();
    const all = await db.getAllFromIndex('changeRecords', 'timestamp');
    if (all.length <= keepCount) return;
    const toRemove = all.slice(0, all.length - keepCount);
    const tx = db.transaction('changeRecords', 'readwrite');
    for (const r of toRemove) {
      await tx.store.delete(r.id);
    }
    await tx.done;
  }

  async clearChangeRecords(): Promise<void> {
    const db = await getDB();
    await db.clear('changeRecords');
  }
}

export const localStore = new LocalStore();
