/**
 * 主题切换小按钮（一个太阳 / 月亮图标）
 * ====================================
 *
 * 放在弹窗和设置页的右上角。点一下就固定成"当前外观的反面"，
 * 比如系统是深色、你点一下就会强制浅色。
 *
 * 想选"跟随系统"的话，去设置页用三选一的分段控件。
 *
 * 这个组件自己订阅了设置（所以可以随处丢一个进去）。
 * 多订阅一次的开销可以忽略，换来的是用起来不用传任何属性。
 */

import { Show } from 'solid-js';
import { sendRequest } from '@/platform/messaging';
import { currentTheme, toggledTheme } from './theme';
import { useAction, useLiveState } from './useStore';

export function ThemeToggle() {
  const { settings } = useLiveState();
  const action = useAction();

  const isDark = () => currentTheme(settings()) === 'dark';
  const label = () => (isDark() ? '切换到浅色模式' : '切换到深色模式');

  const toggle = () =>
    action.run(() =>
      sendRequest({ type: 'settings:set', patch: { theme: toggledTheme(settings()) } }),
    );

  return (
    <button
      type="button"
      title={label()}
      aria-label={label()}
      disabled={action.busy()}
      onClick={toggle}
      class="inline-flex h-7 w-7 items-center justify-center rounded-md text-ink-soft transition hover:bg-surface-raised disabled:opacity-50"
    >
      <Show when={isDark()} fallback={<MoonIcon />}>
        <SunIcon />
      </Show>
    </button>
  );
}

function SunIcon() {
  return (
    <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
    </svg>
  );
}
