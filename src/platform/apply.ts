/**
 * 把合并结果"写回浏览器"
 * ======================
 *
 * 这是整个扩展里最需要小心的一个环节：chrome.bookmarks 没有事务，
 * 操作到一半出错会留下"半成品"。所以这里按固定的安全顺序执行：
 *
 *   1. 先建缺失的文件夹（父目录优先）
 *   2. 再建缺失的书签
 *   3. 更新标题 / 网址
 *   4. 移动换了文件夹的节点   ← 必须在删除之前！否则先删父文件夹会把孩子一起删掉
 *   5. 删除目标里已经没有的节点（自底向上）
 *   6. 重新读一遍浏览器，按目标顺序调整排序
 *
 * 每一步都尽量"幂等 + 容错"：单个节点失败不会让整个同步崩掉，
 * 而是记进 warnings，等你下次同步时自动纠正。
 */

import { entryMap } from '@/core/entries';
import { nowIso } from '@/core/ids';
import type { ChangeCounts, Entry, MergeWarning } from '@/core/types';
import { VIRTUAL_ROOT_UID } from '@/core/types';
import type { BookmarkAdapter, BrowserNode } from './bookmarks';
import type { UidMap, LocalView } from './uid-map';
import { rootTitleFor } from './uid-map';

export interface ApplyOptions {
  /**
   * 身份配对产生的改名：浏览器节点原来的 uid -> 最终的 uid。
   * 首次同步时用它让本地书签"认领"远端身份，从而不产生重复。
   */
  renames?: Map<string, string>;
}

export interface ApplyResult {
  /** 新的身份表，需要持久化。 */
  uidMap: UidMap;
  counts: ChangeCounts;
  warnings: MergeWarning[];
  /** 本次新建/删除的浏览器节点 id，用于调试与测试断言。 */
  createdBrowserIds: string[];
  removedBrowserIds: string[];
}

/** 计算每条记录在树里的深度，用于"父目录优先"和"自底向上删除"。 */
function depthMap(entries: Entry[]): Map<string, number> {
  const byUid = entryMap(entries);
  const depths = new Map<string, number>();
  for (const entry of entries) {
    let depth = 0;
    let cursor = byUid.get(entry.parentUid);
    while (cursor) {
      depth += 1;
      if (depth > 1024) break;
      cursor = byUid.get(cursor.parentUid);
    }
    depths.set(entry.uid, depth);
  }
  return depths;
}

/**
 * 执行写回。
 *
 * @param adapter 浏览器适配器
 * @param target  合并后的目标状态（应该是合法层级，即经过 repairHierarchy）
 * @param view    readLocalSnapshot 的结果
 */
