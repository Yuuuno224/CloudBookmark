/**
 * 同步服务（编排层）
 * ==================
 *
 * 这个文件本身不做"算法"，它是把前面几块拼起来的指挥：
 *
 *   读本地快照 → 读远端快照 → 读 base → 三方合并 → 写回浏览器 → 上传远端 → 更新 base
 *
 * ## 依赖注入
 *
 * 注意构造函数收到的都是**接口**（BookmarkAdapter / RemoteGateway / SyncStore），
 * 没有一处直接写 chrome.*。这么做的好处是可以拿两个内存假浏览器 + 一个
 * 假 Gist，在单元测试里把"两台设备来回同步"完整跑一遍
 * （见 tests/e2e.sync.test.ts）。真实环境在 background/index.ts 里注入。
 *
 * ## 四种操作的区别
 *
 * | 操作        | 会对本地书签做什么        | 会对云端做什么            |
 * |-------------|---------------------------|---------------------------|
 * | merge 合并  | 写入合并结果              | 内容有变化时上传          |
 * | push 上传   | 不动                      | 用本地覆盖云端（危险）    |
 * | pull 下载   | 用云端覆盖本地（危险）    | 不动                      |
 * | 导入 / 清理 | 按你的选择改动            | 不动                      |
 */

import { repairHierarchy } from '@/core/entries';
import { newRecordId, nowIso } from '@/core/ids';
import { summarizeConflicts, threeWayMerge } from '@/core/merge';
import { applyResolutions } from '@/core/resolve';
import {
  applyIdentityLinks,
  computeRevision,
  createSnapshot,
  diffCounts,
  findDuplicateUrls,
  parseSnapshot,
  reconcileFirstSync,
  serializeSnapshot,
} from '@/core/snapshot';
import {
  AppError,
  type ChangeCounts,
  type DeviceInfo,
  type Entry,
  type MergeWarning,
  type PendingSync,
  type Resolution,
  type Settings,
  type Snapshot,
  type SyncLogEntry,
  type SyncMode,
  type SyncOutcome,
  type SyncState,
} from '@/core/types';
import { applySnapshot } from '@/platform/apply';
import type { BookmarkAdapter } from '@/platform/bookmarks';
import { readLocalSnapshot, uidMapFromView, type LocalView, type UidMap } from '@/platform/uid-map';
import type { RemoteGateway, RemoteRead } from '@/features/gist/remote-store';

/** 本地状态的持久化接口（真实实现见 features/sync/store.ts）。 */
export interface SyncStore {
  loadBase(): Promise<Snapshot | null>;
  saveBase(snapshot: Snapshot): Promise<void>;
  loadUidMap(): Promise<UidMap>;
  saveUidMap(map: UidMap): Promise<void>;
  loadPending(): Promise<PendingSync | null>;
  savePending(pending: PendingSync | null): Promise<void>;
  saveBackup(which: 'local' | 'remote', snapshot: Snapshot): Promise<void>;
  loadBackup(which: 'local' | 'remote'): Promise<Snapshot | null>;
}

export interface SyncHooks {
  onState?: (patch: Partial<SyncState>) => void | Promise<void>;
  onLog?: (entry: SyncLogEntry) => void | Promise<void>;
}

export interface SyncServiceDeps {
  adapter: BookmarkAdapter;
  remote: RemoteGateway;
  store: SyncStore;
  device: DeviceInfo;
  settings: () => Promise<Settings>;
  hooks?: SyncHooks;
}

const ZERO_COUNTS: ChangeCounts = { added: 0, updated: 0, moved: 0, removed: 0 };

export class SyncService {
  #adapter: BookmarkAdapter;
  #remote: RemoteGateway;
  #store: SyncStore;
  #device: DeviceInfo;
  #settings: () => Promise<Settings>;
  #hooks: SyncHooks;
  #running: Promise<void> | null = null;

  constructor(deps: SyncServiceDeps) {
    this.#adapter = deps.adapter;
    this.#remote = deps.remote;
    this.#store = deps.store;
    this.#device = deps.device;
    this.#settings = deps.settings;
    this.#hooks = deps.hooks ?? {};
  }

  // -------------------------------------------------------------------------
  // 对外入口
  // -------------------------------------------------------------------------

