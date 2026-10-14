/**
 * 界面上的小零件
 * ==============
 *
 * 这里全是"无状态"的展示组件：给它属性，它渲染出来。
 * 把它们抽出来的目的是让各个标签页的代码读起来像 HTML，
 * 而不是被一堆重复的 Tailwind 类名淹没。
 *
 * 关于颜色：这里一律使用**语义化类名**（`bg-surface`、`text-ink`、`border-line`…），
 * 而不是 `bg-white`、`text-slate-800` 这种具体色值。
 * 具体色值定义在 src/ui/styles.css 的 CSS 变量里，浅色/深色各一套。
 * 所以这些组件不需要写任何 `dark:` 前缀就能自动适配深色模式。
 */

import { For, Show, type JSX } from 'solid-js';
import type { Tone } from './tone';

// ---------------------------------------------------------------------------
// 卡片
// ---------------------------------------------------------------------------

/** 各种语义色调对应的底色 / 文字色 / 边框色类名。 */
const TONE_SURFACE: Record<Tone, string> = {
  default: 'border-line bg-surface',
  info: 'border-accent-line bg-accent-soft',
  warn: 'border-warn-line bg-warn-soft',
  danger: 'border-danger-line bg-danger-soft',
  success: 'border-success-line bg-success-soft',
};

/** 小圆点、徽章这类实心元素的颜色（深浅模式下都用同一个固定色）。 */
const TONE_SOLID: Record<Tone, string> = {
  default: 'bg-ink-faint',
  info: 'bg-blue-500',
  warn: 'bg-amber-500',
  danger: 'bg-red-500',
  success: 'bg-emerald-500',
};

const TONE_TEXT: Record<Tone, string> = {
  default: 'text-ink-soft',
  info: 'text-accent-ink',
  warn: 'text-warn-ink',
  danger: 'text-danger-ink',
  success: 'text-success-ink',
};

