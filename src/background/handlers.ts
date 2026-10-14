/**
 * 消息路由
 * ========
 *
 * 界面发过来的每一个请求都在这里被分派。把这个文件当成"后台的 API 文档"看：
 * 想知道某个按钮会做什么，从这里的 case 找过去就行。
 */

import { AppError, type Resolution, type SyncState } from '@/core/types';
import { BLOB, blobStore, changeLogStore, snapshotStore, syncLogStore, uidMapStore } from '@/platform/blob-store';
import { kvStore } from '@/platform/kv';
import type { DataStats, EnvInfo, Request } from '@/platform/messaging';
import { changeTracker } from '@/features/history/change-tracker';
import {
  defaultDeviceName,
  defaultSyncState,
  detectBrowser,
  ensureDeviceId,
  readSettings,
  writeSettings,
} from '@/features/settings';
import { getToken, removeToken, saveToken } from '@/features/token';
import { cancelDeviceAuth, checkDeviceAuth, getDeviceAuthStart, startDeviceAuth } from '@/features/auth/oauth';
import { GistClient } from '@/features/gist/client';
import { patchSyncState } from '@/features/sync/store';
import { applyAlarmSettings, refreshStateAndBadge, runSync } from './scheduler';
import { getLocalService, getRuntime, invalidateRuntime } from './runtime';

/**
 * 自己写入书签时不要让变更记录被刷屏。
 * 包住所有会改动本地书签的操作。
 */
async function withoutChangeNoise<T>(task: () => Promise<T>): Promise<T> {
  changeTracker.suppressFor(6000);
  try {
    return await task();
  } finally {
    changeTracker.suppressFor(6000);
  }
}

export async function handleRequest(request: Request): Promise<unknown> {
  switch (request.type) {
    // ---------------------------------------------------------------- 环境
    case 'env:info':
      return envInfo();

    case 'settings:set': {
      const before = await readSettings();
      const next = await writeSettings(request.patch);
      changeTracker.setLimit(next.changeLogLimit);

      // 只有真正相关的设置变了才做副作用，避免"改个主题"也去重建运行时、
      // 打断正在进行的同步
      if (
        before.autoSyncEnabled !== next.autoSyncEnabled ||
        before.autoSyncIntervalMinutes !== next.autoSyncIntervalMinutes
      ) {
        await applyAlarmSettings();
      }
      if (before.deviceName !== next.deviceName) invalidateRuntime();
      return next;
    }

    // --------------------------------------------------------------- Token
    case 'token:save': {
      const deviceId = await ensureDeviceId();
      const client = new GistClient(request.token.trim());
      const check = await client.checkToken();
      if (!check.valid) {
        throw new AppError('token-invalid', 'Token 无效或已被撤销，请确认复制完整、没有过期。');
      }
      if (!check.hasGistScope) {
        throw new AppError(
          'token-scope',
          '这个 Token 没有 gist 权限。请重新生成并勾选 gist（细粒度 Token 则是 Gists: Read and write）。',
        );
      }
      await saveToken(request.token, deviceId);
      await kvStore.set('accountLogin', check.login);
      await kvStore.set('authMethod', 'pat');
      await kvStore.set('oauthPending', null); // 已经用别的方式配好了，丢掉未完成的授权
      await kvStore.set('oauthTokenMeta', null);
      await kvStore.set('gistId', null); // 可能换了账号，重新找/建 Gist
      invalidateRuntime();
      await patchSyncState({ status: 'idle', lastError: null });
      await refreshStateAndBadge();
      return { login: check.login ?? '' };
    }

    case 'token:remove': {
      await removeToken();
      await kvStore.set('accountLogin', null);
      await kvStore.set('authMethod', null);
      await kvStore.set('oauthPending', null);
      await kvStore.set('oauthTokenMeta', null);
      invalidateRuntime();
      await patchSyncState({ status: 'unconfigured', lastError: null, conflictCount: 0, runningMode: null });
      await refreshStateAndBadge();
      return null;
    }

    // ------------------------------------------------- 用 GitHub 账号授权
    case 'auth:device-start': {
      // 界面上可以顺手把 client_id 传过来一起存了，省一次请求
      if (typeof request.clientId === 'string') {
        await writeSettings({ oauthClientId: request.clientId.trim() });
      }
      const settings = await readSettings();
      return startDeviceAuth(settings.oauthClientId);
    }

    case 'auth:device-status':
      return getDeviceAuthStart();

    case 'auth:device-check': {
      const result = await checkDeviceAuth();
      if (result.status === 'done') {
        invalidateRuntime();
        await patchSyncState({ status: 'idle', lastError: null });
        await refreshStateAndBadge();
      }
      return result;
    }

    case 'auth:device-cancel':
      await cancelDeviceAuth();
      return null;

    // --------------------------------------------------------------- 同步
    case 'sync:run':
      return runSync(request.mode, request.force ?? false, '手动');

    case 'conflict:list': {
      const service = await getLocalService();
      const pending = await service.getPending();
      return pending?.conflicts ?? [];
    }

    case 'conflict:resolve': {
      const runtime = await getRuntime();
      changeTracker.suppressFor(6000);
      try {
        return await runtime.service.resolveConflicts(request.resolutions as Record<string, Resolution>);
      } finally {
        changeTracker.suppressFor(6000);
        await refreshStateAndBadge();
      }
    }

    case 'conflict:discard': {
      const service = await getLocalService();
      await service.discardPending();
      await refreshStateAndBadge();
      return null;
    }

    // --------------------------------------------------------------- 历史
    case 'history:list':
      return syncLogStore.recent(request.limit ?? 50);

    case 'history:clear':
      await syncLogStore.clear();
      return null;

    case 'changes:list':
      return changeLogStore.recent(request.limit ?? 200);

    case 'changes:clear':
      await changeLogStore.clear();
      return null;

    // --------------------------------------------------------------- 数据
    case 'data:stats':
      return dataStats();

    case 'data:export': {
      const service = await getLocalService();
      return service.exportSnapshot();
    }

    case 'data:import': {
      const service = await getLocalService();
      return withoutChangeNoise(() => service.importSnapshot(request.json, request.mode));
    }

    case 'data:rollback': {
      const service = await getLocalService();
      const counts = await withoutChangeNoise(() => service.rollback(request.which));
      return { restored: true, counts };
    }

    case 'data:duplicates': {
      const service = await getLocalService();
      return service.listDuplicates();
    }

    case 'data:removeDuplicates': {
      const service = await getLocalService();
      const removed = await withoutChangeNoise(() => service.removeDuplicates(request.uids));
      return { removed };
    }

    case 'data:reset': {
      // 清掉本地缓存（快照、身份表、备份、历史），保留设置和 Token
      await Promise.all([
        blobStore.del(BLOB.base),
        blobStore.del(BLOB.backupLocal),
        blobStore.del(BLOB.backupRemote),
        blobStore.del(BLOB.pending),
        uidMapStore.clear(),
        changeLogStore.clear(),
        syncLogStore.clear(),
      ]);
      const gistId = (await kvStore.get('gistId')) ?? null;
      const syncState: SyncState = { ...defaultSyncState(), status: 'idle', gistId };
      await kvStore.set('syncState', syncState);
      invalidateRuntime();
      return null;
    }

    case 'gist:forget': {
      await kvStore.set('gistId', null);
      invalidateRuntime();
      await patchSyncState({ gistId: null, gistUrl: null });
      return null;
    }

    default: {
      const exhaustive: never = request;
      throw new AppError('unknown-request', `不认识的消息类型：${JSON.stringify(exhaustive)}`);
    }
  }
}

