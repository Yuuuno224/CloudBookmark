/**
 * 总览：一眼看清现在什么状态，以及最常用的几个按钮。
 */

import { createSignal, onMount, Show } from 'solid-js';
import type { SyncOutcome } from '@/core/types';
import { sendRequest, type EnvInfo } from '@/platform/messaging';
import { Banner, Button, Card, ConfirmBar, KeyValue, Pill } from '../../shared/components';
import { absoluteTime, describeStatus, formatCounts, relativeTime } from '../../shared/format';
import { openGist, useAction, useLiveState } from '../../shared/useStore';
import type { TabKey } from './nav';

export function OverviewTab(props: { onGoTo: (tab: TabKey) => void }) {
  const { state, settings, ready } = useLiveState();
  const action = useAction();
  const [env, setEnv] = createSignal<EnvInfo | null>(null);
  const [confirm, setConfirm] = createSignal<null | 'push' | 'pull'>(null);
  const [outcome, setOutcome] = createSignal<SyncOutcome | null>(null);

  onMount(() => {
    void sendRequest({ type: 'env:info' })
      .then(setEnv)
      .catch(() => setEnv(null));
  });

  const status = () => describeStatus(state());
  const configured = () => (env() ? env()!.hasToken : state().status !== 'unconfigured');

  const runSync = (mode: 'merge' | 'push' | 'pull', force = false) =>
    action.run(async () => {
      const result = await sendRequest({ type: 'sync:run', mode, force });
      if (result.needsConfirm === 'overwrite-remote') {
        setConfirm('push');
        return result;
      }
      if (result.needsConfirm === 'overwrite-local') {
        setConfirm('pull');
        return result;
      }
      setConfirm(null);
      setOutcome(result);
      return result;
    });

  return (
    <>
      {/* ---------------- 没配 Token 时的引导 ---------------- */}
      <Show when={ready() && !configured()}>
        <Card tone="warn" title="先配置 GitHub 授权">
          <p class="text-sm leading-relaxed text-ink">
            CloudBookmark 把书签存到你自己 GitHub 账号下的一个私有 Gist 里，所以需要先授权。
            两种方式任选一种，都在「设置」标签页里。
          </p>
          <div class="mt-3">
            <Button variant="primary" onClick={() => props.onGoTo('settings')}>
              去配置
            </Button>
          </div>
        </Card>
      </Show>

      <Card>
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div class="flex items-center gap-2">
            <Pill tone={status().tone}>{status().text}</Pill>
            <span class="text-xs text-ink-soft">{status().detail}</span>
          </div>
          <div class="flex gap-2">
            <Button
              variant="primary"
              loading={action.busy() && !confirm()}
              disabled={!configured() || state().status === 'syncing' || state().conflictCount > 0}
              onClick={() => runSync('merge')}
            >
              立即同步
            </Button>
            <Button variant="ghost" onClick={() => props.onGoTo('settings')}>
              设置
            </Button>
          </div>
        </div>

        <div class="mt-4 grid grid-cols-2 gap-x-6 gap-y-1 border-t border-line pt-3">
          <KeyValue label="上次成功同步">{relativeTime(state().lastSyncAt)}</KeyValue>
          <KeyValue label="上次同步时间点">{absoluteTime(state().lastSyncAt)}</KeyValue>
          <KeyValue label="本地书签数">{state().entryCount > 0 ? `${state().entryCount} 条` : '—'}</KeyValue>
          <KeyValue label="云端最后来自">{state().remoteDeviceName ?? '—'}</KeyValue>
          <KeyValue label="当前设备">{env()?.deviceName ?? '—'}</KeyValue>
          <KeyValue label="GitHub 账号">{env()?.login ? `@${env()!.login}` : '未登录'}</KeyValue>
          <KeyValue label="自动同步">
            {settings().autoSyncEnabled ? `每 ${settings().autoSyncIntervalMinutes} 分钟` : '已关闭'}
          </KeyValue>
          <KeyValue label="冲突策略">
            {settings().conflictPolicy === 'ask'
              ? '有冲突时问我'
              : settings().conflictPolicy === 'prefer-local'
                ? '自动保留本地'
                : '自动使用远端'}
          </KeyValue>
        </div>
      </Card>

      <Show when={state().conflictCount > 0}>
        <Banner
          tone="warn"
          title={`有 ${state().conflictCount} 处冲突等待处理`}
          action={
            <Button size="sm" variant="primary" onClick={() => props.onGoTo('conflicts')}>
              去处理
            </Button>
          }
        >
          <p>同步已经暂停，你的书签暂时没有被改动。处理完之后再同步即可。</p>
        </Banner>
      </Show>

      <Show when={state().status === 'error' && state().lastError}>
        <Banner tone="danger" title="上次同步失败">
          <p class="break-words">{state().lastError}</p>
        </Banner>
      </Show>

      <Card
        title="危险操作"
        hint="下面两个按钮是单向覆盖，只用于「云端数据乱了」或「本机数据乱了」时强制对齐。执行前会自动备份，可在「数据」标签页回滚。"
      >
        <Show when={action.error()}>
          <div class="mb-3">
            <Banner tone="danger">
              <p class="break-words">{action.error()}</p>
            </Banner>
          </div>
        </Show>
        <Show when={action.notice()}>
          <div class="mb-3">
            <Banner tone="success">
              <p>{action.notice()}</p>
            </Banner>
          </div>
        </Show>

        <Show
          when={confirm()}
          fallback={
            <div class="flex gap-2">
              <Button onClick={() => runSync('push')} disabled={!configured() || action.busy()}>
                用本地覆盖云端
              </Button>
              <Button onClick={() => runSync('pull')} disabled={!configured() || action.busy()}>
                用云端覆盖本地
              </Button>
            </div>
          }
        >
          {(which) => (
            <ConfirmBar
              message={
                which() === 'push'
                  ? '云端里有还没合并到本地的内容。继续会用本地书签覆盖云端，云端的新增和修改会丢失。真的要继续吗？'
                  : '本地有还没上传的改动。继续会用云端内容覆盖本地，这些改动会丢失（覆盖前会自动备份）。真的要继续吗？'
              }
              confirmLabel={which() === 'push' ? '确认覆盖云端' : '确认覆盖本地'}
              tone="danger"
              busy={action.busy()}
              onConfirm={() => runSync(which(), true)}
              onCancel={() => setConfirm(null)}
            />
          )}
        </Show>
      </Card>

      <Show when={outcome()}>
        {(result) => (
          <Show when={!result().needsConfirm}>
            <Card title="最近一次操作结果">
              <p class="text-sm text-ink">
                {result().mode === 'merge' ? '合并同步' : result().mode === 'push' ? '上传覆盖' : '下载覆盖'}：
                {formatCounts(result().counts)}
                {result().pushed ? '，已上传到云端' : '，云端无需更新'}
              </p>
              <Show when={result().warnings.length > 0}>
                <ul class="mt-2 space-y-1">
                  {result().warnings.map((warning) => (
                    <li class="text-xs leading-relaxed text-warn-ink">· {warning.message}</li>
                  ))}
                </ul>
              </Show>
            </Card>
          </Show>
        )}
      </Show>

      <Card title="云端文件" hint="数据存在你自己账号下的私有 Gist 里，可以随时自己打开查看或备份。">
        <div class="flex items-center justify-between gap-3">
          <div class="min-w-0 text-sm text-ink-soft">
            <Show
              when={state().gistUrl}
              fallback={<span class="text-ink-faint">还没有创建云端文件（第一次同步时自动创建）</span>}
            >
              <span class="break-all font-mono text-xs text-ink-soft">{state().gistUrl}</span>
            </Show>
          </div>
          <div class="flex shrink-0 gap-2">
            <Show when={state().gistUrl}>
              <Button size="sm" onClick={() => openGist(state().gistUrl!)}>
                打开 Gist
              </Button>
            </Show>
            <Show when={state().gistId}>
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  action.run(() => sendRequest({ type: 'gist:forget' }), {
                    notice: '已忽略当前 Gist，下次同步会重新查找或新建一个。',
                  })
                }
              >
                换一个 Gist
              </Button>
            </Show>
          </div>
        </div>
      </Card>
    </>
  );
}
