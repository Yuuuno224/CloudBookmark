/** 标签页的名字。放在单独文件里，方便各个标签页互相跳转时不产生循环依赖。 */
export type TabKey = 'overview' | 'conflicts' | 'history' | 'data' | 'settings' | 'help';

export const TAB_LABELS: Array<{ key: TabKey; label: string }> = [
  { key: 'overview', label: '总览' },
  { key: 'conflicts', label: '冲突' },
  { key: 'history', label: '历史' },
  { key: 'data', label: '数据' },
  { key: 'settings', label: '设置' },
  { key: 'help', label: '帮助' },
];

export function isTabKey(value: string): value is TabKey {
  return TAB_LABELS.some((tab) => tab.key === value);
}
