/**
 * 自动同步调度
 * ============
 *
 * 三种触发方式，各管一段：
 *
 *  1. **定时闹钟**（chrome.alarms）：MV3 里不能用 setInterval，
 *     Service Worker 随时会被回收，只有 alarms 能可靠地定时唤醒。
 *  2. **变更后同步**：你改了书签 → 记一笔"脏了" → 3 秒后没新动作就同步。
 *     用 setTimeout 做防抖（alarms 在 Chrome 120+ 有 30 秒最小间隔，太粗）。
 *  3. **兜底检查**：同时建一个 1 分钟后的闹钟。万一防抖还没触发 SW 就被杀了，
 *     下次醒来看到"脏了"会补上这次同步。
 */

import { AppError, type SyncMode, type SyncOutcome } from '@/core/types';
import { changeTracker } from '@/features/history/change-tracker';
import {
  AUTO_SYNC_ALARM,
  DEBOUNCE_SYNC_ALARM,
  ensureDeviceId,
  readSettings,
} from '@/features/settings';
import { hasToken } from '@/features/token';
import { patchSyncState, readSyncState } from '@/features/sync/store';
import { refreshBadge } from './badge';
import { getRuntime } from './runtime';

/** 防抖：最后一次改动之后等这么久才同步。 */
const DEBOUNCE_MS = 3000;
/** 两次自动同步之间至少间隔这么久，避免疯狂刷 GitHub 接口。 */
const MIN_AUTO_INTERVAL_MS = 20_000;

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let lastAutoAttempt = 0;

/** 重新读取状态并刷新图标徽章。 */
export async function refreshStateAndBadge(): Promise<void> {
  await refreshBadge(await readSyncState());
}

/**
 * 执行一次同步。所有入口（手动、定时、变更）都走这里，
 * 保证同一时间只有一个同步在跑，并且自己写入书签时不会污染变更记录。
 */
export async function runSync(mode: SyncMode, force: boolean, source: string): Promise<SyncOutcome> {
  const state = await readSyncState();
  if (state.runningMode) {
    throw new AppError('busy', '正在同步中，请稍候再试。');
  }

  const runtime = await getRuntime();
  changeTracker.setLimit(runtime.settings.changeLogLimit);
  changeTracker.suppressFor(6000);

  try {
    return await runtime.service.run(mode, force);
  } finally {
    // 事件是异步派发的，同步结束后再延长一次静默窗口，避免尾巴被记成"你改的"
    changeTracker.suppressFor(6000);
    await refreshStateAndBadge();
    void source;
  }
}

/** 重新设置定时闹钟（设置页改完间隔后调用）。 */
export async function applyAlarmSettings(): Promise<void> {
  const settings = await readSettings();
  await chrome.alarms.clear(AUTO_SYNC_ALARM);
  if (settings.autoSyncEnabled) {
    await chrome.alarms.create(AUTO_SYNC_ALARM, {
      periodInMinutes: settings.autoSyncIntervalMinutes,
      delayInMinutes: Math.min(settings.autoSyncIntervalMinutes, 1),
    });
  }
}

/** 书签发生变化时调用：标记"脏了"并安排一次自动同步。 */
export async function onBookmarkChanged(): Promise<void> {
  const settings = await readSettings();
  changeTracker.setLimit(settings.changeLogLimit);
  await patchSyncState({ dirty: true });

  if (!settings.autoUploadOnChange) return;

  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    void autoSync('书签变化');
  }, DEBOUNCE_MS);

  // 兜底：万一 Service Worker 在防抖期间被回收，这个闹钟会把它叫醒
  await chrome.alarms.create(DEBOUNCE_SYNC_ALARM, { when: Date.now() + 60_000 });
}

/** 自动同步（不打扰用户：出错只写日志，不弹提示）。 */
async function autoSync(source: string): Promise<void> {
  const state = await readSyncState();
  if (state.runningMode) return;
  if (state.status === 'conflict') return; // 有冲突等用户处理，别反复问
  if (state.status === 'unconfigured') return;
  if (!state.dirty) return;
  if (Date.now() - lastAutoAttempt < MIN_AUTO_INTERVAL_MS) return;

  lastAutoAttempt = Date.now();
  try {
    await runSync('merge', false, source);
  } catch (error) {
    console.warn(`[CloudBookmark] 自动同步（${source}）失败：`, error);
  }
}

/** 注册闹钟监听。必须在 Service Worker 顶层同步调用。 */
export function registerScheduler(): void {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === AUTO_SYNC_ALARM) void autoSync('定时同步');
    else if (alarm.name === DEBOUNCE_SYNC_ALARM) void autoSync('变更兜底');
  });
}

/** 扩展启动 / 安装 / 更新后要做的事。 */
export async function bootstrap(reason: string): Promise<void> {
  await applyAlarmSettings();

  const settings = await readSettings();
  const state = await readSyncState();

  // 装过扩展、也存过 Token，但状态还是"未配置"（例如上次没走到设置那一步）
  if (state.status === 'unconfigured') {
    const deviceId = await ensureDeviceId();
    if (await hasToken(deviceId)) {
      await patchSyncState({ status: 'idle' });
    }
  }

  await refreshStateAndBadge();

  const current = await readSyncState();
  if (current.status === 'unconfigured') return;
  // 上次没同步完就休眠了 → 醒来补一次
  if (current.dirty && settings.autoUploadOnChange) {
    void autoSync(`启动补同步(${reason})`);
  }
}
