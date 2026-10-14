/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{ts,tsx,html}'],
  // 深色模式靠 <html> 上的 .dark 类切换（而不是直接用系统的 prefers-color-scheme），
  // 这样"跟随系统 / 强制浅色 / 强制深色"三种选择都能实现。
  darkMode: 'class',
  theme: {
    extend: {
      /**
       * 语义化颜色。
       *
       * 这里不写死具体色值，而是指向 CSS 变量（定义在 src/ui/styles.css）。
       * 好处是：换主题只需要改那一处变量，组件里始终写 bg-surface / text-ink
       * 这种"这个颜色是用来干什么的"，而不是 bg-white / text-slate-800
       * 这种"这个颜色长什么样"。以后调色也不会漏掉某个角落。
       *
       * 命名约定：
       *   surface-*  背景
       *   ink-*      文字
       *   line       边框/分隔线
       *   *-soft     某个语义色的浅底色（卡片背景、警告条）
       *   *-ink      配在 *-soft 上的文字色
       *   *-line     配在 *-soft 上的边框色
       */
      colors: {
        /** 卡片、面板的背景 */
        surface: 'var(--cb-surface)',
        /** 页面最底层背景（衬托卡片） */
        'surface-sunken': 'var(--cb-surface-sunken)',
        /** 次级背景：表头、输入框、代码块 */
        'surface-raised': 'var(--cb-surface-raised)',
        /** 边框、分隔线 */
        line: 'var(--cb-line)',

        /** 主要文字 */
        ink: 'var(--cb-ink)',
        /** 次要文字 */
        'ink-soft': 'var(--cb-ink-soft)',
        /** 弱化文字：时间戳、辅助说明 */
        'ink-faint': 'var(--cb-ink-faint)',

        /** 主色：按钮、链接 */
        brand: 'var(--cb-brand)',
        'brand-hover': 'var(--cb-brand-hover)',

        /** 信息色（蓝）—— 也用于冲突对比里的"本地"一列 */
        'accent-soft': 'var(--cb-accent-soft)',
        'accent-ink': 'var(--cb-accent-ink)',
        'accent-line': 'var(--cb-accent-line)',
        /** 第二强调色（紫）—— 用于冲突对比里的"远端"一列 */
        'alt-soft': 'var(--cb-alt-soft)',
        'alt-ink': 'var(--cb-alt-ink)',
        'alt-line': 'var(--cb-alt-line)',
        /** 警告色（琥珀） */
        'warn-soft': 'var(--cb-warn-soft)',
        'warn-ink': 'var(--cb-warn-ink)',
        'warn-line': 'var(--cb-warn-line)',
        /** 危险色（红） */
        'danger-soft': 'var(--cb-danger-soft)',
        'danger-ink': 'var(--cb-danger-ink)',
        'danger-line': 'var(--cb-danger-line)',
        /** 成功色（绿） */
        'success-soft': 'var(--cb-success-soft)',
        'success-ink': 'var(--cb-success-ink)',
        'success-line': 'var(--cb-success-line)',
      },
    },
  },
  plugins: [],
};
