/**
 * 主题（浅色 / 深色）切换
 * ======================
 *
 * ## 原理
 *
 * 所有颜色都写在 CSS 变量里（见 `src/ui/styles.css`），
 * 变换主题 = 在 `<html>` 上换一个类名：
 *
 *   `<html class="dark">`  → 深色
 *   `<html class="light">` → 浅色
 *   `<html>`（没有类）      → 跟随系统
 *
 * 组件里写的是 `bg-surface`、`text-ink` 这种语义化类名，
 * 它们指向变量，所以切换类名的那一刻整个界面就变色了，
 * 不需要重新渲染任何组件。
 *
 * ## 为什么要往 localStorage 里也存一份
 *
 * `chrome.storage.local` 是异步读取的。如果等它读完再套主题，
 * 打开弹窗时会先闪一下错误的颜色。localStorage 是同步的，
 * 所以 `index.tsx` 在 render() 之前先用它把类名套上，避免闪屏。
 */

import { createEffect, onCleanup, onMount } from 'solid-js';
import type { Settings, ThemeMode } from '@/core/types';

/** 同步缓存用的键名（和 chrome.storage 无关，只为了让首屏不闪）。 */
const CACHE_KEY = 'cloudbookmark:theme';

/** localStorage 在隐私模式等场景可能不可用，所有访问都要兜住。 */
function readCache(): 'light' | 'dark' | null {
  try {
    const value = localStorage.getItem(CACHE_KEY);
    return value === 'light' || value === 'dark' ? value : null;
  } catch {
    return null;
  }
}

function writeCache(resolved: 'light' | 'dark'): void {
  try {
    localStorage.setItem(CACHE_KEY, resolved);
  } catch {
    /* 忽略 */
  }
}

/** 把解析好的明暗套到 <html> 上。 */
function applyResolved(resolved: 'light' | 'dark'): void {
  const root = document.documentElement;
  const changed = root.classList.contains('dark') !== (resolved === 'dark');

  root.classList.toggle('dark', resolved === 'dark');
  root.classList.toggle('light', resolved === 'light');

  if (changed) {
    // 切换瞬间临时关掉过渡动画，避免按钮颜色"慢慢爬过去"
    root.classList.add('theme-switching');
    requestAnimationFrame(() => root.classList.remove('theme-switching'));
  }

  writeCache(resolved);
}

/** 把设置里的主题模式解析成"到底是浅色还是深色"。 */
export function resolveTheme(mode: ThemeMode): 'light' | 'dark' {
  if (mode === 'dark') return 'dark';
  if (mode === 'light') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function applyTheme(mode: ThemeMode): void {
  applyResolved(resolveTheme(mode));
}

/**
 * 在 `render()` 之前同步调用一次，用上次记住的结果先把颜色套上，
 * 这样打开界面时不会闪。之后 useApplyTheme 会用真实设置纠正它。
 */
export function applyCachedTheme(): void {
  const cached = readCache();
  if (cached) applyResolved(cached);
}

/**
 * 让主题跟着设置走。
 *
 * 在组件的顶层调用一次即可：
 * ```tsx
 * const { settings } = useLiveState();
 * useApplyTheme(settings);
 * ```
 */
export function useApplyTheme(settings: () => Settings): void {
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const sync = () => applyTheme(settings().theme);

  // createEffect 会跟踪 settings()，设置一改就重新套主题
  createEffect(sync);

  onMount(() => {
    // 选择"跟随系统"时，系统主题变了要立刻跟着变
    const onSystemChange = () => {
      if (settings().theme === 'system') sync();
    };
    media.addEventListener('change', onSystemChange);
    onCleanup(() => media.removeEventListener('change', onSystemChange));
  });
}

/** 当前实际显示的是深色还是浅色（给按钮上的图标用）。 */
export function currentTheme(settings: Settings): 'light' | 'dark' {
  return resolveTheme(settings.theme);
}

/** 一键切换：把主题固定成"当前外观的反面"。 */
export function toggledTheme(settings: Settings): ThemeMode {
  return currentTheme(settings) === 'dark' ? 'light' : 'dark';
}
