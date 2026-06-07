import { createSignal, onMount, Show, For } from 'solid-js';
import type { SyncState, ConflictEntry, BookmarkNode } from '@/types';

type SyncMode = 'merge' | 'split';

export function SyncStatus() {
  const [state, setState] = createSignal<SyncState>({
    status: 'idle',
    lastSyncAt: null,
    lastSyncVersion: null,
    lastError: null,
    isDirty: false,
  });
  const [syncing, setSyncing] = createSignal(false);
  const [syncMode, setSyncMode] = createSignal<SyncMode>('merge');
  const [conflicts, setConflicts] = createSignal<ConflictEntry[]>([]);
  const [resolutions, setResolutions] = createSignal<Map<string, 'local' | 'remote' | 'both'>>(new Map());

  const refreshState = async () => {
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'GET_SYNC_STATE' });
      if (resp) setState(resp as SyncState);

      const conflictResp = await chrome.runtime.sendMessage({ type: 'GET_PENDING_CONFLICTS' });
      if (conflictResp?.conflicts?.length > 0) {
        setConflicts(conflictResp.conflicts);
      } else {
        setConflicts([]);
        setResolutions(new Map());
      }
    } catch { /* ignore */ }
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

  const handlePush = async () => {
    setSyncing(true);
    try {
      await chrome.runtime.sendMessage({ type: 'PUSH_NOW' });
    } catch { /* ignore */ }
    setSyncing(false);
    await refreshState();
  };

  const handlePull = async () => {
    setSyncing(true);
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'PULL_NOW' });
      if (resp?.conflicts?.length > 0) {
        setConflicts(resp.conflicts);
        setResolutions(new Map());
      }
    } catch { /* ignore */ }
    setSyncing(false);
    await refreshState();
  };

  const handleResolve = async () => {
    const resolutionList = Array.from(resolutions().entries()).map(([id, resolution]) => ({
      id,
      resolution,
    }));
    setSyncing(true);
    try {
      await chrome.runtime.sendMessage({ type: 'RESOLVE_CONFLICTS', resolutions: resolutionList });
      setConflicts([]);
      setResolutions(new Map());
    } catch { /* ignore */ }
    setSyncing(false);
    await refreshState();
  };

  const setResolution = (id: string, value: 'local' | 'remote' | 'both') => {
    const next = new Map(resolutions());
    next.set(id, value);
    setResolutions(next);
  };

  const statusText = () => {
    if (syncing()) return '同步中...';
    switch (state().status) {
      case 'syncing': return '同步中...';
      case 'conflict': return `${conflicts().length} 个冲突`;
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

  const getNodeTitle = (value: unknown): string => {
    const node = value as BookmarkNode;
    return node?.title || '(无标题)';
  };

  const getNodeUrl = (value: unknown): string => {
    const node = value as BookmarkNode;
    return node?.url || '';
  };

  const hasConflicts = () => conflicts().length > 0;

  return (
    <div class="px-4 py-2 bg-gray-50 border-b border-gray-100">
      <div class="flex items-center justify-between">
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

        <Show when={!hasConflicts()}>
          <div class="flex gap-1">
            <Show when={syncMode() === 'merge'}>
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
            </Show>
            <Show when={syncMode() === 'split'}>
              <button
                onClick={handlePush}
                disabled={syncing()}
                classList={{
                  'px-2 py-1 text-xs font-medium rounded-md transition': true,
                  'bg-emerald-500 text-white hover:bg-emerald-600': !syncing(),
                  'bg-gray-300 text-gray-500 cursor-not-allowed': syncing(),
                }}
              >
                上传
              </button>
              <button
                onClick={handlePull}
                disabled={syncing()}
                classList={{
                  'px-2 py-1 text-xs font-medium rounded-md transition': true,
                  'bg-violet-500 text-white hover:bg-violet-600': !syncing(),
                  'bg-gray-300 text-gray-500 cursor-not-allowed': syncing(),
                }}
              >
                下载
              </button>
            </Show>
          </div>
        </Show>
      </div>

      <Show when={!hasConflicts()}>
        <div class="flex items-center gap-2 mt-1">
          <span class="text-xs text-gray-400">模式:</span>
          <button
            classList={{
              'text-xs px-2 py-0.5 rounded transition': true,
              'bg-gray-800 text-white': syncMode() === 'merge',
              'text-gray-500 hover:bg-gray-200': syncMode() !== 'merge',
            }}
            onClick={() => setSyncMode('merge')}
          >
            合并同步
          </button>
          <button
            classList={{
              'text-xs px-2 py-0.5 rounded transition': true,
              'bg-gray-800 text-white': syncMode() === 'split',
              'text-gray-500 hover:bg-gray-200': syncMode() !== 'split',
            }}
            onClick={() => setSyncMode('split')}
          >
            拆分上传/下载
          </button>
        </div>
      </Show>

      <Show when={hasConflicts()}>
        <div class="mt-2 p-2 bg-orange-50 border border-orange-200 rounded-md">
          <div class="flex items-center justify-between mb-2">
            <span class="text-xs font-semibold text-orange-700">
              {conflicts().length} 个冲突需要解决
            </span>
            <span class="text-xs text-orange-400">
              请为每项选择保留方式
            </span>
          </div>

          <div class="space-y-2 max-h-56 overflow-y-auto">
            <For each={conflicts()}>
              {(conflict, _index) => {
                const localNode = () => conflict.localValue as BookmarkNode;
                const remoteNode = () => conflict.remoteValue as BookmarkNode;
                const currentResolution = () => resolutions().get(conflict.id);

                return (
                  <div class="p-2 bg-white border border-orange-100 rounded">
                    <div class="flex items-start justify-between mb-1.5">
                      <div class="flex-1 min-w-0">
                        <div class="text-xs font-medium text-gray-700 truncate">
                          {getNodeTitle(conflict.localValue)}
                        </div>
                        <Show when={getNodeUrl(conflict.localValue)}>
                          <div class="text-xs text-gray-400 truncate">
                            {getNodeUrl(conflict.localValue)}
                          </div>
                        </Show>
                      </div>
                      <span class="text-xs text-orange-400 ml-2 shrink-0">
                        #{_index() + 1}
                      </span>
                    </div>

                    <div class="grid grid-cols-2 gap-1 mb-1.5 text-xs">
                      <div class="px-1.5 py-1 bg-blue-50 rounded border border-blue-100">
                        <span class="text-blue-400">本地:</span>
                        <span class="text-gray-600 ml-1 truncate">{localNode().title}</span>
                      </div>
                      <div class="px-1.5 py-1 bg-violet-50 rounded border border-violet-100">
                        <span class="text-violet-400">远端:</span>
                        <span class="text-gray-600 ml-1 truncate">{remoteNode().title}</span>
                      </div>
                    </div>

                    <div class="flex gap-1">
                      <button
                        classList={{
                          'flex-1 px-1 py-1 rounded text-xs font-medium transition': true,
                          'bg-blue-500 text-white shadow-sm': currentResolution() === 'local',
                          'bg-gray-100 text-gray-500 hover:bg-blue-100 hover:text-blue-600': currentResolution() !== 'local',
                        }}
                        onClick={() => setResolution(conflict.id, 'local')}
                      >
                        保留本地
                      </button>
                      <button
                        classList={{
                          'flex-1 px-1 py-1 rounded text-xs font-medium transition': true,
                          'bg-violet-500 text-white shadow-sm': currentResolution() === 'remote',
                          'bg-gray-100 text-gray-500 hover:bg-violet-100 hover:text-violet-600': currentResolution() !== 'remote',
                        }}
                        onClick={() => setResolution(conflict.id, 'remote')}
                      >
                        使用远端
                      </button>
                      <button
                        classList={{
                          'flex-1 px-1 py-1 rounded text-xs font-medium transition': true,
                          'bg-emerald-500 text-white shadow-sm': currentResolution() === 'both',
                          'bg-gray-100 text-gray-500 hover:bg-emerald-100 hover:text-emerald-600': currentResolution() !== 'both',
                        }}
                        onClick={() => setResolution(conflict.id, 'both')}
                      >
                        保留两者
                      </button>
                    </div>
                  </div>
                );
              }}
            </For>
          </div>

          <div class="mt-2 flex items-center gap-2">
            <span class="text-xs text-orange-400">
              已选择 {resolutions().size}/{conflicts().length}
            </span>
            <button
              onClick={handleResolve}
              disabled={resolutions().size < conflicts().length || syncing()}
              classList={{
                'flex-1 py-1.5 text-xs font-medium rounded-md transition': true,
                'bg-orange-500 text-white hover:bg-orange-600': resolutions().size >= conflicts().length && !syncing(),
                'bg-gray-300 text-gray-500 cursor-not-allowed': resolutions().size < conflicts().length || syncing(),
              }}
            >
              {syncing() ? '应用中...' : '应用选择'}
            </button>
          </div>
        </div>
      </Show>
    </div>
  );
}
