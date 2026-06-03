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

  onMount(async () => {
    const result = await chrome.storage.local.get('syncState');
    if (result.syncState) setState(result.syncState);
  });

  const statusText = () => {
    switch (state().status) {
      case 'syncing': return '同步中...';
      case 'conflict': return '存在冲突';
      case 'error': return '同步出错';
      case 'offline': return '离线';
      default: return state().isDirty ? '有未同步变更' : '已同步';
    }
  };

  const statusColor = () => {
    switch (state().status) {
      case 'syncing': return 'text-blue-500';
      case 'conflict': return 'text-orange-500';
      case 'error': return 'text-red-500';
      default: return state().isDirty ? 'text-yellow-500' : 'text-green-500';
    }
  };

  return (
    <div class="flex items-center justify-between px-4 py-2 bg-gray-50 border-b border-gray-100">
      <span class={`text-xs font-medium ${statusColor()}`}>
        {statusText()}
      </span>
      <Show when={state().lastSyncAt}>
        <span class="text-xs text-gray-400">
          {new Date(state().lastSyncAt!).toLocaleTimeString('zh-CN')}
        </span>
      </Show>
    </div>
  );
}
