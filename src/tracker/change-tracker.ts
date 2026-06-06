import type { ChangeRecord, ChangeStats } from '@/types';
import { localStore } from '@/storage';
import { nowISO, generateId } from '@/utils/helpers';

const MAX_RECORDS = 5000;

export class ChangeTracker {
  private initialized = false;
  private suppressing = false;

  suppress(): void {
    this.suppressing = true;
  }

  resume(): void {
    this.suppressing = false;
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    chrome.bookmarks.onCreated.addListener((id, bookmark) => {
      if (this.suppressing) return;
      this.recordCreate(id, bookmark.title, bookmark.url, bookmark.parentId?.toString());
    });

    chrome.bookmarks.onRemoved.addListener((id, removeInfo) => {
      if (this.suppressing) return;
      this.recordRemove(id, removeInfo.node?.title || '', removeInfo.node?.url, removeInfo.parentId?.toString());
    });

    chrome.bookmarks.onChanged.addListener((id, changeInfo) => {
      if (this.suppressing) return;
      this.recordUpdate(id, changeInfo.title, changeInfo.url);
    });

    chrome.bookmarks.onMoved.addListener((id, moveInfo) => {
      if (this.suppressing) return;
      this.recordMove(id, moveInfo.parentId?.toString(), moveInfo.oldParentId?.toString());
    });
  }

  private async recordCreate(
    bookmarkId: string,
    title: string,
    url?: string,
    parentId?: string,
  ): Promise<void> {
    const record: ChangeRecord = {
      id: generateId(),
      action: 'create',
      bookmarkId,
      bookmarkTitle: title,
      bookmarkUrl: url,
      parentId,
      timestamp: nowISO(),
    };
    await this.persist(record);
  }

  private async recordRemove(
    bookmarkId: string,
    title: string,
    url?: string | null,
    parentId?: string,
  ): Promise<void> {
    const record: ChangeRecord = {
      id: generateId(),
      action: 'remove',
      bookmarkId,
      bookmarkTitle: title,
      bookmarkUrl: url || undefined,
      parentId,
      timestamp: nowISO(),
    };
    await this.persist(record);
  }

  private async recordUpdate(
    bookmarkId: string,
    title: string,
    url?: string,
  ): Promise<void> {
    const record: ChangeRecord = {
      id: generateId(),
      action: 'update',
      bookmarkId,
      bookmarkTitle: title,
      bookmarkUrl: url,
      timestamp: nowISO(),
      details: url ? `title→${title}, url→${url}` : `title→${title}`,
    };
    await this.persist(record);
  }

  private async recordMove(
    bookmarkId: string,
    newParentId?: string,
    oldParentId?: string,
  ): Promise<void> {
    const record: ChangeRecord = {
      id: generateId(),
      action: 'move',
      bookmarkId,
      bookmarkTitle: '',
      parentId: newParentId,
      oldParentId,
      timestamp: nowISO(),
      details: `${oldParentId || '?'} → ${newParentId || '?'}`,
    };
    await this.persist(record);
  }

  private async persist(record: ChangeRecord): Promise<void> {
    await localStore.addChangeRecord(record);
    const count = await localStore.getChangeRecordCount();
    if (count > MAX_RECORDS) {
      await localStore.trimChangeRecords(MAX_RECORDS - 1000);
    }
  }

  async getRecentChanges(limit = 50): Promise<ChangeRecord[]> {
    return localStore.getRecentChangeRecords(limit);
  }

  async getStats(days = 30): Promise<ChangeStats> {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const records = await localStore.getChangeRecordsSince(since);

    const stats: ChangeStats = {
      total: records.length,
      creates: 0,
      removes: 0,
      updates: 0,
      moves: 0,
      byDate: {},
      byHour: new Array(24).fill(0),
      topFolders: [],
    };

    const folderCount = new Map<string, { title: string; count: number }>();

    for (const r of records) {
      switch (r.action) {
        case 'create': stats.creates++; break;
        case 'remove': stats.removes++; break;
        case 'update': stats.updates++; break;
        case 'move': stats.moves++; break;
      }

      const date = r.timestamp.slice(0, 10);
      stats.byDate[date] = (stats.byDate[date] || 0) + 1;

      const hour = parseInt(r.timestamp.slice(11, 13), 10);
      if (hour >= 0 && hour < 24) stats.byHour[hour]++;

      if (r.parentId && r.action === 'create') {
        const existing = folderCount.get(r.parentId);
        if (existing) {
          existing.count++;
        } else {
          folderCount.set(r.parentId, { title: r.parentId, count: 1 });
        }
      }
    }

    stats.topFolders = [...folderCount.values()]
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    return stats;
  }

  async clearAll(): Promise<void> {
    await localStore.clearChangeRecords();
  }
}

export const changeTracker = new ChangeTracker();
