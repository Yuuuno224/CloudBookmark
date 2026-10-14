/**
 * 界面文案与时间格式化
 * ====================
 *
 * 所有"把数据变成中文句子"的逻辑集中在这里，
 * 想改提示语只需要改这一个文件。
 */

import type { ChangeAction, ChangeCounts, SyncMode, SyncState, SyncStatus } from '@/core/types';
import type { Tone } from './tone';

/** "3 分钟前" 这种相对时间；超过一天就显示日期。 */
export function relativeTime(iso: string | null): string {
  if (!iso) return '从未';
  const time = new Date(iso).getTime();
  if (!Number.isFinite(time)) return '未知';
  const diff = Date.now() - time;
  if (diff < 0) return '刚刚';

  const seconds = Math.floor(diff / 1000);
  if (seconds < 45) return '刚刚';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return absoluteTime(iso);
}

export function absoluteTime(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function exactTime(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('zh-CN', { hour12: false });
}

export function formatAction(action: ChangeAction): string {
  switch (action) {
    case 'create':
      return '新增';
    case 'remove':
      return '删除';
    case 'update':
      return '修改';
    case 'move':
      return '移动';
  }
}

export function actionTone(action: ChangeAction): Tone {
  switch (action) {
    case 'create':
      return 'success';
    case 'remove':
      return 'danger';
    case 'update':
      return 'info';
    case 'move':
      return 'warn';
  }
}

export function formatMode(mode: SyncMode): string {
  switch (mode) {
    case 'merge':
      return '合并同步';
    case 'push':
      return '上传覆盖';
    case 'pull':
      return '下载覆盖';
  }
}

/** 把改动量变成一句人话，只列非零项。 */
export function formatCounts(counts: ChangeCounts): string {
  const parts: string[] = [];
  if (counts.added > 0) parts.push(`新增 ${counts.added}`);
  if (counts.updated > 0) parts.push(`修改 ${counts.updated}`);
  if (counts.moved > 0) parts.push(`移动 ${counts.moved}`);
  if (counts.removed > 0) parts.push(`删除 ${counts.removed}`);
  return parts.length > 0 ? parts.join('、') : '没有变化';
}

export interface StatusDescriptor {
  text: string;
  tone: Tone;
  detail: string;
}

export function describeStatus(state: SyncState): StatusDescriptor {
  if (state.status === 'syncing') {
    return { text: '正在同步', tone: 'info', detail: state.phase ?? '处理中…' };
  }
  switch (state.status) {
    case 'unconfigured':
      return { text: '未配置', tone: 'default', detail: '还没配置 GitHub 授权' };
    case 'conflict':
      return {
        text: `${state.conflictCount} 个冲突`,
        tone: 'warn',
        detail: '需要你决定保留哪一边',
      };
    case 'error':
      return { text: '同步出错', tone: 'danger', detail: state.lastError ?? '未知错误' };
    default:
      if (!state.lastSyncAt) {
        return { text: '尚未同步', tone: 'default', detail: '点击"立即同步"开始' };
      }
      return {
        text: state.dirty ? '有未同步的改动' : '已同步',
        tone: state.dirty ? 'warn' : 'success',
        detail: `上次同步：${relativeTime(state.lastSyncAt)}`,
      };
  }
}

export function statusLabel(status: SyncStatus): string {
  switch (status) {
    case 'unconfigured':
      return '未配置 Token';
    case 'syncing':
      return '同步中';
    case 'conflict':
      return '等待处理冲突';
    case 'error':
      return '出错';
    default:
      return '正常';
  }
}

/** 冲突字段名 → 中文。 */
export function formatConflictField(field: string): string {
  switch (field) {
    case 'title':
      return '标题';
    case 'url':
      return '网址';
    case 'parent':
      return '所在文件夹';
    case 'kind':
      return '类型';
    default:
      return field;
  }
}
