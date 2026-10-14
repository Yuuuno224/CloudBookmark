/**
 * 三方合并（Three-way merge）
 * ==========================
 *
 * ## 为什么要三方？
 *
 * 只有"本地"和"远端"两份数据时，你无法区分下面两件事：
 *   A. 这条书签是本地新加的  → 应该保留
 *   B. 这条书签是远端删掉的  → 应该删除
 * 两种情况在数据上都表现为"一边有一边没有"。
 *
 * 所以需要第三份数据 —— **base（上次同步完成时的样子）**。
 * 有了它就变成：
 *   本地有、base 有、远端没有  → 远端删了它  → 删
 *   本地有、base 没有、远端没有 → 本地新加的  → 留
 *
 * ## 合并规则总表
 *
 * | base | 本地 | 远端 | 含义                 | 结果           |
 * |------|------|------|----------------------|----------------|
 * | 无   | 有   | 无   | 本地新增             | 本地           |
 * | 无   | 无   | 有   | 远端新增             | 远端           |
 * | 有   | 无   | 无   | 两边都删             | 删除           |
 * | 有   | 无   | 有   | 本地删 / 远端没动    | 删除           |
 * | 有   | 有   | 无   | 远端删 / 本地没动    | 删除           |
 * | 有   | 无   | 改了 | 本地删、远端改了     | ⚠ 冲突         |
 * | 有   | 改了 | 无   | 远端删、本地改了     | ⚠ 冲突         |
 * | 有   | 改了 | 没动 | 只有本地改           | 本地           |
 * | 有   | 没动 | 改了 | 只有远端改           | 远端           |
 * | 有   | 改了 | 改了 | 两边都改（见下）     | 逐字段判定     |
 *
 * "两边都改了"再细分：
 *   - 改成了完全一样        → 都一样，随便取一个
 *   - 两边改的是不同字段    → 各取各的（自动合并，不打扰用户）
 *   - 两边改的是同一字段    → ⚠ 冲突，按 conflictPolicy 处理
 *
 * 排序（index）单独处理：只有当两边都改了顺序时才需要做一次"列表合并"，
 * 而且顺序冲突不影响数据正确性，所以不弹给用户。
 */

import { childrenOrder, contentEquals, describeEntry, entryMap, repairHierarchy, sortEntries } from './entries';
import { nowIso } from './ids';
import type {
  Conflict,
  ConflictField,
  ConflictPolicy,
  Entry,
  MergeResult,
  MergeWarning,
} from './types';

/** ISO 字符串可以直接按字典序比大小。 */
function earliestIso(...values: Array<string | null | undefined>): string {
  let best = '';
  for (const value of values) {
    if (!value) continue;
    if (best === '' || value < best) best = value;
  }
  return best || nowIso();
}

function latestIso(...values: Array<string | null | undefined>): string {
  let best = '';
  for (const value of values) {
    if (!value) continue;
    if (value > best) best = value;
  }
  return best || nowIso();
}

export interface MergeOptions {
  conflictPolicy?: ConflictPolicy;
}

/**
 * 执行三方合并。
 *
 * @param base   上次同步完成时的快照（首次同步传空数组）
 * @param local  当前浏览器里的书签
 * @param remote Gist 里的书签
 */