  /** 统一入口。同一时间只允许一个同步在跑。 */
  async run(mode: SyncMode, force = false): Promise<SyncOutcome> {
    if (this.#running) {
      throw new AppError('busy', '上一次同步还没有结束，请稍候再试。');
    }
    const task = this.#execute(mode, force);
    this.#running = task.then(
      () => undefined,
      () => undefined,
    );
    try {
      return await task;
    } finally {
      this.#running = null;
    }
  }

  async #execute(mode: SyncMode, force: boolean): Promise<SyncOutcome> {
    try {
      if (mode === 'merge') return await this.#merge(force);
      if (mode === 'push') return await this.#push(force);
      return await this.#pull(force);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.#state({ status: 'error', phase: null, lastError: message, runningMode: null });
      await this.#log({
        id: newRecordId(),
        at: nowIso(),
        mode,
        ok: false,
        ...ZERO_COUNTS,
        pushed: false,
        conflictCount: 0,
        error: message,
      });
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // 合并同步
  // -------------------------------------------------------------------------

  async #merge(force: boolean): Promise<SyncOutcome> {
    const settings = await this.#settings();
    const warnings: MergeWarning[] = [];

    await this.#state({ status: 'syncing', phase: '读取本地书签', runningMode: 'merge', lastError: null });
    const view = await this.readLocal();

    await this.#state({ phase: '读取云端数据' });
    const remote = await this.#remote.read();
    warnings.push(...remote.warnings);
    const base = await this.#store.loadBase();

    // ---- 首次同步：本地还没有同步基准 ----
    if (!base && remote.snapshot.entries.length > 0) {
      if (settings.firstSyncStrategy === 'local-wins') {
        return this.#push(force, { skipRecheck: true });
      }
      if (settings.firstSyncStrategy === 'remote-wins') {
        return this.#pull(force, { skipRecheck: true, alreadyRead: { view, remote } });
      }
    }

    // 首次同步时按 URL / 标题给本地书签"认领"远端身份，避免两边各建一份
    let localEntries = view.snapshot.entries;
    let renames: Map<string, string> | undefined;
    if (!base && remote.snapshot.entries.length > 0 && settings.firstSyncStrategy === 'merge') {
      const { links } = reconcileFirstSync(localEntries, remote.snapshot.entries);
      if (links.length > 0) {
        const linked = applyIdentityLinks(localEntries, links);
        localEntries = linked.entries;
        renames = linked.renames;
        warnings.push({
          code: 'first-sync-matched',
          message: `首次同步：有 ${links.length} 条书签和云端对上了号，不会重复添加。`,
        });
      }
    }

    await this.#state({ phase: '合并本地与云端' });
    const result = threeWayMerge(base?.entries ?? [], localEntries, remote.snapshot.entries, {
      conflictPolicy: settings.conflictPolicy,
    });
    warnings.push(...result.warnings);

    const conflictCount = result.conflicts.length;
    if (settings.conflictPolicy === 'ask' && conflictCount > 0 && !force) {
      await this.#store.savePending({
        id: newRecordId(),
        createdAt: nowIso(),
        merged: result.entries,
        conflicts: result.conflicts,
        warnings,
        remoteRevision: remote.revision,
        baseRevision: base?.revision ?? '',
        localSnapshot: view.snapshot,
        remoteSnapshot: remote.snapshot,
      });
      await this.#state({
        status: 'conflict',
        phase: null,
        conflictCount,
        runningMode: null,
        lastError: null,
        remoteRevision: remote.revision,
        remoteDeviceName: remote.snapshot.deviceName,
        remoteUpdatedAt: remote.snapshot.generatedAt,
        entryCount: view.snapshot.entries.length,
      });
      return {
        ok: true,
        mode: 'merge',
        needsConfirm: null,
        counts: ZERO_COUNTS,
        pushed: false,
        conflictCount,
        warnings,
        error: null,
      };
    }

    if (conflictCount > 0) {
      warnings.push({
        code: 'conflicts-auto-resolved',
        message:
          settings.conflictPolicy === 'ask'
            ? `已按你选择的"继续"自动处理 ${conflictCount} 个冲突（字段冲突采用远端，删除冲突保留被修改的一方）。`
            : `已按当前冲突策略自动处理 ${conflictCount} 个冲突。`,
      });
    }

    // ---- 写回本地 ----
    await this.#state({ phase: '写入本地书签' });
    await this.#store.saveBackup('local', view.snapshot);
    if (remote.snapshot.entries.length > 0) await this.#store.saveBackup('remote', remote.snapshot);

    const applied = await applySnapshot(this.#adapter, result.entries, view, { renames });
    warnings.push(...applied.warnings);
    await this.#store.saveUidMap(applied.uidMap);

    // ---- 上传远端 ----
    const finalSnapshot = createSnapshot(result.entries, this.#device);
    let pushed = false;
    if (finalSnapshot.revision !== remote.revision) {
      await this.#state({ phase: '上传到 Gist' });
      await this.#remote.write(finalSnapshot);
      pushed = true;
    }

    await this.#store.saveBase(finalSnapshot);
    await this.#store.savePending(null);

    const outcome: SyncOutcome = {
      ok: true,
      mode: 'merge',
      needsConfirm: null,
      counts: applied.counts,
      pushed,
      conflictCount,
      warnings,
      error: null,
    };
    await this.#finish(outcome, {
      lastSyncedRevision: finalSnapshot.revision,
      remoteRevision: pushed ? finalSnapshot.revision : remote.revision,
      remoteDeviceName: pushed ? this.#device.deviceName : remote.snapshot.deviceName,
      remoteUpdatedAt: pushed ? finalSnapshot.generatedAt : remote.snapshot.generatedAt,
      entryCount: finalSnapshot.entries.length,
    });
    return outcome;
  }

  // -------------------------------------------------------------------------
  // 上传（用本地覆盖云端）
  // -------------------------------------------------------------------------

  async #push(
    force: boolean,
    options: { skipRecheck?: boolean } = {},
  ): Promise<SyncOutcome> {
    const warnings: MergeWarning[] = [];
    await this.#state({ status: 'syncing', phase: '读取本地书签', runningMode: 'push', lastError: null });
    const view = await this.readLocal();
    const base = await this.#store.loadBase();

    await this.#state({ phase: '检查云端' });
    const remote = await this.#remote.read();
    warnings.push(...remote.warnings);

    // 云端有我们还没合并过的新内容 → 先问用户，别把人家的改动冲掉
    if (!force && !options.skipRecheck) {
      const remoteHasNewer = remote.snapshot.entries.length > 0 && remote.revision !== (base?.revision ?? '');
      if (remoteHasNewer) {
        await this.#state({ status: 'idle', phase: null, runningMode: null, lastError: null });
        return {
          ok: true,
          mode: 'push',
          needsConfirm: 'overwrite-remote',
          counts: ZERO_COUNTS,
          pushed: false,
          conflictCount: 0,
          warnings,
          error: null,
        };
      }
    }

    const snapshot = createSnapshot(view.snapshot.entries, this.#device);
    if (remote.snapshot.entries.length > 0) await this.#store.saveBackup('remote', remote.snapshot);

    await this.#state({ phase: '上传到 Gist' });
    await this.#remote.write(snapshot);
    await this.#store.saveBase(snapshot);
    await this.#store.savePending(null);

    const counts = diffCounts(base?.entries ?? [], snapshot.entries);
    const outcome: SyncOutcome = {
      ok: true,
      mode: 'push',
      needsConfirm: null,
      counts,
      pushed: true,
      conflictCount: 0,
      warnings,
      error: null,
    };
    await this.#finish(outcome, {
      lastSyncedRevision: snapshot.revision,
      remoteRevision: snapshot.revision,
      remoteDeviceName: this.#device.deviceName,
      remoteUpdatedAt: snapshot.generatedAt,
      entryCount: snapshot.entries.length,
    });
    return outcome;
  }

  // -------------------------------------------------------------------------
  // 下载（用云端覆盖本地）
  // -------------------------------------------------------------------------

  async #pull(
    force: boolean,
    options: { skipRecheck?: boolean; alreadyRead?: { view: LocalView; remote: RemoteRead } } = {},
  ): Promise<SyncOutcome> {
    const warnings: MergeWarning[] = [];
    await this.#state({ status: 'syncing', phase: '读取本地书签', runningMode: 'pull', lastError: null });

    const view = options.alreadyRead?.view ?? (await this.readLocal());
    const base = await this.#store.loadBase();

    await this.#state({ phase: '读取云端数据' });
    const remote = options.alreadyRead?.remote ?? (await this.#remote.read());
    warnings.push(...remote.warnings);

    // 本地有还没同步上去的改动 → 覆盖会丢掉它们，先问用户
    if (!force && !options.skipRecheck) {
      const localChanged = base
        ? computeRevision(view.snapshot.entries) !== base.revision
        : view.snapshot.entries.length > 0;
      if (localChanged) {
        await this.#state({ status: 'idle', phase: null, runningMode: null, lastError: null });
        return {
          ok: true,
          mode: 'pull',
          needsConfirm: 'overwrite-local',
          counts: ZERO_COUNTS,
          pushed: false,
          conflictCount: 0,
          warnings,
          error: null,
        };
      }
    }

    // 首次下载时同样做一次配对，避免把本地书签全删掉再建一遍
    let renames: Map<string, string> | undefined;
    if (!base) {
      const { links } = reconcileFirstSync(view.snapshot.entries, remote.snapshot.entries);
      if (links.length > 0) renames = applyIdentityLinks(view.snapshot.entries, links).renames;
    }

    await this.#state({ phase: '写入本地书签' });
    if (view.snapshot.entries.length > 0) await this.#store.saveBackup('local', view.snapshot);

    const target = repairHierarchy(remote.snapshot.entries).entries;
    const applied = await applySnapshot(this.#adapter, target, view, { renames });
    warnings.push(...applied.warnings);
    await this.#store.saveUidMap(applied.uidMap);

    const snapshot = createSnapshot(target, this.#device);
    await this.#store.saveBase(snapshot);
    await this.#store.savePending(null);

    const outcome: SyncOutcome = {
      ok: true,
      mode: 'pull',
      needsConfirm: null,
      counts: applied.counts,
      pushed: false,
      conflictCount: 0,
      warnings,
      error: null,
    };
    await this.#finish(outcome, {
      lastSyncedRevision: snapshot.revision,
      remoteRevision: remote.revision,
      remoteDeviceName: remote.snapshot.deviceName,
      remoteUpdatedAt: remote.snapshot.generatedAt,
      entryCount: snapshot.entries.length,
    });
    return outcome;
  }

  // -------------------------------------------------------------------------
  // 冲突处理
  // -------------------------------------------------------------------------

  async resolveConflicts(resolutions: Record<string, Resolution>): Promise<SyncOutcome> {
    const pending = await this.#store.loadPending();
    if (!pending) throw new AppError('no-pending', '当前没有等待处理的冲突。');

    await this.#state({ status: 'syncing', phase: '应用你的选择', runningMode: 'merge', lastError: null });

    // 等待期间本地可能又被改过，那样基于旧状态的合并结果就会覆盖掉新改动，所以直接拒绝
    const view = await this.readLocal();
    if (computeRevision(view.snapshot.entries) !== computeRevision(pending.localSnapshot.entries)) {
      await this.#state({ status: 'conflict', phase: null, runningMode: null, conflictCount: pending.conflicts.length });
      throw new AppError(
        'local-changed',
        '本地书签在等待处理期间又变化了，为避免覆盖你的新改动，请重新同步一次再处理冲突。',
      );
    }

    const resolved = applyResolutions(pending.merged, pending.conflicts, resolutions);
    const warnings = [...pending.warnings, ...resolved.warnings];

    const applied = await applySnapshot(this.#adapter, resolved.entries, view);
    warnings.push(...applied.warnings);
    await this.#store.saveUidMap(applied.uidMap);

    const finalSnapshot = createSnapshot(resolved.entries, this.#device);
    let pushed = false;
    if (finalSnapshot.revision !== pending.remoteRevision) {
      await this.#state({ phase: '上传到 Gist' });
      await this.#remote.write(finalSnapshot);
      pushed = true;
    }

    await this.#store.saveBase(finalSnapshot);
    await this.#store.savePending(null);

    const outcome: SyncOutcome = {
      ok: true,
      mode: 'merge',
      needsConfirm: null,
      counts: applied.counts,
      pushed,
      conflictCount: 0,
      warnings,
      error: null,
    };
    await this.#finish(outcome, {
      lastSyncedRevision: finalSnapshot.revision,
      remoteRevision: pushed ? finalSnapshot.revision : pending.remoteRevision,
      entryCount: finalSnapshot.entries.length,
    });
    return outcome;
  }

  /** 放弃处理冲突：不动任何书签，下次同步会重新问你。 */
  async discardPending(): Promise<void> {
    await this.#store.savePending(null);
    await this.#state({ status: 'idle', phase: null, conflictCount: 0, runningMode: null });
  }

  async getPending(): Promise<PendingSync | null> {
    return this.#store.loadPending();
  }

  // -------------------------------------------------------------------------
  // 数据管理
  // -------------------------------------------------------------------------

  /** 导出当前本地书签为 JSON 文本。 */
  async exportSnapshot(): Promise<{ json: string; filename: string }> {
    const view = await this.readLocal();
    const snapshot = createSnapshot(view.snapshot.entries, this.#device);
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    return { json: serializeSnapshot(snapshot), filename: `cloudbookmark-${stamp}.json` };
  }

  /** 导入 JSON。replace = 用文件内容替换本地书签；merge = 与本地合并。 */
  async importSnapshot(json: string, mode: 'replace' | 'merge'): Promise<ChangeCounts> {
    const parsed = parseSnapshot(json, this.#device);
    const view = await this.readLocal();

    let target: Entry[];
    if (mode === 'replace') {
      target = repairHierarchy(parsed.snapshot.entries).entries;
    } else {
      const base = await this.#store.loadBase();
      target = threeWayMerge(base?.entries ?? [], view.snapshot.entries, parsed.snapshot.entries).entries;
    }

    await this.#store.saveBackup('local', view.snapshot);
    const applied = await applySnapshot(this.#adapter, target, view);
    await this.#store.saveUidMap(applied.uidMap);
    await this.#state({ entryCount: target.length, dirty: true });
    return applied.counts;
  }

  /** 回滚：把浏览器（local）或 Gist（remote）恢复到上次同步前。 */
  async rollback(which: 'local' | 'remote'): Promise<ChangeCounts> {
    const backup = await this.#store.loadBackup(which);
    if (!backup) {
      throw new AppError('no-backup', which === 'local' ? '还没有"覆盖前的本地备份"。' : '还没有"覆盖前的云端备份"。');
    }

    if (which === 'remote') {
      await this.#remote.write(backup);
      await this.#state({ remoteRevision: backup.revision, lastError: null });
      return ZERO_COUNTS;
    }

    const view = await this.readLocal();
    const applied = await applySnapshot(this.#adapter, repairHierarchy(backup.entries).entries, view);
    await this.#store.saveUidMap(applied.uidMap);
    await this.#state({ entryCount: backup.entries.length, dirty: true });
    return applied.counts;
  }

  async listDuplicates(): Promise<Array<{ url: string; title: string; uids: string[] }>> {
    const view = await this.readLocal();
    return findDuplicateUrls(view.snapshot.entries);
  }

  /** 删除指定的重复书签（界面上一般会保留每组第一条）。 */
  async removeDuplicates(uids: string[]): Promise<number> {
    if (uids.length === 0) return 0;
    const doomed = new Set(uids);
    const view = await this.readLocal();
    const target = view.snapshot.entries.filter((entry) => !doomed.has(entry.uid));
    await this.#store.saveBackup('local', view.snapshot);
    const applied = await applySnapshot(this.#adapter, repairHierarchy(target).entries, view);
    await this.#store.saveUidMap(applied.uidMap);
    await this.#state({ entryCount: target.length, dirty: true });
    return applied.counts.removed;
  }

  /** 本地当前有多少条（界面展示用）。 */
  async countLocal(): Promise<number> {
    const view = await this.readLocal();
    return view.snapshot.entries.length;
  }

  // -------------------------------------------------------------------------
  // 内部工具
  // -------------------------------------------------------------------------

  /**
   * 读本地书签并**立刻保存身份表**。
   * 新节点的 uid 是当场随机生成的，不保存的话下一次读又会换新的，
   * 合并结果就跟本地对不上了（这是最容易踩的坑之一）。
   */
  async readLocal(): Promise<LocalView> {
    const uidMap = await this.#store.loadUidMap();
    const nodes = await this.#adapter.readAll();
    const view = readLocalSnapshot(nodes, uidMap, this.#device);
    await this.#store.saveUidMap(uidMapFromView(view));
    return view;
  }

  async #state(patch: Partial<SyncState>): Promise<void> {
    await this.#hooks.onState?.(patch);
  }

  async #log(entry: SyncLogEntry): Promise<void> {
    await this.#hooks.onLog?.(entry);
  }

  async #finish(outcome: SyncOutcome, patch: Partial<SyncState>): Promise<void> {
    await this.#state({
      status: 'idle',
      phase: null,
      lastError: null,
      lastSyncAt: nowIso(),
      // 走到这里说明已经全部应用完成，没有"等待用户裁决"的冲突了
      conflictCount: 0,
      dirty: false,
      runningMode: null,
      ...patch,
    });
    await this.#log({
      id: newRecordId(),
      at: nowIso(),
      mode: outcome.mode,
      ok: outcome.ok,
      ...outcome.counts,
      pushed: outcome.pushed,
      conflictCount: outcome.conflictCount,
      error: outcome.error,
    });
  }
}

/** 给界面用的冲突摘要。 */
export { summarizeConflicts };