export function Card(props: {
  title?: string;
  hint?: string;
  actions?: JSX.Element;
  children: JSX.Element;
  tone?: Tone;
}) {
  return (
    <section class={`rounded-lg border shadow-sm ${TONE_SURFACE[props.tone ?? 'default']}`}>
      <Show when={props.title || props.actions}>
        <header class="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
          <div class="min-w-0">
            <h2 class="text-sm font-semibold text-ink">{props.title}</h2>
            <Show when={props.hint}>
              <p class="mt-0.5 text-xs leading-relaxed text-ink-soft">{props.hint}</p>
            </Show>
          </div>
          <Show when={props.actions}>
            <div class="shrink-0">{props.actions}</div>
          </Show>
        </header>
      </Show>
      <div class="px-4 py-3">{props.children}</div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// 按钮
// ---------------------------------------------------------------------------

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success';

export function Button(props: {
  children: JSX.Element;
  onClick?: () => void;
  variant?: ButtonVariant;
  size?: 'sm' | 'md';
  disabled?: boolean;
  loading?: boolean;
  title?: string;
  full?: boolean;
}) {
  const variantClass = () => {
    switch (props.variant ?? 'secondary') {
      case 'primary':
        return 'bg-brand text-white hover:bg-brand-hover disabled:bg-surface-raised disabled:text-ink-faint';
      case 'danger':
        return 'bg-red-600 text-white hover:bg-red-700 disabled:bg-surface-raised disabled:text-ink-faint';
      case 'success':
        return 'bg-emerald-600 text-white hover:bg-emerald-700 disabled:bg-surface-raised disabled:text-ink-faint';
      case 'ghost':
        return 'text-ink-soft hover:bg-surface-raised disabled:text-ink-faint';
      default:
        return 'bg-surface text-ink border border-line hover:bg-surface-raised disabled:text-ink-faint';
    }
  };

  const sizeClass = () => (props.size === 'sm' ? 'px-2.5 py-1 text-xs' : 'px-3.5 py-2 text-sm');

  return (
    <button
      type="button"
      title={props.title}
      disabled={props.disabled || props.loading}
      onClick={() => props.onClick?.()}
      class={`inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition disabled:cursor-not-allowed ${sizeClass()} ${variantClass()} ${props.full ? 'w-full' : ''}`}
    >
      <Show when={props.loading}>
        <Spinner />
      </Show>
      {props.children}
    </button>
  );
}

export function Spinner() {
  return (
    <svg class="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3" class="opacity-25" />
      <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" stroke-width="3" stroke-linecap="round" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// 状态标记
// ---------------------------------------------------------------------------

export function Pill(props: { tone?: Tone; children: JSX.Element }) {
  const tone = () => props.tone ?? 'default';
  return (
    <span
      class={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
        tone() === 'default' ? 'bg-surface-raised text-ink-soft' : `${TONE_SURFACE[tone()]} ${TONE_TEXT[tone()]}`
      }`}
    >
      {props.children}
    </span>
  );
}

export function Dot(props: { tone?: Tone }) {
  return <span class={`inline-block h-2 w-2 shrink-0 rounded-full ${TONE_SOLID[props.tone ?? 'default']}`} />;
}

// ---------------------------------------------------------------------------
// 表单
// ---------------------------------------------------------------------------

export function Field(props: {
  label: string;
  hint?: string;
  children: JSX.Element;
  error?: string | null;
}) {
  return (
    <label class="block">
      <span class="block text-sm font-medium text-ink">{props.label}</span>
      <Show when={props.hint}>
        <span class="mt-0.5 block text-xs leading-relaxed text-ink-soft">{props.hint}</span>
      </Show>
      <div class="mt-1.5">{props.children}</div>
      <Show when={props.error}>
        <span class="mt-1 block text-xs text-danger-ink">{props.error}</span>
      </Show>
    </label>
  );
}

export function TextInput(props: {
  value: string;
  onInput: (value: string) => void;
  type?: string;
  placeholder?: string;
  disabled?: boolean;
  monospace?: boolean;
}) {
  return (
    <input
      type={props.type ?? 'text'}
      value={props.value}
      placeholder={props.placeholder}
      disabled={props.disabled}
      spellcheck={false}
      autocomplete="off"
      onInput={(event) => props.onInput(event.currentTarget.value)}
      class={`w-full rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink outline-none transition placeholder:text-ink-faint focus:border-brand focus:ring-2 focus:ring-brand/25 disabled:bg-surface-raised ${props.monospace ? 'font-mono' : ''}`}
    />
  );
}

export function Select<T extends string | number>(props: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <select
      disabled={props.disabled}
      value={String(props.value)}
      onChange={(event) => {
        const raw = event.currentTarget.value;
        const found = props.options.find((option) => String(option.value) === raw);
        if (found) props.onChange(found.value);
      }}
      class="w-full rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink outline-none transition focus:border-brand focus:ring-2 focus:ring-brand/25 disabled:bg-surface-raised"
    >
      <For each={props.options}>
        {(option) => <option value={String(option.value)}>{option.label}</option>}
      </For>
    </select>
  );
}

export function Toggle(props: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <div class="flex items-start justify-between gap-4 py-2">
      <div class="min-w-0">
        <p class="text-sm font-medium text-ink">{props.label}</p>
        <Show when={props.hint}>
          <p class="mt-0.5 text-xs leading-relaxed text-ink-soft">{props.hint}</p>
        </Show>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={props.checked}
        disabled={props.disabled}
        onClick={() => props.onChange(!props.checked)}
        class={`relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition disabled:opacity-50 ${props.checked ? 'bg-brand' : 'bg-line'}`}
      >
        <span
          class={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ${props.checked ? 'left-[1.125rem]' : 'left-0.5'}`}
        />
      </button>
    </div>
  );
}

/** 分段选择器：几个选项并排放，选中的高亮。用于主题选择这类小选择。 */
export function SegmentedControl<T extends string>(props: {
  value: T;
  options: Array<{ value: T; label: string; title?: string }>;
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <div class="inline-flex rounded-md border border-line bg-surface-raised p-0.5">
      <For each={props.options}>
        {(option) => (
          <button
            type="button"
            title={option.title}
            disabled={props.disabled}
            onClick={() => props.onChange(option.value)}
            class={`rounded px-3 py-1 text-xs font-medium transition disabled:cursor-not-allowed ${
              props.value === option.value
                ? 'bg-surface text-ink shadow-sm'
                : 'text-ink-soft hover:text-ink'
            }`}
          >
            {option.label}
          </button>
        )}
      </For>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 提示条
// ---------------------------------------------------------------------------

export function Banner(props: {
  tone?: 'info' | 'warn' | 'danger' | 'success';
  title?: string;
  children?: JSX.Element;
  action?: JSX.Element;
}) {
  const tone = (): Tone => props.tone ?? 'info';
  return (
    <div
      class={`flex items-start justify-between gap-3 rounded-md border px-3 py-2 text-sm ${TONE_SURFACE[tone()]} ${TONE_TEXT[tone()]}`}
    >
      <div class="min-w-0">
        <Show when={props.title}>
          <p class="font-medium">{props.title}</p>
        </Show>
        <Show when={props.children}>
          <div class="text-xs leading-relaxed [&_p]:mt-0.5">{props.children}</div>
        </Show>
      </div>
      <Show when={props.action}>
        <div class="shrink-0">{props.action}</div>
      </Show>
    </div>
  );
}

export function EmptyState(props: { children: JSX.Element }) {
  return <p class="py-6 text-center text-xs text-ink-faint">{props.children}</p>;
}

export function KeyValue(props: { label: string; children: JSX.Element }) {
  return (
    <div class="flex items-baseline justify-between gap-3 py-1 text-sm">
      <span class="shrink-0 text-ink-soft">{props.label}</span>
      <span class="min-w-0 truncate text-right text-ink">{props.children}</span>
    </div>
  );
}

/**
 * 二次确认条。
 * 危险操作（覆盖远端 / 覆盖本地 / 删除）都先经过它，
 * 避免"手滑点一下就没了"。
 */
export function ConfirmBar(props: {
  message: string;
  confirmLabel: string;
  tone?: 'danger' | 'primary';
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
}) {
  return (
    <div class="rounded-md border border-warn-line bg-warn-soft p-3">
      <p class="text-xs leading-relaxed text-warn-ink">{props.message}</p>
      <div class="mt-2 flex gap-2">
        <Button
          size="sm"
          variant={props.tone === 'danger' ? 'danger' : 'primary'}
          onClick={props.onConfirm}
          loading={props.busy}
        >
          {props.confirmLabel}
        </Button>
        <Button size="sm" variant="ghost" onClick={props.onCancel} disabled={props.busy}>
          取消
        </Button>
      </div>
    </div>
  );
}
