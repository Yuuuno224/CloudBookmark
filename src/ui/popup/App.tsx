/**
 * 弹窗界面
 * ========
 *
 * 弹窗只干三件事：看状态、点同步、遇到问题跳去设置页。
 * 复杂的东西（冲突对比、数据管理、历史）都在独立设置页里，
 * 因为 360 像素宽放不下。
 *
 * 读代码的顺序建议：
 *   1. 下面这段 render 结构（先看界面长什么样）
 *   2. 各个 handler（按钮点了做什么）
 *   3. useLiveState / useAction / useApplyTheme（状态从哪来、主题怎么套）
 */

import { createSignal, onMount, Show } from 'solid-js';
import type { SyncOutcome } from '@/core/types';
import { sendRequest, type EnvInfo } from '@/platform/messaging';
import { Banner, Button, Card, ConfirmBar, Dot, KeyValue, Pill } from '../shared/components';
import { describeStatus, formatCounts, relativeTime } from '../shared/format';
import { ThemeToggle } from '../shared/ThemeToggle';
import { useApplyTheme } from '../shared/theme';
import { openGist, openOptions, useAction, useLiveState } from '../shared/useStore';

export function App() {
  const { state, settings, ready } = useLiveState();
  const action = useAction();
  const [env, setEnv] = createSignal<EnvInfo | null>(null);
  const [confirm, setConfirm] = createSignal<null | 'push' | 'pull'>(null);
  const [outcome, setOutcome] = createSignal<SyncOutcome | null>(null);

  // 让界面跟着设置里的主题走
  useApplyTheme(settings);

  onMount(() => {
    void sendRequest({ type: 'env:info' }).then(setEnv).catch(() => setEnv(null));
  });

  // env 是权威来源；它还没回来时先用同步状态猜一个
  const configured = () => (env() ? env()!.hasToken : state().status !== 'unconfigured');
  const status = () => describeStatus(state());

  // -------------------------------------------------------------------------
  // 操作
  // -------------------------------------------------------------------------

  const runMerge = () =>
    action.run(async () => {
      setConfirm(null);
      const result = await sendRequest({ type: 'sync:run', mode: 'merge' });
      setOutcome(result);
      return result;
    });

  const runPush = (force: boolean) =>
    action.run(async () => {
      const result = await sendRequest({ type: 'sync:run', mode: 'push', force });
      if (result.needsConfirm === 'overwrite-remote') {
        setConfirm('push');
        return result;
      }
      setConfirm(null);
      setOutcome(result);
      return result;
    });

  const runPull = (force: boolean) =>
    action.run(async () => {
      const result = await sendRequest({ type: 'sync:run', mode: 'pull', force });
      if (result.needsConfirm === 'overwrite-local') {
        setConfirm('pull');
        return result;
      }
      setConfirm(null);
      setOutcome(result);
      return result;
    });

  return (
    <div class="flex max-h-[600px] min-h-[420px] flex-col">
      {/* ---------------- 顶栏 ---------------- */}
      <header class="flex items-center justify-between border-b border-line bg-surface px-4 py-3">
        <div class="flex min-w-0 items-center gap-2">
          <Dot tone={status().tone} />
          <h1 class="text-sm font-semibold text-ink">CloudBookmark</h1>
          <Show when={env()?.login}>
            <span class="truncate text-xs text-ink-faint">@{env()!.login}</span>
          </Show>
        </div>
        <div class="flex shrink-0 items-center gap-1">
          <ThemeToggle />
          <Button size="sm" variant="ghost" onClick={() => openOptions()} title="打开设置">
            设置
          </Button>
        </div>
      </header>

      <main class="flex-1 space-y-3 overflow-y-auto p-3">
        {/* ---------------- 未配置 Token ---------------- */}
        <Show when={ready() && !configured()}>
          <Card tone="warn" title="还差一步">
            <p class="text-sm leading-relaxed text-ink">
              先填写一个 GitHub Token，CloudBookmark 才能把书签同步到你自己账号下的 Gist。
            </p>
            <ul class="mt-2 space-y-1 text-xs text-ink-soft">
              <li>
                · Token 只需要 <code class="rounded bg-surface-raised px-1">gist</code> 一个权限
              </li>
              <li>· 也可以直接用 GitHub 账号授权（不用手抄 Token）</li>
              <li>· Token 会加密后存在本机，只在请求 GitHub 时使用</li>
            </ul>
            <div class="mt-3">
              <Button variant="primary" full onClick={() => openOptions('settings')}>
                去配置
              </Button>
            </div>
          </Card>
        </Show>

        {/* ---------------- 状态卡 ---------------- */}
        <Show when={configured()}>
          <Card>
            <div class="flex items-center justify-between">
              <Pill tone={status().tone}>{status().text}</Pill>
              <Show when={state().entryCount > 0}>
                <span class="text-xs text-ink-faint">本地 {state().entryCount} 条</span>
              </Show>
            </div>
            <p class="mt-2 text-xs leading-relaxed text-ink-soft">{status().detail}</p>

            <div class="mt-2 border-t border-line pt-1">
              <KeyValue label="上次成功同步">{relativeTime(state().lastSyncAt)}</KeyValue>
              <Show when={state().remoteDeviceName}>
                <KeyValue label="云端最后来自">{state().remoteDeviceName}</KeyValue>
              </Show>
              <KeyValue label="设备">{env()?.deviceName ?? '—'}</KeyValue>
            </div>
          </Card>

          {/* ---------------- 冲突提示 ---------------- */}
          <Show when={state().conflictCount > 0}>
            <Banner
              tone="warn"
              title={`有 ${state().conflictCount} 处冲突等你决定`}
              action={
                <Button size="sm" variant="primary" onClick={() => openOptions('conflicts')}>
                  去处理
                </Button>
              }
            >
              <p>本地和云端改了同一处内容。为了避免误删，同步已经暂停，书签暂时没被动过。</p>
            </Banner>
          </Show>

          {/* ---------------- 报错 ---------------- */}
          <Show when={state().status === 'error' && state().lastError}>
            <Banner tone="danger" title="同步失败">
              <p class="break-words">{state().lastError}</p>
            </Banner>
          </Show>

          {/* ---------------- 主操作 ---------------- */}
          <Show when={state().conflictCount === 0}>
            <Button
              variant="primary"
              full
              loading={action.busy()}
              disabled={state().status === 'syncing'}
              onClick={runMerge}
            >
              {state().status === 'syncing' ? state().phase ?? '同步中…' : '立即同步'}
            </Button>
            <p class="text-center text-xs leading-relaxed text-ink-faint">
              把本地和云端的新改动合并到一起（推荐日常使用）
            </p>

            {/* 危险操作：二次确认 */}
            <Show when={confirm()}>
              {(which) => (
                <ConfirmBar
                  message={
                    which() === 'push'
                      ? '云端有还没有合并过来的新内容。继续上传会用你本地的书签「覆盖」云端，那边的新增和修改会丢掉。建议先点「立即同步」。'
                      : '本地有还没同步上去的改动。继续下载会用云端内容「覆盖」本地，这些改动会丢掉（覆盖前会自动备份，可以在设置页回滚）。'
                  }
                  confirmLabel={which() === 'push' ? '确认覆盖云端' : '确认覆盖本地'}
                  tone="danger"
                  busy={action.busy()}
                  onConfirm={() => (which() === 'push' ? runPush(true) : runPull(true))}
                  onCancel={() => setConfirm(null)}
                />
              )}
            </Show>

            <Show when={!confirm()}>
              <div class="flex gap-2">
                <Button size="sm" full onClick={() => runPush(false)} disabled={action.busy()}>
                  上传到云端
                </Button>
                <Button size="sm" full onClick={() => runPull(false)} disabled={action.busy()}>
                  下载到本地
                </Button>
              </div>
              <p class="text-center text-xs text-ink-faint">
                这两个是单向覆盖操作，只在上面的合并同步出问题时才用
              </p>
            </Show>
          </Show>

          {/* ---------------- 上次操作结果 ---------------- */}
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

          <Show when={outcome()}>
            {(result) => (
              <Show when={!result().needsConfirm}>
                <Card title="本次同步结果">
                  <p class="text-xs leading-relaxed text-ink-soft">
                    {formatCounts(result().counts)}
                    {result().pushed ? '，已上传到云端' : '，云端无需更新'}
                  </p>
                  <Show when={result().warnings.length > 0}>
                    <ul class="mt-2 space-y-1">
                      {result().warnings.slice(0, 4).map((warning) => (
                        <li class="text-xs leading-relaxed text-warn-ink">· {warning.message}</li>
                      ))}
                    </ul>
                  </Show>
                </Card>
              </Show>
            )}
          </Show>
        </Show>
      </main>

      {/* ---------------- 底栏 ---------------- */}
      <footer class="flex items-center justify-between border-t border-line bg-surface px-4 py-2">
        <Show
          when={state().gistUrl}
          fallback={<span class="text-xs text-ink-faint">云端：未创建</span>}
        >
          <button
            type="button"
            class="text-xs text-brand hover:underline"
            onClick={() => openGist(state().gistUrl!)}
          >
            打开云端 Gist
          </button>
        </Show>
        <button
          type="button"
          class="text-xs text-ink-faint hover:text-ink-soft"
          onClick={() => openOptions()}
        >
          全部设置与帮助
        </button>
      </footer>
    </div>
  );
}
