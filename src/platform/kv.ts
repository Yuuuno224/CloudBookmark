/**
 * 小数据存储（chrome.storage.local）
 * ==================================
 *
 * 这里只放"小而且界面需要实时看到"的数据：
 * 设置、同步状态、设备 id、Gist id、加密后的 Token。
 *
 * 为什么放这里而不是 IndexedDB？
 * 因为 chrome.storage 有 onChanged 事件——后台改一下状态，
 * 弹窗和设置页会自动收到通知并刷新界面，不需要自己写事件总线。
 *
 * 书签快照、身份表这类大数据在 blob-store.ts（IndexedDB）里。
 */

import type { AuthMethod, OAuthTokenMeta, PendingDeviceAuth, Settings, SyncState } from '@/core/types';

/** 加密后的 Token。明文永远不落盘。 */
export interface TokenBlob {
  iv: string;
  data: string;
}

export interface KvSchema {
  settings: Settings;
  syncState: SyncState;
  deviceId: string;
  gistId: string | null;
  tokenBlob: TokenBlob | null;
  /** 上次验证通过的 GitHub 用户名，只用于展示。 */
  accountLogin: string | null;
  /** 凭据是怎么来的（填 Token / GitHub 授权），只用于展示。 */
  authMethod: AuthMethod | null;
  /** 正在进行的"用 GitHub 授权"流程；没有就是 null。 */
  oauthPending: PendingDeviceAuth | null;
  /** OAuth 凭据的附加信息（令牌是否会过期）；用 Token 方式授权时为 null。 */
  oauthTokenMeta: OAuthTokenMeta | null;
}

export type KvKey = keyof KvSchema;

export const kvStore = {
  async get<K extends KvKey>(key: K): Promise<KvSchema[K] | undefined> {
    const result = await chrome.storage.local.get(key);
    return result[key] as KvSchema[K] | undefined;
  },

  async getMany<K extends KvKey>(keys: K[]): Promise<Partial<Pick<KvSchema, K>>> {
    const result = await chrome.storage.local.get(keys as string[]);
    return result as Partial<Pick<KvSchema, K>>;
  },

  async getAll(): Promise<Partial<KvSchema>> {
    return (await chrome.storage.local.get(null)) as Partial<KvSchema>;
  },

  async set<K extends KvKey>(key: K, value: KvSchema[K]): Promise<void> {
    await chrome.storage.local.set({ [key]: value });
  },

  async patch<K extends KvKey>(key: K, value: Partial<KvSchema[K]>): Promise<void> {
    const current = (await this.get(key)) ?? {};
    await chrome.storage.local.set({ [key]: { ...(current as object), ...(value as object) } });
  },

  async remove(key: KvKey): Promise<void> {
    await chrome.storage.local.remove(key);
  },

  /** 清空全部小数据（"抹掉本地缓存"用）。 */
  async clear(): Promise<void> {
    await chrome.storage.local.clear();
  },

  /** 监听变化，界面用它做自动刷新。返回取消订阅的函数。 */
  onChange(listener: (changed: Partial<KvSchema>) => void): () => void {
    const handler = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string,
    ) => {
      if (areaName !== 'local') return;
      const changed: Record<string, unknown> = {};
      for (const [key, change] of Object.entries(changes)) {
        changed[key] = change.newValue;
      }
      listener(changed as Partial<KvSchema>);
    };
    chrome.storage.onChanged.addListener(handler);
    return () => chrome.storage.onChanged.removeListener(handler);
  },
};
