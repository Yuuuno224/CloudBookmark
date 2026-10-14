/**
 * 数据：导出、导入、备份回滚、重复清理、清空缓存
 * ============================================
 *
 * 这一页是"保命用"的：
 *  - 导出一份 JSON 存到电脑里，是最可靠的备份方式（不依赖 GitHub）
 *  - 覆盖操作前的自动备份可以一键回滚
 *  - 重复书签清理只是工具，不会自动跑
 */

import { createSignal, onMount, Show } from 'solid-js';
import { sendRequest, type DataStats, type DuplicateGroup } from '@/platform/messaging';
import { Banner, Button, Card, ConfirmBar, EmptyState, KeyValue, Pill } from '../../shared/components';
import { absoluteTime, relativeTime } from '../../shared/format';
import { useAction } from '../../shared/useStore';

type ConfirmKind = 'rollback-local' | 'rollback-remote' | 'reset' | 'dedupe' | null;

export function DataTab() {
  const action = useAction();
  const [stats, setStats] = createSignal<DataStats | null>(null);
  const [duplicates, setDuplicates] = createSignal<DuplicateGroup[] | null>(null);
  const [confirm, setConfirm] = createSignal<ConfirmKind>(null);
  const [importMode, setImportMode] = createSignal<'replace' | 'merge'>('merge');
  const [importText, setImportText] = createSignal<string | null>(null);
  const [importName, setImportName] = createSignal('');

  const refresh = async () => {
    try {
      setStats(await sendRequest({ type: 'data:stats' }));
    } catch {
      setStats(null);
    }
  };

  onMount(() => void refresh());

  // ---- 导出：直接在页面里生成文件下载，不经过后台 ----
  const exportJson = () =>
    action.run(
      async () => {
        const { json, filename } = await sendRequest({ type: 'data:export' });
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = filename;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
        return filename;
      },
      { notice: '已开始下载备份文件。' },
    );

  const pickFile = (file: File | undefined) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setImportText(String(reader.result ?? ''));
      setImportName(file.name);
      setConfirm(null);
    };
    reader.readAsText(file);
  };

  const doImport = () =>
    action.run(
      async () => {
        const text = importText();
        if (!text) throw new Error('请先选择要导入的 JSON 文件。');
        const counts = await sendRequest({ type: 'data:import', json: text, mode: importMode() });
        setImportText(null);
        setImportName('');
        await refresh();
        return counts;
      },
      { notice: '导入完成。记得点一次「同步」把结果推到云端。' },
    );

  const doRollback = (which: 'local' | 'remote') =>
    action.run(
      async () => {
        await sendRequest({ type: 'data:rollback', which });
        setConfirm(null);
        await refresh();
      },
      { notice: which === 'local' ? '已把本地书签恢复到覆盖之前。' : '已把云端内容恢复到覆盖之前。' },
    );

  const doReset = () =>
    action.run(
      async () => {
        await sendRequest({ type: 'data:reset' });
        setConfirm(null);
        await refresh();
      },
      { notice: '已清空本地缓存。下次同步会重新和云端比对一次。' },
    );

  const loadDuplicates = () =>
    action.run(async () => {
      const groups = await sendRequest({ type: 'data:duplicates' });
      setDuplicates(groups);
      return groups;
    });

  const removeDuplicates = () =>
    action.run(
      async () => {
        const groups = duplicates() ?? [];
        // 每组保留第一条，其余删掉
        const uids = groups.flatMap((group) => group.uids.slice(1));
        const { removed } = await sendRequest({ type: 'data:removeDuplicates', uids });
        setDuplicates(null);
        setConfirm(null);
        await refresh();
        return removed;
      },
      { notice: '已清理重复书签（每组保留第一条）。' },
    );

  return (
    <>
      <Show when={action.error()}>
        <Banner tone="danger" title="操作失败">
          <p class="break-words">{action.error()}</p>
        </Banner>
      </Show>
      <Show when={action.notice()}>
        <Banner tone="success">
          <p>{action.notice()}</p>
        </Banner>
      </Show>

      {/* ---------------- 概况 ---------------- */}
      <Card
        title="本地数据概况"
        actions={
          <Button size="sm" variant="ghost" onClick={refresh}>
            刷新
          </Button>
        }
      >
        <Show when={stats()} fallback={<EmptyState>正在读取…</EmptyState>}>
          {(data) => (
            <div>
              <KeyValue label="当前书签条数">{data().entryCount} 条</KeyValue>
              <KeyValue label="同步基准（三方合并的 base）">
                {data().baseSavedAt ? relativeTime(data().baseSavedAt) : '还没有'}
              </KeyValue>
              <KeyValue label="覆盖前·本地备份">
                {data().backupLocalSavedAt
                  ? `${relativeTime(data().backupLocalSavedAt)}（${data().backupLocalCount} 条）`
                  : '还没有'}
              </KeyValue>
              <KeyValue label="覆盖前·云端备份">
                {data().backupRemoteSavedAt
                  ? `${relativeTime(data().backupRemoteSavedAt)}（${data().backupRemoteCount} 条）`
                  : '还没有'}
              </KeyValue>
              <KeyValue label="变更记录条数">{data().changeLogCount} 条</KeyValue>
              <KeyValue label="疑似重复书签">
                {data().duplicateGroups > 0 ? (
                  <Pill tone="warn">{data().duplicateGroups} 组</Pill>
                ) : (
                  '没有'
                )}
              </KeyValue>
            </div>
          )}
        </Show>
      </Card>

      {/* ---------------- 导出 / 导入 ---------------- */}
      <Card
        title="导出与导入"
        hint="导出的 JSON 是纯文本，和云端格式完全一样。最可靠的备份方式就是定期导出一份存到本地。"
      >
        <div class="space-y-4">
          <div class="flex items-center justify-between gap-3">
            <p class="text-sm text-ink-soft">把当前浏览器书签导出成 JSON 文件</p>
            <Button onClick={exportJson} loading={action.busy()}>
              导出 JSON
            </Button>
          </div>

          <div class="border-t border-line pt-3">
            <p class="text-sm text-ink-soft">从 JSON 文件恢复</p>
            <div class="mt-2 flex flex-wrap items-center gap-2">
              <input
                type="file"
                accept=".json,application/json"
                class="text-xs text-ink-soft"
                onChange={(event) => pickFile(event.currentTarget.files?.[0])}
              />
              <select
                class="rounded-md border border-line bg-surface px-2 py-1 text-xs text-ink"
                value={importMode()}
                onChange={(event) => setImportMode(event.currentTarget.value as 'replace' | 'merge')}
              >
                <option value="merge">合并进现有书签（推荐）</option>
                <option value="replace">替换现有书签（原书签会消失）</option>
              </select>
            </div>
            <Show when={importText()}>
              <p class="mt-2 text-xs text-ink-soft">
                已选择：{importName()}（{Math.round((importText()!.length / 1024) * 10) / 10} KB）
              </p>
              <div class="mt-2">
                <Button
                  variant={importMode() === 'replace' ? 'danger' : 'primary'}
                  onClick={doImport}
                  loading={action.busy()}
                >
                  {importMode() === 'replace' ? '确认替换本地书签' : '开始合并导入'}
                </Button>
              </div>
            </Show>
            <p class="mt-2 text-xs text-ink-faint">
              导入只改动本地书签，不会碰云端。导入后点一次「同步」才会推到云端。
            </p>
          </div>
        </div>
      </Card>

      {/* ---------------- 回滚 ---------------- */}
      <Card
        title="回滚"
        hint="每次「用本地覆盖云端」或「用云端覆盖本地」之前，都会自动留一份备份。这里可以把它们还原回去。"
      >
        <Show
          when={confirm() === 'rollback-local' || confirm() === 'rollback-remote'}
          fallback={
            <div class="flex flex-wrap gap-2">
              <Button onClick={() => setConfirm('rollback-local')} disabled={!stats()?.backupLocalSavedAt}>
                恢复本地到覆盖前
              </Button>
              <Button onClick={() => setConfirm('rollback-remote')} disabled={!stats()?.backupRemoteSavedAt}>
                恢复云端到覆盖前
              </Button>
            </div>
          }
        >
          <ConfirmBar
            message={
              confirm() === 'rollback-local'
                ? `会把当前浏览器书签替换成 ${absoluteTime(stats()?.backupLocalSavedAt ?? null)} 的备份内容。当前的书签改动会丢失。`
                : `会把云端 Gist 内容替换成 ${absoluteTime(stats()?.backupRemoteSavedAt ?? null)} 的备份内容。`
            }
            confirmLabel="确认恢复"
            tone="danger"
            busy={action.busy()}
            onConfirm={() => doRollback(confirm() === 'rollback-local' ? 'local' : 'remote')}
            onCancel={() => setConfirm(null)}
          />
        </Show>
      </Card>

      {/* ---------------- 重复书签 ---------------- */}
      <Card
        title="重复书签清理"
        hint="同一个网址出现多次时，可以只保留第一条。这个工具只在你点击时运行，不会自动删东西。"
      >
        <Show
          when={duplicates()}
          fallback={
            <Button onClick={loadDuplicates} loading={action.busy()}>
              扫描重复书签
            </Button>
          }
        >
          {(groups) => (
            <Show
              when={groups().length > 0}
              fallback={
                <div class="flex items-center justify-between gap-3">
                  <p class="text-sm text-ink-soft">没有发现重复书签 🎉</p>
                  <Button size="sm" variant="ghost" onClick={() => setDuplicates(null)}>
                    关闭
                  </Button>
                </div>
              }
            >
              <p class="mb-2 text-sm text-ink-soft">发现 {groups().length} 组重复：</p>
              <div class="max-h-52 space-y-1 overflow-y-auto">
                {groups().map((group) => (
                  <div class="rounded border border-warn-line bg-warn-soft px-2 py-1.5">
                    <p class="truncate text-xs font-medium text-ink">{group.title || group.url}</p>
                    <p class="truncate text-xs text-ink-soft">{group.url}</p>
                    <p class="text-xs text-warn-ink">共 {group.uids.length} 条，将保留第 1 条</p>
                  </div>
                ))}
              </div>
              <div class="mt-3">
                <Show
                  when={confirm() === 'dedupe'}
                  fallback={
                    <Button variant="danger" onClick={() => setConfirm('dedupe')}>
                      清理这 {groups().reduce((sum, group) => sum + group.uids.length - 1, 0)} 条重复
                    </Button>
                  }
                >
                  <ConfirmBar
                    message="会把每组里第 1 条之外的书签删掉。删除前会自动备份，可以在上一块「回滚」里恢复。"
                    confirmLabel="确认清理"
                    tone="danger"
                    busy={action.busy()}
                    onConfirm={removeDuplicates}
                    onCancel={() => setConfirm(null)}
                  />
                </Show>
              </div>
            </Show>
          )}
        </Show>
      </Card>

      {/* ---------------- 清空缓存 ---------------- */}
      <Card
        title="清空本地缓存"
        hint="会删掉同步基准、身份表、备份和历史记录，但不会动你的书签，也不会动云端。一般只在数据看起来很乱时使用。"
      >
        <Show
          when={confirm() === 'reset'}
          fallback={
            <Button variant="ghost" onClick={() => setConfirm('reset')}>
              清空本地缓存
            </Button>
          }
        >
          <ConfirmBar
            message="清空后，下次同步会被当成「第一次同步」：会按网址重新和云端比对一次。你的书签不会丢，但可能需要重新处理一次冲突。"
            confirmLabel="确认清空"
            tone="danger"
            busy={action.busy()}
            onConfirm={doReset}
            onCancel={() => setConfirm(null)}
          />
        </Show>
      </Card>
    </>
  );
}
