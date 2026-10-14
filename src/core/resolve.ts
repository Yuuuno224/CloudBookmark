/**
 * 冲突解决
 * ========
 *
 * 当"两边都改了同一件事"或者"一边删一边改"时，合并会先给一个默认答案，
 * 同时把冲突记下来。如果用户选择"询问我"，同步就会暂停，
 * 把结果存在本地，等用户在界面上逐条选择之后再真正写回浏览器。
 *
 * 这个文件负责：把用户的选择套用到合并结果上。
 */

import { describeEntry, entryMap, repairHierarchy } from './entries';
import { newUid } from './ids';
import type { Conflict, Entry, MergeWarning, Resolution } from './types';

export interface ResolveResult {
  entries: Entry[];
  warnings: MergeWarning[];
}

/**
 * 把用户的选择应用到"自动合并结果"上。
 *
 * 每个冲突的处理：
 *  - local  采用本地的版本（本地是"删除了"就删除）
 *  - remote 采用远端的版本（远端是"删除了"就删除）
 *  - both   两边都留：书签会额外生成一份副本；文件夹不支持，退化为 local
 */
export function applyResolutions(
  merged: Entry[],
  conflicts: Conflict[],
  resolutions: Record<string, Resolution>,
): ResolveResult {
  const map = entryMap(merged);
  const warnings: MergeWarning[] = [];
  const extra: Entry[] = [];

  for (const conflict of conflicts) {
    const choice: Resolution = resolutions[conflict.id] ?? 'remote';
    const { local, remote } = conflict;

    if (choice === 'local') {
      if (local) map.set(conflict.uid, local);
      else map.delete(conflict.uid);
      continue;
    }

    if (choice === 'remote') {
      if (remote) map.set(conflict.uid, remote);
      else map.delete(conflict.uid);
      continue;
    }

    // ---- both ----
    if (local && remote) {
      map.set(conflict.uid, local);
      if (local.kind === 'bookmark' && remote.kind === 'bookmark') {
        extra.push({
          ...remote,
          uid: newUid(),
          index: remote.index + 1,
          title: copyTitle(remote.title),
        });
      } else {
        warnings.push({
          code: 'both-folder-degraded',
          message: `「${describeEntry(local)}」是文件夹，"保留两者"只保留了本地的一份。`,
          uids: [conflict.uid],
        });
      }
    } else if (remote) {
      // 本地删了、远端改了 → "两者都留" = 把远端那份留下来
      map.set(conflict.uid, remote);
    } else if (local) {
      map.set(conflict.uid, local);
    } else {
      map.delete(conflict.uid);
    }
  }

  const repaired = repairHierarchy([...map.values(), ...extra]);
  warnings.push(...repaired.warnings);

  return { entries: repaired.entries, warnings };
}

function copyTitle(title: string): string {
  const base = title.trim() || '(未命名)';
  return `${base}（远端副本）`;
}

/** 界面上的"全部保留本地 / 全部使用远端"按钮用这个。 */
export function uniformResolutions(
  conflicts: Conflict[],
  choice: 'local' | 'remote',
): Record<string, Resolution> {
  const out: Record<string, Resolution> = {};
  for (const conflict of conflicts) out[conflict.id] = choice;
  return out;
}

/** 冲突在界面上该显示哪几种按钮。 */
export function availableResolutions(conflict: Conflict): Resolution[] {
  if (conflict.kind === 'delete-modify') {
    // 一边已经删了，"保留两者"没有意义
    return ['local', 'remote'];
  }
  const isBookmark = conflict.local?.kind === 'bookmark' || conflict.remote?.kind === 'bookmark';
  return isBookmark ? ['local', 'remote', 'both'] : ['local', 'remote'];
}

/** 给按钮配文案，避免用户看着"本地/远端"猜意思。 */
export function resolveLabels(conflict: Conflict): Array<{ value: Resolution; label: string; hint: string }> {
  if (conflict.kind === 'delete-modify') {
    if (conflict.local === null) {
      return [
        { value: 'local', label: '确认删除', hint: '按本地现状，把这条书签删掉' },
        { value: 'remote', label: '保留远端修改', hint: '不删除，保留远端改过的版本' },
      ];
    }
    return [
      { value: 'local', label: '保留本地修改', hint: '不删除，保留本地改过的版本' },
      { value: 'remote', label: '确认删除', hint: '按远端现状，把这条书签删掉' },
    ];
  }
  const labels = [
    { value: 'local' as Resolution, label: '保留本地', hint: '用本地这一份' },
    { value: 'remote' as Resolution, label: '使用远端', hint: '用远端那一份' },
  ];
  if (conflict.local?.kind === 'bookmark') {
    labels.push({ value: 'both', label: '两者都留', hint: '本地保留，另外新建一份远端版本' });
  }
  return labels;
}

/** 冲突里两边各自"改了什么"，用于界面展示差异。 */
export interface FieldDiff {
  field: '标题' | '网址' | '所在文件夹' | '类型';
  base: string;
  local: string;
  remote: string;
  conflicted: boolean;
}

export function describeConflict(conflict: Conflict): FieldDiff[] {
  const b = conflict.base;
  const l = conflict.local;
  const r = conflict.remote;
  const diffs: FieldDiff[] = [];

  const add = (
    field: FieldDiff['field'],
    key: 'title' | 'url' | 'parentUid' | 'kind',
    format: (entry: Entry) => string,
  ) => {
    const localValue = l ? format(l) : '(已删除)';
    const remoteValue = r ? format(r) : '(已删除)';
    const baseValue = b ? format(b) : '(不存在)';
    if (localValue === remoteValue) return;
    diffs.push({
      field,
      base: baseValue,
      local: localValue,
      remote: remoteValue,
      conflicted: conflict.kind === 'fields' || b !== null,
    });
  };

  const kindText = (entry: Entry) => (entry.kind === 'folder' ? '文件夹' : '书签');
  add('类型', 'kind', kindText);
  add('标题', 'title', (entry) => entry.title || '(空)');
  add('网址', 'url', (entry) => entry.url || '(无)');
  add('所在文件夹', 'parentUid', (entry) => entry.parentUid || '(根目录)');

  return diffs;
}

/** 从待同步记录里取出冲突列表，方便界面理解上下文。 */
export function conflictsFromPending(
  pending: { conflicts: Conflict[] } | null,
): Conflict[] {
  return pending?.conflicts ?? [];
}