export async function applySnapshot(
  adapter: BookmarkAdapter,
  target: Entry[],
  view: LocalView,
  options: ApplyOptions = {},
): Promise<ApplyResult> {
  const warnings: MergeWarning[] = [...view.warnings];
  const createdAt = nowIso();
  const targetMap = entryMap(target);
  const depths = depthMap(target);

  // -------------------------------------------------------------------------
  // 0. 处理身份配对产生的改名
  // -------------------------------------------------------------------------
  const uidByBrowserId = new Map(view.uidByBrowserId);
  const browserIdByUid = new Map(view.browserIdByUid);
  const syntheticBrowserIds = new Set<string>();
  for (const [browserId, uid] of view.uidByBrowserId) {
    if (view.syntheticUids.has(uid)) syntheticBrowserIds.add(browserId);
  }

  if (options.renames && options.renames.size > 0) {
    for (const [browserId, oldUid] of [...uidByBrowserId.entries()]) {
      const nextUid = options.renames.get(oldUid);
      if (!nextUid || nextUid === oldUid) continue;
      uidByBrowserId.set(browserId, nextUid);
      browserIdByUid.delete(oldUid);
      browserIdByUid.set(nextUid, browserId);
    }
  }

  const counts: ChangeCounts = { added: 0, updated: 0, moved: 0, removed: 0 };
  const createdBrowserIds: string[] = [];
  const removedBrowserIds: string[] = [];
  const touchedUids = new Set<string>();

  /** 运行过程中动态维护：uid -> 浏览器 id */
  const liveBrowserIdByUid = new Map(browserIdByUid);
  const wasExisting = new Set<string>(browserIdByUid.keys());

  const fallbackRootBrowserId = (): string | null => {
    // 优先挂到"其他书签"，其次挂到最后一个真实根目录
    const other = liveBrowserIdByUid.get('root:1');
    if (other && !syntheticBrowserIds.has(other)) return other;
    const realRoots = [...liveBrowserIdByUid.entries()]
      .filter(([uid]) => uid.startsWith('root:') && !syntheticBrowserIds.has(liveBrowserIdByUid.get(uid) ?? ''))
      .sort((a, b) => (a[0] < b[0] ? -1 : 1));
    const last = realRoots[realRoots.length - 1];
    return last ? last[1] : null;
  };

  const resolveParentBrowserId = (parentUid: string): string | null => {
    if (parentUid === VIRTUAL_ROOT_UID) return fallbackRootBrowserId();
    return liveBrowserIdByUid.get(parentUid) ?? null;
  };

  const sortedByDepthAsc = [...target].sort((a, b) => (depths.get(a.uid) ?? 0) - (depths.get(b.uid) ?? 0));

  // -------------------------------------------------------------------------
  // 1. 创建缺失的文件夹（父目录优先）
  // -------------------------------------------------------------------------
  for (const entry of sortedByDepthAsc) {
    if (entry.kind !== 'folder') continue;
    if (liveBrowserIdByUid.has(entry.uid)) continue;

    const isRoot = entry.parentUid === VIRTUAL_ROOT_UID;
    const parentBrowserId = resolveParentBrowserId(entry.parentUid);
    if (!parentBrowserId) {
      warnings.push({
        code: 'create-failed',
        message: `无法创建文件夹「${entry.title}」：找不到可以放它的上级目录。`,
        uids: [entry.uid],
      });
      continue;
    }

    try {
      const created = await adapter.create({
        parentId: parentBrowserId,
        title: isRoot ? rootTitleFor(entry.uid) : entry.title,
      });
      liveBrowserIdByUid.set(entry.uid, created.id);
      createdBrowserIds.push(created.id);
      touchedUids.add(entry.uid);
      counts.added += 1;
      if (isRoot) {
        syntheticBrowserIds.add(created.id);
        warnings.push({
          code: 'synthetic-root-created',
          message: `本地浏览器没有「${rootTitleFor(entry.uid)}」这个根目录，已在「其他书签」下建了一个同名文件夹来存放它的内容。`,
          uids: [entry.uid],
        });
      }
    } catch (error) {
      warnings.push({
        code: 'create-failed',
        message: `创建文件夹「${entry.title}」失败：${describeError(error)}`,
        uids: [entry.uid],
      });
    }
  }

  // -------------------------------------------------------------------------
  // 2. 创建缺失的书签
  // -------------------------------------------------------------------------
  for (const entry of target) {
    if (entry.kind !== 'bookmark') continue;
    if (liveBrowserIdByUid.has(entry.uid)) continue;

    const parentBrowserId = resolveParentBrowserId(entry.parentUid);
    if (!parentBrowserId) {
      warnings.push({
        code: 'create-failed',
        message: `无法创建书签「${entry.title}」：找不到它的上级目录。`,
        uids: [entry.uid],
      });
      continue;
    }

    try {
      const created = await adapter.create({
        parentId: parentBrowserId,
        title: entry.title,
        url: entry.url ?? '',
      });
      liveBrowserIdByUid.set(entry.uid, created.id);
      createdBrowserIds.push(created.id);
      touchedUids.add(entry.uid);
      counts.added += 1;
    } catch (error) {
      warnings.push({
        code: 'create-failed',
        message: `创建书签「${entry.title}」失败：${describeError(error)}`,
        uids: [entry.uid],
      });
    }
  }

  // -------------------------------------------------------------------------
  // 3. 更新标题 / 网址
  // -------------------------------------------------------------------------
  for (const entry of target) {
    const browserId = liveBrowserIdByUid.get(entry.uid);
    if (!browserId || !wasExisting.has(entry.uid)) continue;
    const node = view.nodesById.get(browserId);
    if (!node) continue;

    const patch: { title?: string; url?: string } = {};
    if (node.title !== entry.title) patch.title = entry.title;
    if (entry.kind === 'bookmark' && (node.url ?? '') !== (entry.url ?? '')) patch.url = entry.url ?? '';

    if (Object.keys(patch).length === 0) continue;
    try {
      await adapter.update(browserId, patch);
      touchedUids.add(entry.uid);
      counts.updated += 1;
    } catch (error) {
      warnings.push({
        code: 'update-failed',
        message: `更新「${entry.title}」失败：${describeError(error)}`,
        uids: [entry.uid],
      });
    }
  }

  // -------------------------------------------------------------------------
  // 4. 移动（必须在删除之前，否则孩子会被连坐删掉）
  // -------------------------------------------------------------------------
  for (const entry of target) {
    const browserId = liveBrowserIdByUid.get(entry.uid);
    if (!browserId || !wasExisting.has(entry.uid)) continue;
    const node = view.nodesById.get(browserId);
    if (!node) continue;

    const currentParent = node.parentId ?? null;
    let desiredParent: string | null;
    if (entry.parentUid === VIRTUAL_ROOT_UID) {
      // 目标里它是根目录：只有本地这个节点本来就是顶层节点才不移动
      desiredParent = currentParent;
    } else {
      desiredParent = liveBrowserIdByUid.get(entry.parentUid) ?? currentParent;
    }
    if (desiredParent === null || currentParent === desiredParent) continue;

    try {
      await adapter.move(browserId, { parentId: desiredParent, index: entry.index });
      touchedUids.add(entry.uid);
      counts.moved += 1;
    } catch (error) {
      warnings.push({
        code: 'move-failed',
        message: `移动「${entry.title}」失败：${describeError(error)}`,
        uids: [entry.uid],
      });
    }
  }

  // -------------------------------------------------------------------------
  // 5. 删除目标里已经没有的节点（自底向上）
  // -------------------------------------------------------------------------
  const doomed: BrowserNode[] = [];
  for (const node of view.nodesById.values()) {
    const uid = uidByBrowserId.get(node.id);
    if (!uid) continue;
    if (targetMap.has(uid)) continue;
    doomed.push(node);
  }

  const nodeDepth = (node: BrowserNode): number => {
    let depth = 0;
    let cursor: BrowserNode | undefined = node;
    while (cursor && cursor.parentId) {
      cursor = view.nodesById.get(cursor.parentId);
      depth += 1;
      if (depth > 1024) break;
    }
    return depth;
  };
  doomed.sort((a, b) => nodeDepth(b) - nodeDepth(a));

  for (const node of doomed) {
    const uid = uidByBrowserId.get(node.id);
    try {
      if (node.folder) await adapter.removeTree(node.id);
      else await adapter.remove(node.id);
      removedBrowserIds.push(node.id);
      if (uid) touchedUids.add(uid);
      counts.removed += 1;
    } catch {
      // 可能已经被父文件夹的 removeTree 顺带删掉了，忽略
    }
    if (uid) {
      liveBrowserIdByUid.delete(uid);
      browserIdByUid.delete(uid);
    }
  }

  // -------------------------------------------------------------------------
  // 6. 重新读一遍，按目标顺序调整排序
  // -------------------------------------------------------------------------
  const fresh = await adapter.readAll();
  const freshByParent = new Map<string, BrowserNode[]>();
  for (const node of fresh) {
    if (!node.parentId) continue;
    const list = freshByParent.get(node.parentId);
    if (list) list.push(node);
    else freshByParent.set(node.parentId, [node]);
  }
  for (const list of freshByParent.values()) list.sort((a, b) => a.index - b.index);

  const desiredChildren = new Map<string, Entry[]>();
  for (const entry of target) {
    const list = desiredChildren.get(entry.parentUid);
    if (list) list.push(entry);
    else desiredChildren.set(entry.parentUid, [entry]);
  }

  for (const [parentUid, children] of desiredChildren) {
    const parentBrowserId = parentUid === VIRTUAL_ROOT_UID ? null : liveBrowserIdByUid.get(parentUid);
    if (!parentBrowserId) continue;
    const current = (freshByParent.get(parentBrowserId) ?? []).map((node) => node.id);
    const desired = [...children]
      .sort((a, b) => a.index - b.index)
      .map((entry) => liveBrowserIdByUid.get(entry.uid))
      .filter((id): id is string => typeof id === 'string' && id.length > 0);

    const moved = await reorderChildren(adapter, parentBrowserId, current, desired);
    if (moved > 0) counts.moved += moved;
  }

  // -------------------------------------------------------------------------
  // 7. 产出新的身份表
  // -------------------------------------------------------------------------
  // 只保留"重新读一遍之后确实还存在的浏览器节点"的绑定关系，
  // 免得留下指向已消失节点的死记录（那种记录如果被浏览器复用 id，会认错书签）。
  const aliveIds = new Set(fresh.map((node) => node.id));

  const uidMap: UidMap = {};
  for (const [uid, browserId] of liveBrowserIdByUid) {
    if (!aliveIds.has(browserId)) continue;
    const targetEntry = targetMap.get(uid);
    uidMap[browserId] = {
      uid,
      synthetic: syntheticBrowserIds.has(browserId) || undefined,
      updatedAt: touchedUids.has(uid) ? createdAt : (targetEntry?.updatedAt ?? createdAt),
    };
  }

  return { uidMap, counts, warnings, createdBrowserIds, removedBrowserIds };
}

/**
 * 把某个父亲下的孩子调整成 desired 的顺序。
 * 只在"当前位置和目标位置不一样"时才真的调用 move，尽量少打扰浏览器。
 */
async function reorderChildren(
  adapter: BookmarkAdapter,
  parentId: string,
  current: string[],
  desired: string[],
): Promise<number> {
  const order = [...current];
  let moved = 0;
  for (let i = 0; i < desired.length; i += 1) {
    const want = desired[i]!;
    if (order[i] === want) continue;
    const at = order.indexOf(want);
    if (at < 0) continue;
    order.splice(at, 1);
    order.splice(i, 0, want);
    try {
      await adapter.move(want, { parentId, index: i });
      moved += 1;
    } catch {
      // 排序失败无关紧要，下次同步会再试
    }
  }
  return moved;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