export function threeWayMerge(
  base: Entry[],
  local: Entry[],
  remote: Entry[],
  options: MergeOptions = {},
): MergeResult {
  const policy: ConflictPolicy = options.conflictPolicy ?? 'ask';
  const baseMap = entryMap(base);
  const localMap = entryMap(local);
  const remoteMap = entryMap(remote);

  /** uid -> 合并后的记录（index 先留空，最后统一算） */
  const content = new Map<string, Entry>();
  const conflicts: Conflict[] = [];
  const warnings: MergeWarning[] = [];

  const allUids = new Set<string>([
    ...baseMap.keys(),
    ...localMap.keys(),
    ...remoteMap.keys(),
  ]);

  /** 两端都改了的记录：逐字段判定 */
  const mergeFields = (uid: string, b: Entry | null, l: Entry, r: Entry) => {
    const fields: ConflictField[] = [];

    const pick = <T>(baseValue: T | undefined, localValue: T, remoteValue: T, field: ConflictField): T => {
      if (localValue === remoteValue) return localValue;
      if (b && localValue === baseValue) return remoteValue;
      if (b && remoteValue === baseValue) return localValue;
      fields.push(field);
      return policy === 'prefer-local' ? localValue : remoteValue;
    };

    const kind = pick(b?.kind, l.kind, r.kind, 'kind');
    const title = pick(b?.title, l.title, r.title, 'title');
    const url = pick(b?.url ?? null, l.url, r.url, 'url');
    const parentUid = pick(b?.parentUid, l.parentUid, r.parentUid, 'parent');

    const merged: Entry = {
      uid,
      parentUid,
      index: 0,
      kind,
      title,
      url: kind === 'bookmark' ? (url ?? '') : null,
      createdAt: earliestIso(b?.createdAt, l.createdAt, r.createdAt),
      updatedAt: latestIso(b?.updatedAt, l.updatedAt, r.updatedAt),
    };
    content.set(uid, merged);

    if (fields.length > 0) {
      conflicts.push({
        id: `c-${uid}-${fields.join('-')}`,
        kind: 'fields',
        uid,
        label: describeEntry(merged),
        fields,
        base: b,
        local: l,
        remote: r,
      });
    }
  };

  /** 一边删了一边改了：默认保留"改了"的那一份，最不容易丢数据 */
  const deleteVsModify = (uid: string, b: Entry, l: Entry | null, r: Entry | null) => {
    const modified = l ?? r;
    if (!modified) return;

    if (policy === 'prefer-local') {
      if (l) content.set(uid, l);
      return;
    }
    if (policy === 'prefer-remote') {
      if (r) content.set(uid, r);
      return;
    }

    content.set(uid, modified);
    conflicts.push({
      id: `d-${uid}`,
      kind: 'delete-modify',
      uid,
      label: describeEntry(modified),
      fields: [],
      base: b,
      local: l,
      remote: r,
    });
  };

  for (const uid of allUids) {
    const b = baseMap.get(uid) ?? null;
    const l = localMap.get(uid) ?? null;
    const r = remoteMap.get(uid) ?? null;

    if (l && r) {
      if (!b) {
        // 两边都"新增"了同一个 uid。只有首次同步配对成功时才会走到这里。
        if (contentEquals(l, r)) content.set(uid, l);
        else mergeFields(uid, null, l, r);
      } else if (contentEquals(l, b)) {
        content.set(uid, r); // 本地没动，用远端
      } else if (contentEquals(r, b)) {
        content.set(uid, l); // 远端没动，用本地
      } else if (contentEquals(l, r)) {
        content.set(uid, l); // 改成一模一样了
      } else {
        mergeFields(uid, b, l, r);
      }
      continue;
    }

    if (l && !r) {
      if (!b) content.set(uid, l);
      else if (!contentEquals(l, b)) deleteVsModify(uid, b, l, null);
      // 本地没动 + 远端删除 → 什么都不做（等于删除）
      continue;
    }

    if (!l && r) {
      if (!b) content.set(uid, r);
      else if (!contentEquals(r, b)) deleteVsModify(uid, b, null, r);
      continue;
    }

    // 两边都没有：删除
  }

  // -------------------------------------------------------------------------
  // 排序合并
  // -------------------------------------------------------------------------
  const merged = assignIndexes(content, base, local, remote);

  const repaired = repairHierarchy(merged);
  warnings.push(...repaired.warnings);

  return {
    entries: repaired.entries,
    conflicts,
    warnings,
  };
}

/**
 * 计算最终顺序。
 *
 * 对每一个父文件夹：
 *  - 只有一边改了顺序 → 用改的那一边
 *  - 两边都改了顺序   → 以远端为骨架，把本地独有的项插到它在本地的前一个兄弟之后
 *  - 顺序冲突不弹给用户（只是排序，不影响有没有这条书签）
 */
function assignIndexes(
  content: Map<string, Entry>,
  base: Entry[],
  local: Entry[],
  remote: Entry[],
): Entry[] {
  const groups = new Map<string, Set<string>>();
  for (const entry of content.values()) {
    const set = groups.get(entry.parentUid);
    if (set) set.add(entry.uid);
    else groups.set(entry.parentUid, new Set([entry.uid]));
  }

  const indexOf = new Map<string, number>();

  const restrict = (order: string[], uids: Set<string>): string[] => order.filter((uid) => uids.has(uid));

  const mergeOrderLists = (localOrder: string[], remoteOrder: string[]): string[] => {
    const result = [...remoteOrder];
    const present = new Set(result);
    for (let i = 0; i < localOrder.length; i += 1) {
      const uid = localOrder[i]!;
      if (present.has(uid)) continue;
      // 找到它在本地的前一个兄弟，插到那个兄弟后面
      let anchor = -1;
      for (let j = i - 1; j >= 0; j -= 1) {
        const candidate = result.indexOf(localOrder[j]!);
        if (candidate >= 0) {
          anchor = candidate;
          break;
        }
      }
      result.splice(anchor + 1, 0, uid);
      present.add(uid);
    }
    return result;
  };

  for (const [parentUid, uids] of groups) {
    const baseOrder = restrict(childrenOrder(base, parentUid), uids);
    const localOrder = restrict(childrenOrder(local, parentUid), uids);
    const remoteOrder = restrict(childrenOrder(remote, parentUid), uids);

    const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((uid, i) => uid === b[i]);

    let order: string[];
    if (sameList(localOrder, remoteOrder)) {
      order = localOrder;
    } else if (sameList(localOrder, baseOrder)) {
      order = remoteOrder;
    } else if (sameList(remoteOrder, baseOrder)) {
      order = localOrder;
    } else {
      order = mergeOrderLists(localOrder, remoteOrder);
    }

    // 兜底：任何还没排进去的（例如刚被"修复层级"挂过来的）放到最后
    const placed = new Set(order);
    const leftovers = [...uids].filter((uid) => !placed.has(uid)).sort();
    order = [...order, ...leftovers];

    order.forEach((uid, i) => indexOf.set(uid, i));
  }

  const out: Entry[] = [];
  for (const entry of content.values()) {
    const index = indexOf.get(entry.uid) ?? 0;
    out.push(entry.index === index ? entry : { ...entry, index });
  }
  return sortEntries(out);
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** 冲突数量统计，给徽章和界面用。 */
export function summarizeConflicts(conflicts: Conflict[]): { total: number; field: number; deleteModify: number } {
  let field = 0;
  let deleteModify = 0;
  for (const conflict of conflicts) {
    if (conflict.kind === 'fields') field += 1;
    else deleteModify += 1;
  }
  return { total: conflicts.length, field, deleteModify };
}
