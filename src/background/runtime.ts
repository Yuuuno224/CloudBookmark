/**
 * 后台运行时：把各个零件拼成可用的对象
 * =====================================
 *
 * 这里做两件事：
 *  1. 组装 SyncService（注入真实实现：chrome 书签适配器、Gist 远端、IndexedDB 存档）
 *  2. 缓存这个组装结果
 *
 * 为什么要缓存？因为 SyncService 内部有一个"同一时间只允许一个同步"的锁。
 * 如果每次请求都新建一个 service，锁就形同虚设，用户连点两下按钮
 * 就可能同时跑两个同步，把数据搅乱。
 */

import { GistClient } from '@/features/gist/client';
import { GistRemoteStore } from '@/features/gist/remote-store';
import {
  defaultDeviceName,
  ensureDeviceId,
  readSettings,
  writeSettings,
} from '@/features/settings';
import { getToken } from '@/features/token';
import { SyncService } from '@/features/sync/service';
import { addSyncLog, patchSyncState, readSyncState, syncStore } from '@/features/sync/store';
import { createChromeBookmarkAdapter } from '@/platform/bookmarks';
import { kvStore } from '@/platform/kv';
import { AppError, type DeviceInfo, type Settings } from '@/core/types';

export interface Runtime {
  service: SyncService;
  client: GistClient;
  remote: GistRemoteStore;
  device: DeviceInfo;
  settings: Settings;
}

let cached: { token: string; deviceName: string; runtime: Runtime } | null = null;

/** Token 或设备名变了就重建（否则复用，保住同步锁）。 */
export function invalidateRuntime(): void {
  cached = null;
}

export async function getDevice(): Promise<DeviceInfo> {
  const deviceId = await ensureDeviceId();
  const settings = await readSettings();
  return {
    deviceId,
    deviceName: settings.deviceName.trim() || defaultDeviceName(),
  };
}

export async function getRuntime(): Promise<Runtime> {
  const deviceId = await ensureDeviceId();
  const token = await getToken(deviceId);
  if (!token) {
    throw new AppError('no-token', '还没有配置 GitHub Token，请先到设置页填写并验证。');
  }

  const settings = await readSettings();
  const device = await getDevice();

  if (cached && cached.token === token && cached.deviceName === device.deviceName) {
    return cached.runtime;
  }

  const client = new GistClient(token);
  const remote = new GistRemoteStore({
    client,
    device,
    gistIds: {
      get: async () => (await kvStore.get('gistId')) ?? null,
      set: (value) => kvStore.set('gistId', value),
    },
    onGistChange: (gistId, gistUrl) => {
      void patchSyncState({ gistId, gistUrl });
    },
  });

  const service = new SyncService({
    adapter: createChromeBookmarkAdapter(),
    remote,
    store: syncStore,
    device,
    settings: readSettings,
    hooks: {
      onState: patchSyncState,
      onLog: addSyncLog,
    },
  });

  const runtime: Runtime = { service, client, remote, device, settings };
  cached = { token, deviceName: device.deviceName, runtime };
  return runtime;
}

/** 保存 Token 之后重建运行时（Token 变了，远端客户端也得换）。 */
export async function onSettingsChanged(next: Settings): Promise<void> {
  if (cached && cached.deviceName !== (next.deviceName.trim() || defaultDeviceName())) {
    invalidateRuntime();
  }
  if (cached) cached.runtime.settings = next;
}

/**
 * "只动本地、不碰云端"的服务实例。
 *
 * 导出 / 导入 / 清理重复 / 回滚本地 / 看统计这些功能完全不需要联网，
 * 用不到 Token，所以给它们一个远端网关会直接报错的实例，
 * 免得用户"没配 Token 就连书签条数都看不到"。
 */
const localOnlyRemote = {
  ensure: async () => {
    throw new AppError('no-token', '这个操作需要先配置 GitHub Token。');
  },
  read: async () => {
    throw new AppError('no-token', '这个操作需要先配置 GitHub Token。');
  },
  write: async () => {
    throw new AppError('no-token', '这个操作需要先配置 GitHub Token。');
  },
  forget: async () => undefined,
};

let localService: SyncService | null = null;

export async function getLocalService(): Promise<SyncService> {
  if (localService) return localService;
  const device = await getDevice();
  localService = new SyncService({
    adapter: createChromeBookmarkAdapter(),
    remote: localOnlyRemote,
    store: syncStore,
    device,
    settings: readSettings,
    hooks: { onState: patchSyncState, onLog: addSyncLog },
  });
  return localService;
}

export { readSyncState, writeSettings };
