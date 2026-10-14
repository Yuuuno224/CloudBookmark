/**
 * 界面 <-> 后台的消息协议
 * ========================
 *
 * 浏览器扩展的"弹窗页面"和"后台 Service Worker"是两个独立的运行环境，
 * 只能通过 chrome.runtime.sendMessage 传消息。为了避免"发出去的消息
 * 和收到的回复对不上"这种经典 bug，这里把请求和回复都写成了 TypeScript
 * 类型，界面调用 sendRequest() 就能拿到正确推导的类型。
 *
 * 约定：
 *  - 请求  = { type: 'xxx', ...参数 }
 *  - 回复  = { ok: true, data } 或 { ok: false, error, code }
 *  - 出错时 sendRequest 会直接 throw，界面用 try/catch 就行
 */

import { AppError } from '@/core/types';
import type {
  AuthMethod,
  ChangeRecord,
  Conflict,
  Resolution,
  Settings,
  SyncLogEntry,
  SyncMode,
  SyncOutcome,
} from '@/core/types';
import type { DeviceAuthStart, DeviceAuthStatus } from '@/features/auth/oauth';

export interface EnvInfo {
  deviceId: string;
  deviceName: string;
  browser: string;
  version: string;
  hasToken: boolean;
  login: string | null;
  authMethod: AuthMethod | null;
  /** access token 的过期时间（毫秒时间戳）；永不过期时为 null。 */
  tokenExpiresAt: number | null;
  /** 已保存的 OAuth App client_id（公开信息，用于回填输入框）。 */
  oauthClientId: string;
}

export interface DataStats {
  entryCount: number;
  baseSavedAt: string | null;
  backupLocalSavedAt: string | null;
  backupRemoteSavedAt: string | null;
  backupLocalCount: number;
  backupRemoteCount: number;
  changeLogCount: number;
  duplicateGroups: number;
}

export interface DuplicateGroup {
  url: string;
  title: string;
  uids: string[];
}

export interface ImportResult {
  added: number;
  updated: number;
  removed: number;
  moved: number;
}

export type Request =
  | { type: 'env:info' }
  | { type: 'settings:set'; patch: Partial<Settings> }
  | { type: 'token:save'; token: string }
  | { type: 'token:remove' }
  /** 开始"用 GitHub 账号授权"：可选地顺手保存 client_id。 */
  | { type: 'auth:device-start'; clientId?: string }
  /** 恢复"上次没做完的授权"（界面刷新后用）。 */
  | { type: 'auth:device-status' }
  /** 问一次"授权好了没"。界面按 interval 秒调用。 */
  | { type: 'auth:device-check' }
  | { type: 'auth:device-cancel' }
  | { type: 'sync:run'; mode: SyncMode; force?: boolean }
  | { type: 'conflict:list' }
  | { type: 'conflict:resolve'; resolutions: Record<string, Resolution> }
  | { type: 'conflict:discard' }
  | { type: 'history:list'; limit?: number }
  | { type: 'history:clear' }
  | { type: 'changes:list'; limit?: number }
  | { type: 'changes:clear' }
  | { type: 'data:stats' }
  | { type: 'data:export' }
  | { type: 'data:import'; json: string; mode: 'replace' | 'merge' }
  | { type: 'data:rollback'; which: 'local' | 'remote' }
  | { type: 'data:duplicates' }
  | { type: 'data:removeDuplicates'; uids: string[] }
  | { type: 'data:reset' }
  | { type: 'gist:forget' };

export interface ResponseMap {
  'env:info': EnvInfo;
  'settings:set': Settings;
  'token:save': { login: string };
  'token:remove': null;
  'auth:device-start': DeviceAuthStart;
  'auth:device-status': DeviceAuthStart | null;
  'auth:device-check': DeviceAuthStatus;
  'auth:device-cancel': null;
  'sync:run': SyncOutcome;
  'conflict:list': Conflict[];
  'conflict:resolve': SyncOutcome;
  'conflict:discard': null;
  'history:list': SyncLogEntry[];
  'history:clear': null;
  'changes:list': ChangeRecord[];
  'changes:clear': null;
  'data:stats': DataStats;
  'data:export': { json: string; filename: string };
  'data:import': ImportResult;
  'data:rollback': { restored: boolean; counts: ImportResult };
  'data:duplicates': DuplicateGroup[];
  'data:removeDuplicates': { removed: number };
  'data:reset': null;
  'gist:forget': null;
}

export type RequestType = keyof ResponseMap;
export type RequestOf<T extends RequestType> = Extract<Request, { type: T }>;
export type ResponseOf<T extends RequestType> = ResponseMap[T];

type Envelope<T> = { ok: true; data: T } | { ok: false; error: string; code?: string };

/** 界面侧：发一个请求并拿到数据；失败会 throw AppError。 */
export async function sendRequest<T extends RequestType>(
  request: RequestOf<T>,
): Promise<ResponseOf<T>> {
  let response: Envelope<ResponseOf<T>> | undefined;
  try {
    response = (await chrome.runtime.sendMessage(request)) as Envelope<ResponseOf<T>> | undefined;
  } catch (error) {
    throw new AppError(
      'background-unreachable',
      '连接不到后台脚本。如果是刚重新加载过扩展，请稍后再试一次。',
      error instanceof Error ? error.message : undefined,
    );
  }
  if (!response) {
    throw new AppError('no-response', '后台没有返回结果，请重试。');
  }
  if (!response.ok) {
    throw new AppError(response.code ?? 'request-failed', response.error);
  }
  return response.data;
}

export type MessageHandler = (request: Request) => Promise<unknown>;

/** 后台侧：注册统一的消息入口。 */
export function registerMessageHandler(handler: MessageHandler): void {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message !== 'object' || typeof (message as { type?: unknown }).type !== 'string') {
      return false;
    }
    handler(message as Request)
      .then((data) => sendResponse({ ok: true, data } satisfies Envelope<unknown>))
      .catch((error: unknown) => {
        const code = error instanceof AppError ? error.code : 'handler-failed';
        const text = error instanceof Error ? error.message : String(error);
        console.error('[CloudBookmark] 处理消息失败', message, error);
        sendResponse({ ok: false, error: text, code } satisfies Envelope<unknown>);
      });
    return true; // 告诉浏览器"我会异步回复"，否则通道会立刻关闭
  });
}

/** 判断一个错误是不是"用户取消/需要确认"这类非异常情况。 */
export function isAppError(error: unknown, code?: string): error is AppError {
  return error instanceof AppError && (code === undefined || error.code === code);
}
