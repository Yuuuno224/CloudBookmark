/**
 * 扩展图标上的小徽章
 * ================
 *
 * 不用打开弹窗就能看到状态：
 *   （空）  正常
 *   …      正在同步
 *   3      有 3 个冲突等你处理
 *   !      上次同步出错
 */

import type { SyncState } from '@/core/types';

export async function refreshBadge(state: SyncState): Promise<void> {
  let text = '';
  let color = '#2563eb';
  let title = 'CloudBookmark';

  switch (state.status) {
    case 'syncing':
      text = '…';
      color = '#2563eb';
      title = `CloudBookmark 正在同步：${state.phase ?? ''}`;
      break;
    case 'conflict':
      text = state.conflictCount > 99 ? '99+' : String(state.conflictCount || '!');
      color = '#f97316';
      title = `CloudBookmark 有 ${state.conflictCount} 个冲突需要处理（点击打开）`;
      break;
    case 'error':
      text = '!';
      color = '#dc2626';
      title = `CloudBookmark 同步出错：${state.lastError ?? ''}`;
      break;
    case 'unconfigured':
      text = '';
      title = 'CloudBookmark 还没配置 Token（点击打开设置）';
      break;
    default:
      text = '';
      color = '#16a34a';
      title = state.lastSyncAt
        ? `CloudBookmark 上次同步：${new Date(state.lastSyncAt).toLocaleString('zh-CN')}`
        : 'CloudBookmark 尚未同步';
      break;
  }

  try {
    await chrome.action.setBadgeText({ text });
    await chrome.action.setBadgeBackgroundColor({ color });
    await chrome.action.setTitle({ title });
  } catch {
    // 图标被移除等极端情况，忽略
  }
}
