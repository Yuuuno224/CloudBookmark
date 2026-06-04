import { createSignal, onMount, Show } from 'solid-js';
import type { SyncState } from '@/types';

export function SyncStatus() {
  const [state, setState] = createSignal<SyncState>({
    status: 'idle',
    lastSyncAt: null,
    lastSyncVersion: null,
    lastError: null,
    isDirty: false,
  });
  const [syncing, setSyncing] = createSignal(false);

  const refreshState = async () => {
    const resp = await chrome.runtime.sendMessage({ type: 'GET_SYNC_STATE' });
    if (resp) setState(resp as SyncState);
  };

  onMount(() => {
    refreshState();
  });

  const handleSync = async () => {
    setSyncing(true);
    try {
      await chrome.runtime.sendMessage({ type: 'SYNC_NOW' });
    } catch { /* ignore */ }
    setSyncing(false);
    await refreshState();
  };

  const statusText = () => {
    if (syncing()) return '同步中...';
    switch (state().status) {
      case 'syncing': return '同步中...';
      case 'conflict': return '存在冲突';
      case 'error': return '同步出错';
      default: return state().lastSyncAt ? '已同步' : '未同步';
    }
  };

  const statusColor = () => {
    if (syncing()) return 'text-blue-500';
    switch (state().status) {
      case 'syncing': return 'text-blue-500';
      case 'conflict': return 'text-orange-500';
      case 'error': return 'text-red-500';
      default: return state().lastSyncAt ? 'text-green-500' : 'text-gray-400';
    }
  };

  return (
    <div class="flex items-center justify-between px-4 py-2 bg-gray-50 border-b border-gray-100">
      <div class="flex items-center gap-2">
        <span class={`text-xs font-medium ${statusColor()}`}>
          {statusText()}
        </span>
        <Show when={state().lastSyncAt && !syncing()}>
          <span class="text-xs text-gray-400">
            {new Date(state().lastSyncAt!).toLocaleTimeString('zh-CN')}
          </span>
        </Show>
      </div>
      <button
        onClick={handleSync}
        disabled={syncing()}
        classList={{
          'px-3 py-1 text-xs font-medium rounded-md transition': true,
          'bg-blue-500 text-white hover:bg-blue-600': !syncing(),
          'bg-gray-300 text-gray-500 cursor-not-allowed': syncing(),
        }}
      >
        {syncing() ? '同步中...' : '立即同步'}
      </button>
    </div>
  );
}
