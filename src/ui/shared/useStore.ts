/**
 * 界面用的状态钩子
 * ================
 *
 * 这里的核心思想：**界面不保存业务状态，只是"照镜子"**。
 *
 * 真正的状态（同步状态、设置）由后台写在 chrome.storage.local 里。
 * 界面订阅 onChanged，后台一改，界面自动重画——不需要任何全局变量，
 * 也没有"两个页面数据不一致"的问题。
 */

import { createSignal, onCleanup, onMount } from 'solid-js';
import { AppError, type Settings, type SyncState } from '@/core/types';
import { DEFAULT_SETTINGS, defaultSyncState, normalizeSettings } from '@/features/settings';
import { kvStore } from '@/platform/kv';

export interface LiveState {
  state: () => SyncState;
  settings: () => Settings;
  ready: () => boolean;
}

/** 订阅同步状态与设置。 */
export function useLiveState(): LiveState {
  const [state, setState] = createSignal<SyncState>(defaultSyncState());
  const [settings, setSettings] = createSignal<Settings>(DEFAULT_SETTINGS);
  const [ready, setReady] = createSignal(false);

  onMount(() => {
    let disposed = false;

    void (async () => {
      const stored = await kvStore.getMany(['syncState', 'settings']);
      if (disposed) return;
      setState({ ...defaultSyncState(), ...(stored.syncState ?? {}) });
      setSettings(normalizeSettings(stored.settings));
      setReady(true);
    })();

    const off = kvStore.onChange((changed) => {
      if (changed.syncState) setState({ ...defaultSyncState(), ...changed.syncState });
      if (changed.settings) setSettings(normalizeSettings(changed.settings));
    });

    onCleanup(() => {
      disposed = true;
      off();
    });
  });

  return { state, settings, ready };
}

export interface Action {
  busy: () => boolean;
  error: () => string | null;
  notice: () => string | null;
  setNotice: (value: string | null) => void;
  setError: (value: string | null) => void;
  clear: () => void;
  run: <T>(task: () => Promise<T>, options?: { notice?: string }) => Promise<T | undefined>;
}

/**
 * 一次"点按钮 → 调后台 → 显示结果"的通用流程。
 * 统一处理忙碌、错误提示，省得每个按钮都写一遍 try/catch。
 */
export function useAction(): Action {
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [notice, setNotice] = createSignal<string | null>(null);

  const clear = () => {
    setError(null);
    setNotice(null);
  };

  const run = async <T,>(task: () => Promise<T>, options?: { notice?: string }): Promise<T | undefined> => {
    if (busy()) return undefined;
    setBusy(true);
    clear();
    try {
      const result = await task();
      if (options?.notice) setNotice(options.notice);
      return result;
    } catch (caught) {
      setError(caught instanceof AppError ? caught.message : caught instanceof Error ? caught.message : String(caught));
      return undefined;
    } finally {
      setBusy(false);
    }
  };

  return { busy, error, notice, setNotice, setError, clear, run };
}

/** 打开独立设置页。 */
export function openOptions(hash?: string): void {
  const url = chrome.runtime.getURL('src/ui/options/index.html');
  if (hash) {
    void chrome.tabs.create({ url: `${url}#${hash}` });
  } else {
    void chrome.runtime.openOptionsPage();
  }
}

/** 在新标签页打开 Gist。 */
export function openGist(url: string): void {
  void chrome.tabs.create({ url });
}
