/**
 * 书签记录的通用操作 + 层级修复
 * ==============================
 *
 * 这里全是纯函数：给同样的输入，永远得到同样的输出，不碰浏览器 API，
 * 所以可以放心用单元测试把边界情况全部覆盖。
 */

import { nowIso } from './ids';
import type { Entry, MergeWarning } from './types';
import { VIRTUAL_ROOT_UID, rootUid } from './types';

/** uid -> Entry 的索引表。重复 uid 只保留第一个。 */
export function entryMap(entries: Entry[]): Map<string, Entry> {
  const map = new Map<string, Entry>();
  for (const entry of entries) {
    if (!map.has(entry.uid)) map.set(entry.uid, entry);
  }
  return map;
}

/**
 * 内容是否相同。
 * 刻意不比较 index 和时间戳：排序单独处理，时间戳不参与"改没改"的判断，
 * 否则每次同步都因为时间戳变化而被误判成"用户改了"。
 *
 * 注意：这里 **包含** parentUid，因为"换文件夹"对合并来说是必须感知的改动。
 * 仅仅想比较"标题/网址变了没有"请用 bodyEquals()。
 */
export function contentEquals(a: Entry, b: Entry): boolean {
  return (
    a.kind === b.kind &&
    a.title === b.title &&
    a.url === b.url &&
    a.parentUid === b.parentUid
  );
}

/** 只比较"标题 / 网址 / 种类"，不含所在文件夹和排序。用于把"更新"和"移动"分开统计。 */
export function bodyEquals(a: Entry, b: Entry): boolean {
  return a.kind === b.kind && a.title === b.title && a.url === b.url;
}

/** 按 index 排序；index 相同时用 uid 兜底，保证结果稳定可复现。 */
export function compareByIndex(a: Entry, b: Entry): number {
  if (a.index !== b.index) return a.index - b.index;
  return a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0;
}

/** 稳定排序：先按父亲分组，组内按 index。序列化前用它保证输出可复现。 */
export function sortEntries(entries: Entry[]): Entry[] {
  return [...entries].sort((a, b) => {
    if (a.parentUid !== b.parentUid) return a.parentUid < b.parentUid ? -1 : 1;
    return compareByIndex(a, b);
  });
}

/** 按父亲分组，组内已按 index 排好序。 */
export function groupByParent(entries: Entry[]): Map<string, Entry[]> {
  const groups = new Map<string, Entry[]>();
  for (const entry of entries) {
    const list = groups.get(entry.parentUid);
    if (list) list.push(entry);
    else groups.set(entry.parentUid, [entry]);
  }
  for (const list of groups.values()) list.sort(compareByIndex);
  return groups;
}

/** 某个父亲下孩子的 uid 顺序。 */
export function childrenOrder(entries: Entry[], parentUid: string): string[] {
  return entries
    .filter((entry) => entry.parentUid === parentUid)
    .sort(compareByIndex)
    .map((entry) => entry.uid);
}

/** 把每个父亲下的 index 重新编号成 0..n-1，并返回稳定排序后的数组。 */
export function normalizeIndexes(entries: Entry[]): Entry[] {
  const groups = groupByParent(entries);
  const out: Entry[] = [];
  for (const list of groups.values()) {
    list.forEach((entry, i) => {
      out.push(entry.index === i ? entry : { ...entry, index: i });
    });
  }
  return sortEntries(out);
}

/** 收集某节点（不含自己）的所有后代 uid。 */
export function collectSubtreeUids(entries: Entry[], uid: string): Set<string> {
  const byParent = groupByParent(entries);
  const result = new Set<string>();
  const stack = [...(byParent.get(uid) ?? [])];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (result.has(node.uid)) continue;
    result.add(node.uid);
    stack.push(...(byParent.get(node.uid) ?? []));
  }
  return result;
}

/** 选出"找不到父亲时挂到哪里"的兜底根目录。 */
function pickFallbackRoot(entries: Entry[], preferred?: string): string {
  const roots = entries.filter((entry) => entry.parentUid === VIRTUAL_ROOT_UID);
  if (preferred && roots.some((root) => root.uid === preferred)) return preferred;
  const other = roots.find((root) => root.uid === rootUid(1));
  if (other) return other.uid;
  const first = [...roots].sort(compareByIndex)[0];
  return first ? first.uid : VIRTUAL_ROOT_UID;
}

/**
 * 修复层级，保证结果是"一棵合法的森林"。
 *
 * 会处理三种脏数据：
 *  1. 父亲 uid 不存在的孤儿节点 → 挂到兜底根目录（默认"其他书签"）。
 *  2. 互相做父亲的环 → 把环上节点挂到兜底根目录。
 *  3. index 乱序或重复 → 重新编号。
 *
 * 关键原则：**宁可挂错地方，也绝不丢数据**。
 */
