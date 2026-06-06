export interface BookmarkNode {
  id: string;
  title: string;
  type: 'bookmark' | 'folder';
  url?: string;
  parentId?: string;
  children?: BookmarkNode[];
  createdAt: string;
  updatedAt: string;
}

export interface BookmarkTree {
  version: number;
  updatedAt: string;
  checksum: string;
  roots: {
    bookmark_bar: BookmarkNode;
    other: BookmarkNode;
    mobile: BookmarkNode;
  };
}

export interface Tombstone {
  id: string;
  deletedAt: string;
  deletedBy: string;
}

export interface DeletedRecord {
  tombstones: Tombstone[];
}

export interface DeviceInfo {
  name: string;
  lastSyncAt: string;
  lastSyncVersion: string;
}

export interface SyncMetadata {
  schemaVersion: number;
  devices: Record<string, DeviceInfo>;
  conflictLog?: ConflictEntry[];
}

export interface ConflictEntry {
  id: string;
  localValue: unknown;
  remoteValue: unknown;
  resolvedAt?: string;
  resolution?: 'local' | 'remote' | 'both';
  timestamp: string;
}

export type SyncStatus = 'idle' | 'syncing' | 'conflict' | 'error' | 'offline';

export interface SyncState {
  status: SyncStatus;
  lastSyncAt: string | null;
  lastSyncVersion: string | null;
  lastError: string | null;
  isDirty: boolean;
}

export type ChangeAction = 'create' | 'remove' | 'update' | 'move';

export interface ChangeRecord {
  id: string;
  action: ChangeAction;
  bookmarkId: string;
  bookmarkTitle: string;
  bookmarkUrl?: string;
  parentId?: string;
  oldParentId?: string;
  timestamp: string;
  details?: string;
}

export interface ChangeStats {
  total: number;
  creates: number;
  removes: number;
  updates: number;
  moves: number;
  byDate: Record<string, number>;
  byHour: number[];
  topFolders: { parentId: string; title: string; count: number }[];
}
