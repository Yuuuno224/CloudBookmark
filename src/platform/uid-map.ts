/**
 * 身份表与"读取本地快照"
 * ======================
 *
 * ## 核心难题
 *
 * chrome.bookmarks 给的 id 是**本机临时 id**（例如 "42"），换一台电脑、
 * 甚至重装浏览器都会变。而同步必须知道"这条书签和我上次同步的那条
 * 是不是同一条"。
 *
 * 所以每个浏览器节点都要绑一个我们自己的稳定 uid，绑定关系存在
 * `UidMap`（浏览器 id -> uid）里，持久化在 IndexedDB。
 *
 * 旧版本的做法是直接用 `bm_<浏览器id>` 当身份，一旦浏览器 id 变了
 * （换设备、同步过来的书签、重装）就会认不出来，于是重复、删不掉。
 * 这是原版最根本的一个 bug。
 *
 * ## 三种身份来源（按优先级）
 *
 *  1. 身份表里有记录 → 用它（最可靠，包含我们自己创建的替身根目录）
 *  2. 是浏览器顶层节点 → 用位置推导出的稳定 id：root:0 / root:1 / root:2
 *     （Chrome 的书签栏永远是第 0 个、其他书签第 1 个，Edge 也一样，
 *      所以两台不同浏览器能对上号）
 *  3. 其它新节点 → 生成一个全新的随机 uid
 */

import { entryMap, repairHierarchy } from '@/core/entries';
import { newUid, nowIso } from '@/core/ids';
import { computeRevision, SNAPSHOT_SCHEMA } from '@/core/snapshot';
import type { DeviceInfo, Entry, MergeWarning, Snapshot } from '@/core/types';
import { VIRTUAL_ROOT_UID, rootUid } from '@/core/types';
import type { BrowserNode } from './bookmarks';

export interface UidRecord {
  uid: string;
  /** true 表示这个浏览器节点是我们为了"本地没有的根目录"造出来的替身文件夹。 */
  synthetic?: boolean;
  /** 我们最后一次改动它的时间，仅用于展示。 */
  updatedAt?: string;
}

/** 浏览器节点 id -> 身份记录。 */
export type UidMap = Record<string, UidRecord>;

export interface LocalView {
  /** 当前浏览器书签的快照（uid 视角）。 */
  snapshot: Snapshot;
  nodesById: Map<string, BrowserNode>;
  uidByBrowserId: Map<string, string>;
  browserIdByUid: Map<string, string>;
  syntheticUids: Set<string>;
  warnings: MergeWarning[];
}

/** 替身根目录的默认名字，按位置取。 */
export const ROOT_TITLES = ['书签栏', '其他书签', '移动设备书签'];

export function rootTitleFor(uid: string): string {
  const position = Number.parseInt(uid.slice('root:'.length), 10);
  if (Number.isInteger(position) && position >= 0 && position < ROOT_TITLES.length) {
    return ROOT_TITLES[position]!;
  }
  return Number.isInteger(position) ? `根目录 ${position}` : '根目录';
}

/**
 * 读一遍浏览器书签，产出：
 *  - snapshot：uid 视角的本地快照
 *  - 双向索引：uid <-> 浏览器 id（写入本地时要用）
 */
