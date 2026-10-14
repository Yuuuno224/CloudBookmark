/**
 * 设置页
 * ======
 *
 * 每一处都尽量写清楚"改了会怎样"，因为这个页面上的开关直接决定
 * 你的书签会不会被自动改动、以及同步会不会来打扰你。
 */

import { createSignal, onMount, Show } from 'solid-js';
import type { Settings, ThemeMode } from '@/core/types';
import { SYNC_INTERVAL_CHOICES } from '@/features/settings';
import { sendRequest, type EnvInfo } from '@/platform/messaging';
import {
  Banner,
  Button,
  Card,
  Field,
  KeyValue,
  SegmentedControl,
  Select,
  TextInput,
  Toggle,
} from '../../shared/components';
import { absoluteTime } from '../../shared/format';
import { openGist, useAction, useLiveState } from '../../shared/useStore';
import { AuthCard } from './AuthCard';

export function SettingsTab() {
  const { state, settings } = useLiveState();
  const action = useAction();
  const [env, setEnv] = createSignal<EnvInfo | null>(null);
  const [deviceName, setDeviceName] = createSignal<string | null>(null);

  const refreshEnv = () =>
    sendRequest({ type: 'env:info' })
      .then(setEnv)
      .catch(() => setEnv(null));

  onMount(() => void refreshEnv());

  const saveSettings = (patch: Partial<Settings>) =>
    action.run(() => sendRequest({ type: 'settings:set', patch }));

  const saveDeviceName = () =>
    action.run(
      async () => {
        const value = deviceName();
        if (value === null) return;
        await sendRequest({ type: 'settings:set', patch: { deviceName: value.trim() } });
        setDeviceName(null);
        await refreshEnv();
      },
      { notice: '设备名已保存。' },
    );

  return (
    <>
      {/* ---------------- 外观 ---------------- */}
      <Card title="外观" hint="主题只影响界面配色，不影响任何数据。切换是即时的。">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p class="text-sm font-medium text-ink">主题</p>
            <p class="mt-0.5 text-xs leading-relaxed text-ink-soft">
              也可以直接点右上角的太阳 / 月亮图标一键切换（那样会在浅色和深色之间固定选择）。
            </p>
          </div>
          <SegmentedControl<ThemeMode>
            value={settings().theme}
            onChange={(value) => void saveSettings({ theme: value })}
            options={[
              { value: 'system', label: '跟随系统', title: '跟着操作系统的深浅色设置走' },
              { value: 'light', label: '浅色' },
              { value: 'dark', label: '深色' },
            ]}
          />
        </div>
      </Card>

      {/* ---------------- GitHub 授权 ---------------- */}
      <AuthCard env={env()} onChanged={() => void refreshEnv()} />

      {/* ---------------- 云端文件 ---------------- */}
      <Card title="云端文件（Gist）" hint="多个设备必须指向同一个 Gist 才能互相同步。">
        <KeyValue label="当前 Gist">
          <Show when={state().gistUrl} fallback={<span class="text-ink-faint">还没有创建</span>}>
            <span class="font-mono text-xs">{state().gistId}</span>
          </Show>
        </KeyValue>
        <KeyValue label="上次云端更新">{absoluteTime(state().remoteUpdatedAt)}</KeyValue>
        <div class="mt-3 flex gap-2">
          <Show when={state().gistUrl}>
            <Button size="sm" onClick={() => openGist(state().gistUrl!)}>
              在 GitHub 打开
            </Button>
          </Show>
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              action.run(() => sendRequest({ type: 'gist:forget' }), {
                notice: '已忘记当前 Gist。下次同步会重新查找；找不到就新建一个空 Gist。',
              })
            }
          >
            忘记当前 Gist
          </Button>
        </div>
        <p class="mt-2 text-xs leading-relaxed text-ink-soft">
          「忘记」只是让扩展不再记住这个 Gist 的 id，并不会删除 GitHub 上的文件。
          如果你的 Gist 被误删了，扩展下次同步会自动新建一个。
        </p>
      </Card>

      {/* ---------------- 自动同步 ---------------- */}
      <Card title="自动同步" hint="这一组开关决定 CloudBookmark 会不会自己动你的书签。">
        <Toggle
          label="本地书签变化后自动同步"
          hint="你在浏览器里加 / 删 / 改书签后约 3 秒，自动把改动同步出去。关掉的话就完全靠手动点「立即同步」。"
          checked={settings().autoUploadOnChange}
          onChange={(checked) => void saveSettings({ autoUploadOnChange: checked })}
        />
        <div class="border-t border-line" />
        <Toggle
          label="定时同步"
          hint="每隔一段时间自动拉取云端改动并合并。适合多设备使用。"
          checked={settings().autoSyncEnabled}
          onChange={(checked) => void saveSettings({ autoSyncEnabled: checked })}
        />
        <Show when={settings().autoSyncEnabled}>
          <div class="mt-2 max-w-xs">
            <Field label="同步间隔">
              <Select
                value={settings().autoSyncIntervalMinutes}
                onChange={(value) => void saveSettings({ autoSyncIntervalMinutes: value })}
                options={SYNC_INTERVAL_CHOICES.map((minutes) => ({
                  value: minutes,
                  label: minutes >= 60 ? `${minutes / 60} 小时` : `${minutes} 分钟`,
                }))}
              />
            </Field>
          </div>
        </Show>
      </Card>

      {/* ---------------- 冲突策略 ---------------- */}
      <Card title="冲突策略" hint="当同一个书签在本地和云端被改成了不一样的内容时，怎么办。">
        <Field
          label="默认做法"
          hint="推荐「有冲突时问我」。自动策略适合你只在一台设备上操作、不担心误覆盖的情况。"
        >
          <Select
            value={settings().conflictPolicy}
            onChange={(value) => void saveSettings({ conflictPolicy: value })}
            options={[
              { value: 'ask', label: '有冲突时问我（推荐）' },
              { value: 'prefer-local', label: '自动保留本地版本' },
              { value: 'prefer-remote', label: '自动使用云端版本' },
            ]}
          />
        </Field>

        <div class="mt-4 border-t border-line pt-3">
          <Field
            label="第一次同步怎么做"
            hint="指本机还没有任何同步记录时的行为。已经有基准的常规同步不受影响。"
          >
            <Select
              value={settings().firstSyncStrategy}
              onChange={(value) => void saveSettings({ firstSyncStrategy: value })}
              options={[
                { value: 'merge', label: '按网址配对后合并（推荐，不会产生重复）' },
                { value: 'local-wins', label: '以本机为准，覆盖云端' },
                { value: 'remote-wins', label: '以云端为准，覆盖本机' },
              ]}
            />
          </Field>
        </div>

        <div class="mt-4 rounded-md bg-surface-raised p-3 text-xs leading-relaxed text-ink-soft">
          <p class="font-medium text-ink">补充说明</p>
          <p class="mt-1">
            「一边删了、另一边改了」这种冲突，默认都会保住被修改的那一份，
            因为删掉是不可逆的。策略只影响"两边都改了同一处"的情况。
          </p>
        </div>
      </Card>

      {/* ---------------- 本机信息 ---------------- */}
      <Card title="本机信息">
        <KeyValue label="设备 ID">
          <span class="font-mono text-xs">{env()?.deviceId ?? '—'}</span>
        </KeyValue>
        <KeyValue label="浏览器">{env()?.browser ?? '—'}</KeyValue>
        <KeyValue label="扩展版本">{env()?.version ?? '—'}</KeyValue>

        <div class="mt-3">
          <Field
            label="设备名字"
            hint="会写进云端文件，用来分辨「上次是谁改的」。留空则自动使用「浏览器 + 系统」。"
          >
            <div class="flex gap-2">
              <TextInput
                value={deviceName() ?? settings().deviceName}
                onInput={setDeviceName}
                placeholder={env()?.deviceName ?? 'Chrome on Windows'}
              />
              <Button onClick={saveDeviceName} disabled={deviceName() === null} loading={action.busy()}>
                保存
              </Button>
            </div>
          </Field>
        </div>

        <div class="mt-4 border-t border-line pt-3">
          <Field label="变更记录最多保留多少条" hint="只影响本机历史记录的条数，不影响书签本身。">
            <div class="max-w-xs">
              <Select
                value={settings().changeLogLimit}
                onChange={(value) => void saveSettings({ changeLogLimit: value })}
                options={[
                  { value: 500, label: '500 条' },
                  { value: 2000, label: '2000 条（默认）' },
                  { value: 5000, label: '5000 条' },
                  { value: 20000, label: '20000 条' },
                ]}
              />
            </div>
          </Field>
        </div>
      </Card>

      <Show when={action.error()}>
        <Banner tone="danger" title="保存失败">
          <p class="break-words">{action.error()}</p>
        </Banner>
      </Show>
      <Show when={action.notice()}>
        <Banner tone="success">
          <p>{action.notice()}</p>
        </Banner>
      </Show>
    </>
  );
}
