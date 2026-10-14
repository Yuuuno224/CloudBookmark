/**
 * 历史：同步历史 + 本地变更记录
 * ============================
 *
 * 同步历史回答"什么时候同步过、改了多少、有没有出错"。
 * 变更记录回答"我（或浏览器）什么时候动了哪条书签"。
 */

import { createSignal, For, onMount, Show } from 'solid-js';
import type { ChangeRecord, SyncLogEntry } from '@/core/types';
import { sendRequest } from '@/platform/messaging';
import { Banner, Button, Card, EmptyState, Pill } from '../../shared/components';
import { actionTone, exactTime, formatAction, formatCounts, formatMode, relativeTime } from '../../shared/format';
import { useAction } from '../../shared/useStore';

type Panel = 'sync' | 'changes';

export function HistoryTab() {
  const action = useAction();
  const [panel, setPanel] = createSignal<Panel>('sync');
  const [logs, setLogs] = createSignal<SyncLogEntry[]>([]);
  const [changes, setChanges] = createSignal<ChangeRecord[]>([]);
  const [loading, setLoading] = createSignal(true);

  const load = async () => {
    setLoading(true);
    try {
      const [syncLog, changeLog] = await Promise.all([
        sendRequest({ type: 'history:list', limit: 100 }),
        sendRequest({ type: 'changes:list', limit: 300 }),
      ]);
      setLogs(syncLog);
      setChanges(changeLog);
    } catch {
      /* 忽略 */
    } finally {
      setLoading(false);
    }
  };

  onMount(() => void load());

  const clear = () =>
    action.run(
      async () => {
        if (panel() === 'sync') await sendRequest({ type: 'history:clear' });
        else await sendRequest({ type: 'changes:clear' });
        await load();
      },
      { notice: '已清空。' },
    );

  return (
    <>
      <Card
        actions={
          <div class="flex gap-2">
            <Button size="sm" variant="ghost" onClick={load} disabled={loading()}>
              刷新
            </Button>
            <Button size="sm" variant="ghost" onClick={clear} disabled={action.busy()}>
              清空
            </Button>
          </div>
        }
      >
        <div class="flex gap-2">
          <Button
            size="sm"
            variant={panel() === 'sync' ? 'primary' : 'secondary'}
            onClick={() => setPanel('sync')}
          >
            同步历史（{logs().length}）
          </Button>
          <Button
            size="sm"
            variant={panel() === 'changes' ? 'primary' : 'secondary'}
            onClick={() => setPanel('changes')}
          >
            书签变更（{changes().length}）
          </Button>
        </div>
      </Card>

      <Show when={action.notice()}>
        <Banner tone="success">
          <p>{action.notice()}</p>
        </Banner>
      </Show>

      <Show when={panel() === 'sync'}>
        <Card hint="每次同步（手动、自动、定时）都会记一条。">
          <Show
            when={logs().length > 0}
            fallback={<EmptyState>{loading() ? '正在读取…' : '还没有同步记录。'}</EmptyState>}
          >
            <div class="divide-y divide-line">
              <For each={logs()}>
                {(log) => (
                  <div class="flex items-start justify-between gap-3 py-2">
                    <div class="min-w-0">
                      <div class="flex items-center gap-2">
                        <Pill tone={log.ok ? 'success' : 'danger'}>{log.ok ? '成功' : '失败'}</Pill>
                        <span class="text-xs font-medium text-ink">{formatMode(log.mode)}</span>
                        <Show when={log.pushed}>
                          <span class="text-xs text-ink-faint">已上传云端</span>
                        </Show>
                        <Show when={log.conflictCount > 0}>
                          <Pill tone="warn">{log.conflictCount} 个冲突</Pill>
                        </Show>
                      </div>
                      <p class="mt-1 text-xs text-ink-soft">
                        {log.ok ? formatCounts(log) : <span class="text-danger-ink">{log.error}</span>}
                      </p>
                    </div>
                    <div class="shrink-0 text-right">
                      <p class="text-xs text-ink-soft">{relativeTime(log.at)}</p>
                      <p class="text-xs text-ink-faint">{exactTime(log.at)}</p>
                    </div>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </Card>
      </Show>

      <Show when={panel() === 'changes'}>
        <Card hint="你在浏览器里手动改书签时记录下来的流水。同步自己写入的改动不会记进来。">
          <Show
            when={changes().length > 0}
            fallback={<EmptyState>{loading() ? '正在读取…' : '还没有变更记录。'}</EmptyState>}
          >
            <div class="divide-y divide-line">
              <For each={changes()}>
                {(change) => (
                  <div class="flex items-center justify-between gap-3 py-1.5">
                    <div class="flex min-w-0 items-center gap-2">
                      <Pill tone={actionTone(change.action)}>{formatAction(change.action)}</Pill>
                      <span class="truncate text-xs text-ink">
                        {change.title || change.url || `节点 ${change.browserId}`}
                      </span>
                    </div>
                    <span class="shrink-0 text-xs text-ink-faint">{relativeTime(change.at)}</span>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </Card>
      </Show>
    </>
  );
}