export function readLocalSnapshot(
  nodes: BrowserNode[],
  uidMap: UidMap,
  device: DeviceInfo,
): LocalView {
  const warnings: MergeWarning[] = [];
  const nodesById = new Map<string, BrowserNode>();
  for (const node of nodes) {
    if (!nodesById.has(node.id)) nodesById.set(node.id, node);
  }

  const roots = nodes
    .filter((node) => node.parentId === null)
    .sort((a, b) => a.index - b.index);
  const rootPositionById = new Map<string, number>();
  roots.forEach((root, position) => rootPositionById.set(root.id, position));

  const uidByBrowserId = new Map<string, string>();
  const browserIdByUid = new Map<string, string>();
  const syntheticUids = new Set<string>();
  const claimed = new Set<string>();

  const claim = (node: BrowserNode, uid: string, synthetic: boolean): void => {
    uidByBrowserId.set(node.id, uid);
    if (!browserIdByUid.has(uid)) browserIdByUid.set(uid, node.id);
    if (synthetic) syntheticUids.add(uid);
  };

  // ---- 第一遍：先给"真实存在的节点"定身份，优先于替身节点 ----
  for (const node of nodes) {
    const record = uidMap[node.id];
    if (record?.synthetic) continue; // 替身留到第二遍

    let uid: string;
    if (record && typeof record.uid === 'string' && record.uid.length > 0) {
      uid = record.uid;
    } else if (node.parentId === null) {
      uid = rootUid(rootPositionById.get(node.id) ?? 0);
    } else {
      uid = newUid();
    }

    if (claimed.has(uid)) {
      // 同一个身份被两个浏览器节点claim了。只可能发生在脏数据上。
      const replacement = newUid();
      warnings.push({
        code: 'uid-conflict',
        message: `有两个浏览器节点claim了同一个身份，已为「${node.title || node.id}」重新分配。`,
        uids: [uid],
      });
      uid = replacement;
    }
    claimed.add(uid);
    claim(node, uid, false);
  }

  // ---- 第二遍：替身节点。如果它的 uid 已经被真实节点占走，就改成普通文件夹（会被清理掉）----
  for (const node of nodes) {
    const record = uidMap[node.id];
    if (!record?.synthetic) continue;

    let uid = record.uid;
    let synthetic = true;
    if (claimed.has(uid)) {
      const replacement = newUid();
      warnings.push({
        code: 'synthetic-root-superseded',
        message: `浏览器已经出现了真正的「${rootTitleFor(uid)}」根目录，之前造的替身文件夹将被清理。`,
        uids: [uid],
      });
      uid = replacement;
      synthetic = false;
    }
    claimed.add(uid);
    claim(node, uid, synthetic);
  }

  // ---- 组装 Entry ----
  const now = nowIso();
  const entries: Entry[] = [];
  for (const node of nodes) {
    const uid = uidByBrowserId.get(node.id);
    if (!uid) continue;
    const record = uidMap[node.id];
    const parentUid = node.parentId === null ? VIRTUAL_ROOT_UID : (uidByBrowserId.get(node.parentId) ?? VIRTUAL_ROOT_UID);
    entries.push({
      uid,
      parentUid,
      index: node.index,
      kind: node.folder ? 'folder' : 'bookmark',
      title: node.title,
      url: node.folder ? null : (node.url ?? ''),
      createdAt: node.dateAdded ?? now,
      updatedAt: record?.updatedAt ?? node.dateAdded ?? now,
    });
  }

  const repaired = repairHierarchy(entries);
  warnings.push(...repaired.warnings);

  return {
    snapshot: {
      schema: SNAPSHOT_SCHEMA,
      revision: computeRevision(repaired.entries),
      generatedAt: now,
      deviceId: device.deviceId,
      deviceName: device.deviceName,
      entries: repaired.entries,
    },
    nodesById,
    uidByBrowserId,
    browserIdByUid,
    syntheticUids,
    warnings,
  };
}

/** 只取 entry 索引，方便调用方查。 */
export function entriesOf(view: LocalView): Map<string, Entry> {
  return entryMap(view.snapshot.entries);
}

/**
 * 把 LocalView 里的绑定关系转成可持久化的 UidMap。
 *
 * **读完本地就立刻保存**，这一步很重要：
 * 新节点的 uid 是当场随机生成的，如果不保存，下一次读又会生成新的 uid，
 * 于是"同一条书签"在两次读之间身份不同，合并结果就会和本地对不上。
 */
export function uidMapFromView(view: LocalView): UidMap {
  const updatedAtByUid = new Map(view.snapshot.entries.map((entry) => [entry.uid, entry.updatedAt]));
  const map: UidMap = {};
  for (const [browserId, uid] of view.uidByBrowserId) {
    map[browserId] = {
      uid,
      synthetic: view.syntheticUids.has(uid) || undefined,
      updatedAt: updatedAtByUid.get(uid),
    };
  }
  return map;
}

/** 根目录的 uid 列表（按位置排序）。 */
export function rootUidsOf(entries: Entry[]): string[] {
  return entries
    .filter((entry) => entry.parentUid === VIRTUAL_ROOT_UID)
    .sort((a, b) => a.index - b.index)
    .map((entry) => entry.uid);
}
