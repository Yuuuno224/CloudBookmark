/**
 * "用 GitHub 账号授权"的编排逻辑
 * ==============================
 *
 * 把底层的设备授权流程（device-flow.ts）和本扩展的存储、状态接起来。
 *
 * ## 为什么不做成"后台一个循环一直轮询"
 *
 * 因为后台 Service Worker 随时会被浏览器回收。一个跑十几分钟的 `while`
 * 循环被回收就前功尽弃，用户还得重来。
 *
 * 所以拆成两个动作：
 *
 *   - `startDeviceAuth()`  申请设备码，把状态存进 chrome.storage
 *   - `checkDeviceAuth()`  **只问一次**"用户同意了没"
 *
 * 界面每隔几秒调一次 `checkDeviceAuth()`。这样即使后台被回收，
 * 状态还在存储里，下一次调用接着问就行，完全不怕中断。
 */

import { AppError, type AuthMethod, type OAuthTokenMeta, type PendingDeviceAuth } from '@/core/types';
import { kvStore } from '@/platform/kv';
import { ensureDeviceId } from '@/features/settings';
import { saveToken } from '@/features/token';
import { GistClient } from '@/features/gist/client';
import {
  createFetchTransport,
  pollDeviceTokenOnce,
  requestDeviceCode,
  SLOW_DOWN_STEP_SECONDS,
  type DeviceFlowTransport,
} from './device-flow';

/** 授权时申请的权限：只要 gist，和填 Token 的方式完全一致。 */
const OAUTH_SCOPE = 'gist';

export interface DeviceAuthStart {
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string | null;
  interval: number;
  expiresAt: number;
  /** 还剩多少秒。 */
  remaining: number;
}

export type DeviceAuthStatus =
  | { status: 'pending'; remaining: number }
  | { status: 'slow_down'; remaining: number; interval: number }
  /** expiring 为真表示这个 App 开了"令牌过期"，用户需要知道会频繁掉线。 */
  | { status: 'done'; login: string | null; expiring: boolean }
  | { status: 'expired' }
  | { status: 'denied' }
  | { status: 'idle' }
  | { status: 'error'; message: string };

/** 允许注入传输层，方便测试。生产环境用 fetch。 */
let transport: DeviceFlowTransport = createFetchTransport();

/** 仅测试使用：替换掉网络层。 */
export function __setTransportForTests(next: DeviceFlowTransport | null): void {
  transport = next ?? createFetchTransport();
}

async function loadPending(): Promise<PendingDeviceAuth | null> {
  return (await kvStore.get('oauthPending')) ?? null;
}

async function savePending(pending: PendingDeviceAuth | null): Promise<void> {
  await kvStore.set('oauthPending', pending);
}

/**
 * 第一步：申请设备码，把短码交给界面显示。
 *
 * @param clientId OAuth App 的 client_id（公开信息，不是密钥）
 */
export async function startDeviceAuth(clientId: string): Promise<DeviceAuthStart> {
  const trimmed = clientId.trim();
  if (!trimmed) {
    throw new AppError(
      'client-id-missing',
      '还没有填写 OAuth App 的 client_id。可以在下面按步骤免费创建一个，或者改用「填 Token」的方式。',
    );
  }

  const info = await requestDeviceCode(trimmed, OAUTH_SCOPE, transport);
  const expiresAt = Date.now() + info.expiresIn * 1000;

  const pending: PendingDeviceAuth = {
    clientId: trimmed,
    deviceCode: info.deviceCode,
    userCode: info.userCode,
    verificationUri: info.verificationUri,
    verificationUriComplete: info.verificationUriComplete,
    interval: info.interval,
    expiresAt,
    startedAt: new Date().toISOString(),
  };
  await savePending(pending);

  return {
    userCode: pending.userCode,
    verificationUri: pending.verificationUri,
    verificationUriComplete: pending.verificationUriComplete,
    interval: pending.interval,
    expiresAt,
    remaining: Math.max(0, Math.round((expiresAt - Date.now()) / 1000)),
  };
}

/**
 * 第二步：问一次"授权好了没"。
 * 界面每隔 interval 秒调一次即可。
 */
export async function checkDeviceAuth(): Promise<DeviceAuthStatus> {
  const pending = await loadPending();
  if (!pending) return { status: 'idle' };

  const remaining = Math.round((pending.expiresAt - Date.now()) / 1000);
  if (remaining <= 0) {
    await savePending(null);
    return { status: 'expired' };
  }

  let result;
  try {
    result = await pollDeviceTokenOnce(pending.clientId, pending.deviceCode, transport);
  } catch (error) {
    // 网络抖动：保留状态，让界面下次接着问
    return {
      status: 'error',
      message: error instanceof Error ? error.message : '网络请求失败，请稍后重试。',
    };
  }

  switch (result.status) {
    case 'pending':
      return { status: 'pending', remaining };

    case 'slow_down': {
      // GitHub 要求放慢：优先听它给的 interval，没给就加 5 秒（RFC 8628 的规定）
      const next = {
        ...pending,
        interval: result.interval ?? pending.interval + SLOW_DOWN_STEP_SECONDS,
      };
      await savePending(next);
      return { status: 'slow_down', remaining, interval: next.interval };
    }

    case 'expired':
      await savePending(null);
      return { status: 'expired' };

    case 'denied':
      await savePending(null);
      return { status: 'denied' };

    case 'error':
      await savePending(null);
      return { status: 'error', message: result.message };

    case 'done': {
      // 成功：把拿到的 access_token 当普通 Token 一样加密存起来
      const deviceId = await ensureDeviceId();
      await saveToken(result.token, deviceId);
      await kvStore.set('gistId', null); // 可能换了账号，重新找/建 Gist

      // 默认不会有；只有 App 开了"令牌过期"才带上 refresh_token / expires_in
      const meta: OAuthTokenMeta = {
        clientId: pending.clientId,
        refreshToken: result.refreshToken,
        expiresAt:
          result.expiresIn !== null && result.expiresIn > 0
            ? Date.now() + result.expiresIn * 1000
            : null,
      };
      await kvStore.set('oauthTokenMeta', meta);

      // 顺手问一下用户名，界面上显示用
      let login: string | null = null;
      try {
        const check = await new GistClient(result.token).checkToken();
        login = check.login;
      } catch {
        /* 拿不到用户名不影响使用 */
      }

      await kvStore.set('accountLogin', login);
      await kvStore.set('authMethod', 'oauth' satisfies AuthMethod);
      await savePending(null);
      return { status: 'done', login, expiring: meta.expiresAt !== null };
    }
  }
}

/** 用户点了"取消"。 */
export async function cancelDeviceAuth(): Promise<void> {
  await savePending(null);
}

/** 界面刷新时用它恢复"上次没做完的授权"。 */
export async function getDeviceAuthStart(): Promise<DeviceAuthStart | null> {
  const pending = await loadPending();
  if (!pending) return null;
  const remaining = Math.round((pending.expiresAt - Date.now()) / 1000);
  if (remaining <= 0) {
    await savePending(null);
    return null;
  }
  return {
    userCode: pending.userCode,
    verificationUri: pending.verificationUri,
    verificationUriComplete: pending.verificationUriComplete,
    interval: pending.interval,
    expiresAt: pending.expiresAt,
    remaining,
  };
}
