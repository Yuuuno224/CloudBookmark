import { createSignal, onMount, For, Show } from 'solid-js';
import type { ChangeRecord, ChangeStats } from '@/types';

const ACTION_LABELS: Record<string, string> = {
  create: '新增',
  remove: '删除',
  update: '编辑',
  move: '移动',
};

const ACTION_COLORS: Record<string, string> = {
  create: 'text-green-600',
  remove: 'text-red-600',
  update: 'text-blue-600',
  move: 'text-orange-600',
};

export function ChangeLog() {
  const [records, setRecords] = createSignal<ChangeRecord[]>([]);
  const [stats, setStats] = createSignal<ChangeStats | null>(null);
  const [tab, setTab] = createSignal<'log' | 'stats'>('log');
  const [loading, setLoading] = createSignal(true);

  const refresh = async () => {
    setLoading(true);
    try {
      const [r, s] = await Promise.all([
        chrome.runtime.sendMessage({ type: 'GET_CHANGE_LOG', limit: 100 }),
        chrome.runtime.sendMessage({ type: 'GET_CHANGE_STATS', days: 30 }),
      ]);
      if (r?.records) setRecords(r.records);
      if (s?.stats) setStats(s.stats);
    } catch { /* ignore */ }
    setLoading(false);
  };

  onMount(() => refresh());

  const handleClear = async () => {
    await chrome.runtime.sendMessage({ type: 'CLEAR_CHANGE_LOG' });
    setRecords([]);
    setStats(null);
  };

  return (
    <div class="p-3 space-y-3">
      <div class="flex items-center justify-between">
        <div class="flex gap-1">
          <button
            classList={{
              'px-2 py-1 text-xs rounded': true,
              'bg-blue-500 text-white': tab() === 'log',
              'text-gray-600 hover:bg-gray-100': tab() !== 'log',
            }}
            onClick={() => setTab('log')}
          >
            变更记录
          </button>
          <button
            classList={{
              'px-2 py-1 text-xs rounded': true,
              'bg-blue-500 text-white': tab() === 'stats',
              'text-gray-600 hover:bg-gray-100': tab() !== 'stats',
            }}
            onClick={() => setTab('stats')}
          >
            统计
          </button>
        </div>
        <button
          onClick={handleClear}
          class="text-xs text-red-400 hover:text-red-600"
        >
          清空
        </button>
      </div>

      <Show when={tab() === 'log'}>
        <Show when={!loading()} fallback={<p class="text-center text-gray-400 text-xs py-4">加载中...</p>}>
          <Show when={records().length > 0} fallback={<p class="text-center text-gray-400 text-xs py-4">暂无变更记录</p>}>
            <div class="space-y-1 max-h-[340px] overflow-y-auto">
              <For each={records()}>
                {(r) => (
                  <div class="flex items-start gap-2 px-2 py-1.5 rounded hover:bg-gray-50 text-xs">
                    <span class={`font-medium shrink-0 w-8 ${ACTION_COLORS[r.action]}`}>
                      {ACTION_LABELS[r.action]}
                    </span>
                    <div class="flex-1 min-w-0">
                      <p class="text-gray-700 truncate">{r.bookmarkTitle || r.bookmarkId}</p>
                      <Show when={r.bookmarkUrl}>
                        <p class="text-gray-400 truncate">{r.bookmarkUrl}</p>
                      </Show>
                    </div>
                    <span class="text-gray-400 shrink-0">
                      {new Date(r.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </Show>
      </Show>

      <Show when={tab() === 'stats' && stats()}>
        {(() => {
          const s = stats()!;
          return (
            <div class="space-y-3 text-xs">
              <div class="grid grid-cols-4 gap-2">
                <div class="text-center p-2 bg-green-50 rounded">
                  <div class="text-lg font-bold text-green-600">{s.creates}</div>
                  <div class="text-gray-500">新增</div>
                </div>
                <div class="text-center p-2 bg-red-50 rounded">
                  <div class="text-lg font-bold text-red-600">{s.removes}</div>
                  <div class="text-gray-500">删除</div>
                </div>
                <div class="text-center p-2 bg-blue-50 rounded">
                  <div class="text-lg font-bold text-blue-600">{s.updates}</div>
                  <div class="text-gray-500">编辑</div>
                </div>
                <div class="text-center p-2 bg-orange-50 rounded">
                  <div class="text-lg font-bold text-orange-600">{s.moves}</div>
                  <div class="text-gray-500">移动</div>
                </div>
              </div>

              <div>
                <p class="font-medium text-gray-600 mb-1">近 7 日趋势</p>
                <div class="flex items-end gap-1 h-16">
                  <For each={Object.entries(s.byDate).slice(-7)}>
                    {([date, count]) => {
                      const max = Math.max(...Object.values(s.byDate), 1);
                      const pct = (count / max) * 100;
                      return (
                        <div class="flex-1 flex flex-col items-center gap-0.5">
                          <div class="w-full bg-blue-400 rounded-t" style={{ height: `${Math.max(pct, 4)}%` }} />
                          <span class="text-gray-400" style={{ 'font-size': '9px' }}>{date.slice(5)}</span>
                        </div>
                      );
                    }}
                  </For>
                </div>
              </div>

              <div>
                <p class="font-medium text-gray-600 mb-1">24 小时分布</p>
                <div class="flex items-end gap-px h-12">
                  <For each={s.byHour}>
                    {(count, i) => {
                      const max = Math.max(...s.byHour, 1);
                      const pct = (count / max) * 100;
                      return (
                        <div
                          class="flex-1 bg-blue-300 rounded-t"
                          style={{ height: `${Math.max(pct, 2)}%` }}
                          title={`${i()}:00 — ${count} 次`}
                        />
                      );
                    }}
                  </For>
                </div>
                <div class="flex justify-between text-gray-400 mt-0.5" style={{ 'font-size': '8px' }}>
                  <span>0</span><span>6</span><span>12</span><span>18</span><span>23</span>
                </div>
              </div>

              <p class="text-gray-400">共 {s.total} 条变更（近 30 日）</p>
            </div>
          );
        })()}
      </Show>
    </div>
  );
}
