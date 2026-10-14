import { computeRevision, createSnapshot } from '@/core/snapshot';
import type { DeviceInfo, PendingSync, Snapshot } from '@/core/types';
import type { RemoteGateway, RemoteRead } from '@/features/gist/remote-store';
import type { SyncStore } from '@/features/sync/service';
import type { UidMap } from '@/platform/uid-map';

/**
 * 内存版"Gist"。
 * 所有设备共享同一个实例，就等价于"大家读写同一个 Gist"。
 */
export class FakeRemote implements RemoteGateway {
  snapshot: Snapshot | null = null;
  writes = 0;
  reads = 0;
  /** 可以模拟网络故障。 */
  failNextWith: Error | null = null;
  #device: DeviceInfo;

  constructor(device: DeviceInfo) {
    this.#device = device;
  }

  #maybeFail(): void {
    if (this.failNextWith) {
      const error = this.failNextWith;
      this.failNextWith = null;
      throw error;
    }
  }

  async ensure(): Promise<{ gistId: string; gistUrl: string }> {
    this.#maybeFail();
    return { gistId: 'gist-fake', gistUrl: 'https://gist.github.com/fake' };
  }

  async read(): Promise<RemoteRead> {
    this.#maybeFail();
    this.reads += 1;
    const snapshot = this.snapshot ?? createSnapshot([], this.#device);
    return {
      snapshot,
      revision: computeRevision(snapshot.entries),
      migrated: false,
      warnings: [],
      gistId: 'gist-fake',
      gistUrl: 'https://gist.github.com/fake',
    };
  }

  async write(snapshot: Snapshot): Promise<void> {
    this.#maybeFail();
    this.writes += 1;
    this.snapshot = { ...snapshot };
  }

  async forget(): Promise<void> {
    this.snapshot = null;
  }

  /** 仅供测试断言：远端当前有哪些标题。 */
  titles(): string[] {
    return (this.snapshot?.entries ?? [])
      .filter((entry) => entry.kind === 'bookmark')
      .map((entry) => entry.title)
      .sort();
  }
}

/** 每个设备一套的内存存档。 */
export class MemoryStore implements SyncStore {
  base: Snapshot | null = null;
  uidMap: UidMap = {};
  pending: PendingSync | null = null;
  backups: Partial<Record<'local' | 'remote', Snapshot>> = {};

  async loadBase(): Promise<Snapshot | null> {
    return this.base;
  }
  async saveBase(snapshot: Snapshot): Promise<void> {
    this.base = snapshot;
  }
  async loadUidMap(): Promise<UidMap> {
    return { ...this.uidMap };
  }
  async saveUidMap(map: UidMap): Promise<void> {
    this.uidMap = { ...map };
  }
  async loadPending(): Promise<PendingSync | null> {
    return this.pending;
  }
  async savePending(pending: PendingSync | null): Promise<void> {
    this.pending = pending;
  }
  async saveBackup(which: 'local' | 'remote', snapshot: Snapshot): Promise<void> {
    this.backups[which] = snapshot;
  }
  async loadBackup(which: 'local' | 'remote'): Promise<Snapshot | null> {
    return this.backups[which] ?? null;
  }
}
