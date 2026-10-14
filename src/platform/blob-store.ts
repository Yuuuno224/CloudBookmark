/**
 * 大数据存储（IndexedDB）
 * ======================
 *
 * 这里放体积可能很大的东西：
 *  - 同步基准快照 base（三方合并里的"第三份数据"）
 *  - 身份表 uidMap（浏览器 id <-> 稳定 uid）
 *  - 待用户处理的冲突（pending）
 *  - 覆盖前的备份（用于"回滚"）
 *  - 变更记录 / 同步历史
 *
 * 为什么不放 chrome.storage.local？因为它有 10MB 上限，
 * 而且每次写入都要把整个对象序列化一遍，书签上千条时会很慢。
 * IndexedDB 是浏览器专门为这种数据准备的。
 *
 * 只有 background（Service Worker）会读写这个数据库，界面通过消息拿数据，
 * 这样就不用担心"两个页面同时写导致数据打架"。
 */

import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { ChangeRecord, Snapshot, SyncLogEntry } from '@/core/types';
import type { UidMap } from './uid-map';

const DB_NAME = 'cloudbookmark';
const DB_VERSION = 3;

/** 固定的大对象键名。 */
export const BLOB = {
  /** 上次同步完成时的快照（三方合并的 base）。 */
  base: 'snapshot:base',
  /** 覆盖本地之前，本地快照的备份。 */
  backupLocal: 'backup:local',
  /** 覆盖远端之前，远端快照的备份。 */
  backupRemote: 'backup:remote',
  /** 等待用户裁决的同步。 */
  pending: 'pending:sync',
} as const;

export type BlobKey = (typeof BLOB)[keyof typeof BLOB];

interface BlobsSchema extends DBSchema {
  blobs: {
    key: string;
    value: { key: string; value: unknown; savedAt: string };
  };
  changelog: {
    key: string;
    value: ChangeRecord;
    indexes: { at: string };
  };
  synclog: {
    key: string;
    value: SyncLogEntry;
    indexes: { at: string };
  };
}

let dbPromise: Promise<IDBPDatabase<BlobsSchema>> | null = null;

function getDb(): Promise<IDBPDatabase<BlobsSchema>> {
  if (!dbPromise) {
    dbPromise = openDB<BlobsSchema>(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion) {
        // 旧版本（v2 及以前）用过的对象仓库，直接删掉，顺便把空间还回来。
        // 这里退回到原生 IDBDatabase 接口，因为 idb 的类型只认当前定义的仓库名。
        const raw = db as unknown as IDBDatabase;
        for (const legacy of ['bookmarks', 'tombstones', 'syncMeta', 'changeRecords']) {
          if (raw.objectStoreNames.contains(legacy)) raw.deleteObjectStore(legacy);
        }
        if (!db.objectStoreNames.contains('blobs')) {
          db.createObjectStore('blobs', { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains('changelog')) {
          const store = db.createObjectStore('changelog', { keyPath: 'id' });
          store.createIndex('at', 'at');
        }
        if (!db.objectStoreNames.contains('synclog')) {
          const store = db.createObjectStore('synclog', { keyPath: 'id' });
          store.createIndex('at', 'at');
        }
        void oldVersion;
      },
    });
  }
  return dbPromise;
}

export const blobStore = {
  async get<T>(key: string): Promise<T | null> {
    const db = await getDb();
    const record = await db.get('blobs', key);
    return (record?.value as T) ?? null;
  },

  async set(key: string, value: unknown): Promise<void> {
    const db = await getDb();
    await db.put('blobs', { key, value, savedAt: new Date().toISOString() });
  },

  async del(key: string): Promise<void> {
    const db = await getDb();
    await db.delete('blobs', key);
  },

  /** 每个大对象最后保存的时间，界面上可以告诉用户"备份有多新"。 */
  async savedAt(key: string): Promise<string | null> {
    const db = await getDb();
    const record = await db.get('blobs', key);
    return record?.savedAt ?? null;
  },

  async listKeys(): Promise<string[]> {
    const db = await getDb();
    return db.getAllKeys('blobs');
  },
};

// ---------------------------------------------------------------------------
// 快照与身份表的强类型读写
// ---------------------------------------------------------------------------

export const snapshotStore = {
  getBase(): Promise<Snapshot | null> {
    return blobStore.get<Snapshot>(BLOB.base);
  },
  saveBase(snapshot: Snapshot): Promise<void> {
    return blobStore.set(BLOB.base, snapshot);
  },
  clearBase(): Promise<void> {
    return blobStore.del(BLOB.base);
  },
  getBackup(which: 'local' | 'remote'): Promise<Snapshot | null> {
    return blobStore.get<Snapshot>(which === 'local' ? BLOB.backupLocal : BLOB.backupRemote);
  },
  saveBackup(which: 'local' | 'remote', snapshot: Snapshot): Promise<void> {
    return blobStore.set(which === 'local' ? BLOB.backupLocal : BLOB.backupRemote, snapshot);
  },
  backupTime(which: 'local' | 'remote'): Promise<string | null> {
    return blobStore.savedAt(which === 'local' ? BLOB.backupLocal : BLOB.backupRemote);
  },
};

export const uidMapStore = {
  async load(): Promise<UidMap> {
    return (await blobStore.get<UidMap>('uidmap')) ?? {};
  },
  save(map: UidMap): Promise<void> {
    return blobStore.set('uidmap', map);
  },
  clear(): Promise<void> {
    return blobStore.del('uidmap');
  },
};

// ---------------------------------------------------------------------------
// 变更记录
// ---------------------------------------------------------------------------

export const changeLogStore = {
  async add(record: ChangeRecord): Promise<void> {
    const db = await getDb();
    await db.put('changelog', record);
  },

  async recent(limit: number): Promise<ChangeRecord[]> {
    const db = await getDb();
    const all = await db.getAllFromIndex('changelog', 'at');
    return all.reverse().slice(0, limit);
  },

  async count(): Promise<number> {
    const db = await getDb();
    return db.count('changelog');
  },

  async trim(keep: number): Promise<void> {
    const db = await getDb();
    const all = await db.getAllFromIndex('changelog', 'at');
    if (all.length <= keep) return;
    const tx = db.transaction('changelog', 'readwrite');
    for (const record of all.slice(0, all.length - keep)) {
      await tx.store.delete(record.id);
    }
    await tx.done;
  },

  async clear(): Promise<void> {
    const db = await getDb();
    await db.clear('changelog');
  },
};

// ---------------------------------------------------------------------------
// 同步历史
// ---------------------------------------------------------------------------

export const syncLogStore = {
  async add(entry: SyncLogEntry): Promise<void> {
    const db = await getDb();
    await db.put('synclog', entry);
  },

  async recent(limit: number): Promise<SyncLogEntry[]> {
    const db = await getDb();
    const all = await db.getAllFromIndex('synclog', 'at');
    return all.reverse().slice(0, limit);
  },

  async trim(keep: number): Promise<void> {
    const db = await getDb();
    const all = await db.getAllFromIndex('synclog', 'at');
    if (all.length <= keep) return;
    const tx = db.transaction('synclog', 'readwrite');
    for (const record of all.slice(0, all.length - keep)) {
      await tx.store.delete(record.id);
    }
    await tx.done;
  },

  async clear(): Promise<void> {
    const db = await getDb();
    await db.clear('synclog');
  },
};
