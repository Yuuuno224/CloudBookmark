import type { Entry, NodeKind } from '@/core/types';

/** 造一条测试记录，省略一堆样板字段。 */
export function e(
  uid: string,
  parentUid: string,
  index: number,
  kind: NodeKind,
  title: string,
  url?: string | null,
): Entry {
  const iso = '2024-01-01T00:00:00.000Z';
  return {
    uid,
    parentUid,
    index,
    kind,
    title,
    url: kind === 'bookmark' ? (url ?? '') : null,
    createdAt: iso,
    updatedAt: iso,
  };
}

export function folder(uid: string, parentUid: string, index: number, title: string): Entry {
  return e(uid, parentUid, index, 'folder', title);
}

export function bookmark(uid: string, parentUid: string, index: number, title: string, url: string): Entry {
  return e(uid, parentUid, index, 'bookmark', title, url);
}

/** 两个标准根目录，几乎所有测试都要用。 */
export function roots(): Entry[] {
  return [folder('root:0', '', 0, '书签栏'), folder('root:1', '', 1, '其他书签')];
}

/** 拿 uid 列表，方便断言顺序。 */
export function uidsOf(entries: Entry[]): string[] {
  return [...entries].sort((a, b) => (a.uid < b.uid ? -1 : 1)).map((entry) => entry.uid);
}

/** 按父亲取孩子（已按 index 排序）的 uid 列表。 */
export function childUids(entries: Entry[], parentUid: string): string[] {
  return entries
    .filter((entry) => entry.parentUid === parentUid)
    .sort((a, b) => a.index - b.index)
    .map((entry) => entry.uid);
}

/** 取某条记录，找不到就抛错（让断言更早失败、更好定位）。 */
export function find(entries: Entry[], uid: string): Entry {
  const found = entries.find((entry) => entry.uid === uid);
  if (!found) throw new Error(`测试数据里找不到 uid=${uid}`);
  return found;
}
