/**
 * 独立设置页
 * ==========
 *
 * 比弹窗大得多，所以冲突对比、数据管理、历史这些"信息量大"的功能放这里。
 * 用最简单的标签页切换（不需要路由库）。
 *
 * 地址栏里的 #conflicts 这样的锚点可以直接定位到某个标签，
 * 弹窗里的"去处理"按钮就是靠这个跳过来的。
 */

import { createSignal, onCleanup, onMount, Show } from 'solid-js';
import { Dot, Pill } from '../shared/components';
import { describeStatus } from '../shared/format';
import { ThemeToggle } from '../shared/ThemeToggle';
import { useApplyTheme } from '../shared/theme';
import { useLiveState } from '../shared/useStore';
import { ConflictsTab } from './tabs/ConflictsTab';
import { DataTab } from './tabs/DataTab';
import { HelpTab } from './tabs/HelpTab';
import { HistoryTab } from './tabs/HistoryTab';
import { isTabKey, TAB_LABELS, type TabKey } from './tabs/nav';
import { OverviewTab } from './tabs/OverviewTab';
import { SettingsTab } from './tabs/SettingsTab';

function readHash(): TabKey {
  const raw = window.location.hash.replace('#', '');
  return isTabKey(raw) ? raw : 'overview';
}

export function App() {
  const { state, settings } = useLiveState();
  const [tab, setTab] = createSignal<TabKey>(readHash());
  const status = () => describeStatus(state());

  useApplyTheme(settings);

  onMount(() => {
    const onHashChange = () => setTab(readHash());
    window.addEventListener('hashchange', onHashChange);
    onCleanup(() => window.removeEventListener('hashchange', onHashChange));
  });

  const select = (key: TabKey) => {
    setTab(key);
    window.location.hash = key;
  };

  return (
    <div class="mx-auto max-w-4xl px-6 py-6">
      <header class="mb-5 flex items-center justify-between gap-3">
        <div class="flex min-w-0 items-center gap-2.5">
          <Dot tone={status().tone} />
          <h1 class="text-lg font-semibold text-ink">CloudBookmark</h1>
          <Pill tone={status().tone}>{status().text}</Pill>
        </div>
        <div class="flex shrink-0 items-center gap-2">
          <p class="hidden text-xs text-ink-faint sm:block">书签云端同步（基于 GitHub Gist）</p>
          <ThemeToggle />
        </div>
      </header>

      <nav class="mb-4 flex gap-1 rounded-lg border border-line bg-surface p-1 shadow-sm">
        {TAB_LABELS.map((item) => (
          <button
            type="button"
            onClick={() => select(item.key)}
            class={`relative flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition ${
              tab() === item.key ? 'bg-brand text-white' : 'text-ink-soft hover:bg-surface-raised'
            }`}
          >
            {item.label}
            <Show when={item.key === 'conflicts' && state().conflictCount > 0}>
              <span class="ml-1 rounded-full bg-amber-400 px-1.5 text-xs text-amber-950">
                {state().conflictCount}
              </span>
            </Show>
          </button>
        ))}
      </nav>

      <main class="space-y-4">
        <Show when={tab() === 'overview'}>
          <OverviewTab onGoTo={select} />
        </Show>
        <Show when={tab() === 'conflicts'}>
          <ConflictsTab />
        </Show>
        <Show when={tab() === 'history'}>
          <HistoryTab />
        </Show>
        <Show when={tab() === 'data'}>
          <DataTab />
        </Show>
        <Show when={tab() === 'settings'}>
          <SettingsTab />
        </Show>
        <Show when={tab() === 'help'}>
          <HelpTab />
        </Show>
      </main>

      <footer class="mt-8 border-t border-line pt-3 text-xs text-ink-faint">
        <p>
          数据保存在你自己 GitHub 账号下的私有 Gist 里，本扩展没有自己的服务器。
          遇到问题时，先看「帮助」标签页。
        </p>
      </footer>
    </div>
  );
}
