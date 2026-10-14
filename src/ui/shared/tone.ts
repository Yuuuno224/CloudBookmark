/**
 * 语义色调
 * ========
 *
 * 界面上所有"带颜色的状态"都只用这五种语义，而不是具体颜色名。
 *
 * 好处：`format.ts`（算状态）和 `components.tsx`（画颜色）之间
 * 不再需要翻译层。以前 format 返回 'green'/'gray'，组件里再映射成
 * 绿色/灰色，两边各写一套，改配色时容易漏掉一边。
 *
 * 具体长什么样由 CSS 变量 + Tailwind 配置决定，见 styles.css。
 */
export type Tone = 'default' | 'info' | 'warn' | 'danger' | 'success';