export function repairHierarchy(
  entries: Entry[],
  preferredRootUid?: string,
): { entries: Entry[]; warnings: MergeWarning[] } {
  const warnings: MergeWarning[] = [];
  const fixed = new Map<string, Entry>();
  for (const entry of entries) {
    if (!fixed.has(entry.uid)) fixed.set(entry.uid, entry);
  }

  const current = () => [...fixed.values()];
  const fallback = pickFallbackRoot(current(), preferredRootUid);

  // ---- 1. 孤儿节点 ----
  const orphaned: string[] = [];
  for (const entry of [...fixed.values()]) {
    if (entry.parentUid === VIRTUAL_ROOT_UID) continue;
    if (fixed.has(entry.parentUid)) continue;
    fixed.set(entry.uid, { ...entry, parentUid: fallback });
    orphaned.push(entry.uid);
  }
  if (orphaned.length > 0) {
    warnings.push({
      code: 'orphan-reattached',
      message: `有 ${orphaned.length} 个书签的上级文件夹不存在，已临时挂到「其他书签」下（没有丢失）。`,
      uids: orphaned,
    });
  }

  // ---- 2. 环 ----
  const cycles: string[] = [];
  for (const entry of [...fixed.values()]) {
    const seen = new Set<string>([entry.uid]);
    let cursor: Entry | undefined = fixed.get(entry.parentUid);
    let steps = 0;
    let broken = false;
    while (cursor) {
      if (cursor.parentUid === VIRTUAL_ROOT_UID) break;
      if (seen.has(cursor.uid)) {
        broken = true;
        break;
      }
      seen.add(cursor.uid);
      steps += 1;
      if (steps > fixed.size + 2) {
        broken = true;
        break;
      }
      cursor = fixed.get(cursor.parentUid);
    }
    if (broken) {
      fixed.set(entry.uid, { ...entry, parentUid: fallback });
      cycles.push(entry.uid);
    }
  }
  if (cycles.length > 0) {
    warnings.push({
      code: 'cycle-broken',
      message: `检测到 ${cycles.length} 个文件夹互相嵌套成环，已把它们提到「其他书签」下（没有丢失）。`,
      uids: cycles,
    });
  }

  return { entries: normalizeIndexes([...fixed.values()]), warnings };
}

/** 一个已经组装好的树节点，供界面递归渲染。 */
export interface TreeNode extends Entry {
  children: TreeNode[];
}

/**
 * 把扁平列表组装成树。
 * 要求传入的列表已经过 repairHierarchy 处理，否则父亲不存在的节点会被丢掉。
 */
export function buildTree(entries: Entry[]): TreeNode[] {
  const nodes = new Map<string, TreeNode>();
  for (const entry of entries) nodes.set(entry.uid, { ...entry, children: [] });

  const roots: TreeNode[] = [];
  for (const entry of entries) {
    const node = nodes.get(entry.uid);
    if (!node) continue;
    if (entry.parentUid === VIRTUAL_ROOT_UID) roots.push(node);
    else nodes.get(entry.parentUid)?.children.push(node);
  }

  const sortDeep = (list: TreeNode[]) => {
    list.sort(compareByIndex);
    for (const node of list) sortDeep(node.children);
  };
  sortDeep(roots);
  return roots;
}

/** 修复 + 组树，界面里最常用的组合。 */
export function buildRepairedTree(entries: Entry[]): TreeNode[] {
  return buildTree(repairHierarchy(entries).entries);
}

/** 计算某个节点的深度（根目录为 0），用于界面缩进。 */
export function depthOf(entries: Entry[], uid: string): number {
  const map = entryMap(entries);
  let depth = 0;
  let cursor = map.get(uid);
  while (cursor && cursor.parentUid !== VIRTUAL_ROOT_UID) {
    depth += 1;
    cursor = map.get(cursor.parentUid);
    if (depth > 512) break;
  }
  return depth;
}

/** 给界面/日志用的简短描述。 */
export function describeEntry(entry: Pick<Entry, 'kind' | 'title' | 'url'>): string {
  if (entry.kind === 'folder') return entry.title || '(未命名文件夹)';
  return entry.title || entry.url || '(未命名书签)';
}

/** 统计条数。 */
export function countKinds(entries: Entry[]): { folders: number; bookmarks: number; total: number } {
  let folders = 0;
  let bookmarks = 0;
  for (const entry of entries) {
    if (entry.kind === 'folder') folders += 1;
    else bookmarks += 1;
  }
  return { folders, bookmarks, total: entries.length };
}

/** 造一条新记录，自动补时间戳。 */
export function makeEntry(input: {
  uid: string;
  parentUid: string;
  index: number;
  kind: Entry['kind'];
  title: string;
  url?: string | null;
  createdAt?: string;
  updatedAt?: string;
}): Entry {
  const now = nowIso();
  return {
    uid: input.uid,
    parentUid: input.parentUid,
    index: input.index,
    kind: input.kind,
    title: input.title,
    url: input.kind === 'bookmark' ? (input.url ?? '') : null,
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? now,
  };
}
