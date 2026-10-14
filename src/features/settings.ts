/**
 * 设置
 * ====
 *
 * 设置存在 chrome.storage.local 里，界面通过 chrome.storage.onChanged
 * 就能自动刷新，不需要额外的通知机制。
 */

import { newRecordId } from '@/core/ids';
import type { Settings, SyncState } from '@/core/types';
import { kvStore } from '@/platform/kv';

export const DEFAULT_SETTINGS: Settings = {
  /** 空字符串 = 用自动探测出来的名字。 */
  deviceName: '',
  /** 默认跟随系统的深浅色。 */
  theme: 'system',
  autoSyncEnabled: true,
  autoSyncIntervalMinutes: 15,
  autoUploadOnChange: true,
  /** 默认"有冲突就问我"，最不容易误删数据。 */
  conflictPolicy: 'ask',
  /** 默认按 URL 配对后合并，避免新设备首次同步把书签变两份。 */
  firstSyncStrategy: 'merge',
  changeLogLimit: 2000,
  /** 留空表示还没配置 OAuth；填写后设置页才会出现"用 GitHub 授权"按钮。 */
  oauthClientId: '',
};

export const AUTO_SYNC_ALARM = 'cloudbookmark-auto-sync';
export const DEBOUNCE_SYNC_ALARM = 'cloudbookmark-debounced-sync';

export const SYNC_INTERVAL_CHOICES = [5, 15, 30, 60, 180] as const;

export function defaultSyncState(): SyncState {
  return {
    status: 'unconfigured',
    phase: null,
    lastSyncAt: null,
    lastError: null,
    lastSyncedRevision: null,
    remoteRevision: null,
    remoteDeviceName: null,
    remoteUpdatedAt: null,
    conflictCount: 0,
    dirty: false,
    gistId: null,
    gistUrl: null,
    entryCount: 0,
    runningMode: null,
  };
}

/** 补齐缺失字段，兼容以后新增设置项时旧数据不会缺字段。 */
export function normalizeSettings(raw: Partial<Settings> | undefined): Settings {
  const merged = { ...DEFAULT_SETTINGS, ...(raw ?? {}) };
  // 数值兜底，防止用户手改成奇怪的值
  const interval = Number(merged.autoSyncIntervalMinutes);
  merged.autoSyncIntervalMinutes = Number.isFinite(interval) && interval >= 1 ? Math.min(interval, 24 * 60) : DEFAULT_SETTINGS.autoSyncIntervalMinutes;
  const limit = Number(merged.changeLogLimit);
  merged.changeLogLimit = Number.isFinite(limit) && limit >= 100 ? Math.min(limit, 20000) : DEFAULT_SETTINGS.changeLogLimit;
  // 枚举值兜底
  if (merged.theme !== 'system' && merged.theme !== 'light' && merged.theme !== 'dark') {
    merged.theme = DEFAULT_SETTINGS.theme;
  }
  if (
    merged.conflictPolicy !== 'ask' &&
    merged.conflictPolicy !== 'prefer-local' &&
    merged.conflictPolicy !== 'prefer-remote'
  ) {
    merged.conflictPolicy = DEFAULT_SETTINGS.conflictPolicy;
  }
  if (
    merged.firstSyncStrategy !== 'merge' &&
    merged.firstSyncStrategy !== 'local-wins' &&
    merged.firstSyncStrategy !== 'remote-wins'
  ) {
    merged.firstSyncStrategy = DEFAULT_SETTINGS.firstSyncStrategy;
  }
  merged.oauthClientId = typeof merged.oauthClientId === 'string' ? merged.oauthClientId.trim() : '';
  return merged;
}

export async function readSettings(): Promise<Settings> {
  return normalizeSettings(await kvStore.get('settings'));
}

export async function writeSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = normalizeSettings({ ...(await readSettings()), ...patch });
  await kvStore.set('settings', next);
  return next;
}

/** 当前实际显示的设备名（设置里留空时用自动探测的）。 */
export async function resolveDeviceName(): Promise<string> {
  const settings = await readSettings();
  return settings.deviceName.trim() || defaultDeviceName();
}

// ---------------------------------------------------------------------------
// 设备识别
// ---------------------------------------------------------------------------

export function detectBrowser(): string {
  const ua = navigator.userAgent;
  if (ua.includes('Edg/')) return 'Edge';
  if (ua.includes('OPR/') || ua.includes('Opera')) return 'Opera';
  if (ua.includes('Firefox/')) return 'Firefox';
  if (ua.includes('Chrome/')) return 'Chrome';
  return '浏览器';
}

export function detectOs(): string {
  const ua = navigator.userAgent;
  if (ua.includes('Windows')) return 'Windows';
  if (ua.includes('Android')) return 'Android';
  if (ua.includes('iPhone') || ua.includes('iPad')) return 'iOS';
  if (ua.includes('Mac OS X') || ua.includes('Macintosh')) return 'macOS';
  if (ua.includes('CrOS')) return 'ChromeOS';
  if (ua.includes('Linux')) return 'Linux';
  return '';
}

export function defaultDeviceName(): string {
  const os = detectOs();
  return os ? `${detectBrowser()} on ${os}` : detectBrowser();
}

/** 设备 id：只生成一次，之后一直用（Token 加密也需要它）。 */
export async function ensureDeviceId(): Promise<string> {
  const existing = await kvStore.get('deviceId');
  if (existing) return existing;
  const id = `dev-${newRecordId()}`;
  await kvStore.set('deviceId', id);
  return id;
}
