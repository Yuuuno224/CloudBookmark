/**
 * 冲突处理
 * ========
 *
 * 三种冲突在界面上的说法：
 *
 *  1. **同一处被两边改了**（kind = fields）
 *     → 列出改了什么，让你选"保留本地 / 使用远端 / 两者都留"。
 *  2. **一端删了、另一端改了**（kind = delete-modify）
 *     → 按钮文案会直接写成"确认删除"和"保留修改"，避免你猜。
 *
 * 所有项都选完才能点"应用"。不确定的话可以点"放弃处理"，
 * 它不会改动任何书签，下次同步还会重新问你。
 */

import { createMemo, createSignal, For, onMount, Show } from 'solid-js';
import { describeConflict, resolveLabels } from '@/core/resolve';
import type { Conflict, Resolution } from '@/core/types';
import { sendRequest } from '@/platform/messaging';
import { Banner, Button, Card, EmptyState, Pill } from '../../shared/components';
import { formatConflictField } from '../../shared/format';
import { useAction } from '../../shared/useStore';

export function ConflictsTab() {
  const action = useAction();
  const [conflicts, setConflicts] = createSignal<Conflict[]>([]);
  const [choices, setChoices] = createSignal<Record<string, Resolution>>({});
  const [loading, setLoading] = createSignal(true);

  const load = async () => {
    setLoading(true);
    try {
      const list = await sendRequest({ type: 'conflict:list' });
      setConflicts(list);
      setChoices({});
    } catch {
      setConflicts([]);
    } finally {
      setLoading(false);
    }
  };

  onMount(() => void load());

  const decided = createMemo(() => Object.keys(choices()).length);
  const allDecided = createMemo(() => conflicts().length > 0 && decided() >= conflicts().length);

  const choose = (id: string, value: Resolution) => setChoices({ ...choices(), [id]: value });

  const chooseAll = (value: 'local' | 'remote') => {
    const next: Record<string, Resolution> = {};
    for (const conflict of conflicts()) next[conflict.id] = value;
    setChoices(next);
  };

  const apply = () =>
    action.run(
      async () => {
        const result = await sendRequest({ type: 'conflict:resolve', resolutions: choices() });
        await load();
        return result;
      },
      { notice: '已按你的选择处理完成，并同步到云端。' },
    );

  const discard = () =>
    action.run(
      async () => {
        await sendRequest({ type: 'conflict:discard' });
        await load();
      },
      { notice: '已放弃处理。你的书签没有被改动，下次同步还会再问你。' },
    );

  return (
    <Show
      when={!loading()}
      fallback={
        <Card>
          <EmptyState>正在读取冲突…</EmptyState>
        </Card>
      }
    >
      <Show
        when={conflicts().length > 0}
        fallback={
          <Card title="没有待处理的冲突">
            <EmptyState>一切正常。当本地和云端改了同一处内容时，冲突会出现在这里。</EmptyState>
          </Card>
        }
      >
        <Card
          title={`共 ${conflicts().length} 处冲突`}
          hint="每一处都告诉了你两边分别改成了什么。选完之后点最下面的「应用选择」。"
          actions={
            <div class="flex gap-2">
              <Button size="sm" onClick={() => chooseAll('local')}>
                全部保留本地
              </Button>
              <Button size="sm" onClick={() => chooseAll('remote')}>
                全部使用远端
              </Button>
            </div>
          }
        >
          <p class="text-xs text-ink-soft">
            已选择 {decided()} / {conflicts().length}
          </p>
        </Card>

        <For each={conflicts()}>
          {(conflict, index) => (
            <Card
              title={`${index() + 1}. ${conflict.label}`}
              actions={
                <Show
                  when={conflict.kind === 'delete-modify'}
                  fallback={<Pill tone="info">两边都改了</Pill>}
                >
                  <Pill tone="danger">一边删一边改</Pill>
                </Show>
              }
            >
              <Show when={conflict.kind === 'fields' && conflict.fields.length > 0}>
                <p class="mb-2 text-xs text-ink-soft">
                  冲突字段：{conflict.fields.map(formatConflictField).join('、')}
                </p>
              </Show>

              <div class="overflow-hidden rounded-md border border-line">
                <table class="w-full border-collapse text-xs">
                  <thead class="bg-surface-raised text-ink-soft">
                    <tr>
                      <th class="px-2 py-1.5 text-left font-medium">项目</th>
                      <th class="px-2 py-1.5 text-left font-medium">上次同步时</th>
                      <th class="px-2 py-1.5 text-left font-medium">本地现在</th>
                      <th class="px-2 py-1.5 text-left font-medium">云端现在</th>
                    </tr>
                  </thead>
                  <tbody>
                    <For each={describeConflict(conflict)}>
                      {(diff) => (
                        <tr class="border-t border-line">
                          <td class="px-2 py-1.5 text-ink-soft">{diff.field}</td>
                          <td class="px-2 py-1.5 text-ink-faint">{diff.base}</td>
                          <td
                            class={`break-all px-2 py-1.5 ${
                              choices()[conflict.id] === 'local'
                                ? 'bg-accent-soft font-medium text-accent-ink'
                                : 'text-ink'
                            }`}
                          >
                            {diff.local}
                          </td>
                          <td
                            class={`break-all px-2 py-1.5 ${
                              choices()[conflict.id] === 'remote'
                                ? 'bg-alt-soft font-medium text-alt-ink'
                                : 'text-ink'
                            }`}
                          >
                            {diff.remote}
                          </td>
                        </tr>
                      )}
                    </For>
                  </tbody>
                </table>
              </div>

              <div class="mt-3 flex flex-wrap gap-2">
                <For each={resolveLabels(conflict)}>
                  {(option) => (
                    <Button
                      size="sm"
                      variant={choices()[conflict.id] === option.value ? 'primary' : 'secondary'}
                      title={option.hint}
                      onClick={() => choose(conflict.id, option.value)}
                    >
                      {option.label}
                    </Button>
                  )}
                </For>
              </div>
            </Card>
          )}
        </For>

        <Show when={action.error()}>
          <Banner tone="danger" title="处理失败">
            <p class="break-words">{action.error()}</p>
          </Banner>
        </Show>
        <Show when={action.notice()}>
          <Banner tone="success">
            <p>{action.notice()}</p>
          </Banner>
        </Show>

        <Card>
          <div class="flex items-center justify-between gap-3">
            <p class="text-xs text-ink-soft">
              {allDecided() ? '所有冲突都已选择，可以应用了。' : '请为每一处冲突都做出选择。'}
            </p>
            <div class="flex gap-2">
              <Button variant="ghost" onClick={discard} disabled={action.busy()}>
                放弃处理
              </Button>
              <Button variant="primary" onClick={apply} disabled={!allDecided()} loading={action.busy()}>
                应用选择
              </Button>
            </div>
          </div>
        </Card>
      </Show>
    </Show>
  );
}