// ---------------------------------------------------------------------------

async function dataStats(): Promise<DataStats> {
  const service = await getLocalService();
  const entries = (await service.readLocal()).snapshot.entries;
  const [duplicates, baseAt, localAt, remoteAt, localBackup, remoteBackup, changeCount] = await Promise.all([
    service.listDuplicates(),
    blobStore.savedAt(BLOB.base),
    blobStore.savedAt(BLOB.backupLocal),
    blobStore.savedAt(BLOB.backupRemote),
    snapshotStore.getBackup('local'),
    snapshotStore.getBackup('remote'),
    changeLogStore.count(),
  ]);

  return {
    entryCount: entries.length,
    baseSavedAt: baseAt,
    backupLocalSavedAt: localAt,
    backupRemoteSavedAt: remoteAt,
    backupLocalCount: localBackup?.entries.length ?? 0,
    backupRemoteCount: remoteBackup?.entries.length ?? 0,
    changeLogCount: changeCount,
    duplicateGroups: duplicates.length,
  };
}

async function envInfo(): Promise<EnvInfo> {
  const deviceId = await ensureDeviceId();
  const [token, settings, accountLogin, authMethod, oauthTokenMeta] = await Promise.all([
    getToken(deviceId),
    readSettings(),
    kvStore.get('accountLogin'),
    kvStore.get('authMethod'),
    kvStore.get('oauthTokenMeta'),
  ]);
  return {
    deviceId,
    deviceName: settings.deviceName.trim() || defaultDeviceName(),
    browser: detectBrowser(),
    version: chrome.runtime.getManifest().version,
    hasToken: token !== null,
    login: accountLogin ?? null,
    authMethod: authMethod ?? null,
    tokenExpiresAt: oauthTokenMeta?.expiresAt ?? null,
    oauthClientId: settings.oauthClientId,
  };
}
