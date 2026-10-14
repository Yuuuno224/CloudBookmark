/**
 * 快照的序列化 / 反序列化 / 兼容旧格式
 * ====================================
 *
 * 远端（Gist 里的 cloudbookmark.json）和本地基准用的都是 Snapshot 结构，
 * 所以"读写远端"这件事本身没什么难度，难的是：
 *
 *  1. 远端数据是不可信的——可能被人手改过、可能是旧版本格式、可能字段缺失。
 *     所以解析时一律逐字段校验，坏数据要么修好要么丢掉并给出提示，绝不崩溃。
 *  2. 内容指纹（revision）必须只由"影响同步的字段"决定，
 *     这样时间戳变化不会造成无意义的上传。
 */

import { bodyEquals, countKinds, entryMap, normalizeIndexes, repairHierarchy, sortEntries } from './entries';
import { newUid, nowIso } from './ids';
import type {
  ChangeCounts,
  DeviceInfo,
  Entry,
  IdentityLink,
  MergeWarning,
  NodeKind,
  Snapshot,
} from './types';
import { AppError, VIRTUAL_ROOT_UID, rootUid } from './types';

/** 当前快照格式版本。以后结构要改时改这里，并在 parseSnapshot 里加迁移分支。 */
export const SNAPSHOT_SCHEMA = 1;
/** 写在 JSON 里的类型标记，用来区分"我们的文件"和"别人的文件"。 */
export const SNAPSHOT_KIND = 'cloudbookmark';
/** Gist 里主文件的文件名。 */
export const SNAPSHOT_FILE = 'cloudbookmark.json';
/** 旧版本（v2 及以前）用的文件名，只在迁移时读。 */
export const LEGACY_SNAPSHOT_FILE = 'bookmarks.json';
/** 旧版本用来识别自己 Gist 的描述文字。 */
export const GIST_DESCRIPTION = 'cloudbookmark-sync';
/** 在 Gist 里额外放一个说明文件，别人（包括未来的你）打开 Gist 能看懂。 */
export const GIST_README_FILE = 'README.md';
export const GIST_README_CONTENT = [
  '# CloudBookmark 数据文件',
  '',
  '这个 Gist 由浏览器扩展 CloudBookmark 创建和维护，用来在浏览器之间同步书签。',
  '',
  '- `cloudbookmark.json`：全部书签数据（请勿手工修改，可能导致解析失败）',
  '- `README.md`：本说明文件',
  '',
  '文件内容是纯文本 JSON，你随时可以自己备份或迁移。',
  '',
].join('\n');

// ---------------------------------------------------------------------------
// 指纹
// ---------------------------------------------------------------------------

/**
 * 同步用的字符串哈希（FNV-1a 变体，128 bit 拼出来）。
 * 只是用来判断"内容变了没有"，不用于安全用途。
 */
export function hashText(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x1000193;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ code, 0x85ebca6b) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

/** 单条记录的"内容行"：只包含影响同步的字段，不含时间戳。 */
function revisionLine(entry: Entry): string {
  return [entry.uid, entry.parentUid, entry.index, entry.kind, entry.title, entry.url ?? ''].join('\u0001');
}

/** 计算内容指纹。空集合也有一个稳定值。 */
export function computeRevision(entries: Entry[]): string {
  const lines = sortEntries(entries).map(revisionLine);
  return hashText(lines.join('\u0002'));
}

// ---------------------------------------------------------------------------
// 序列化
// ---------------------------------------------------------------------------

/** 固定字段顺序，让 Gist 里的 JSON diff 好看、也保证输出可复现。 */
function entryToJson(entry: Entry): Record<string, unknown> {
  return {
    uid: entry.uid,
    parentUid: entry.parentUid,
    index: entry.index,
    kind: entry.kind,
    title: entry.title,
    url: entry.url,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
}

/**
 * 生成写进 Gist 的文本。
 * 手写拼接而不是 JSON.stringify(payload, null, 2)，是为了让"每条记录一行"
 * ——既方便你自己打开 Gist 看，又不会因为缩进把体积撑大好几倍。
 */
export function serializeSnapshot(snapshot: Snapshot): string {
  const entries = sortEntries(snapshot.entries).map((entry) => `    ${JSON.stringify(entryToJson(entry))}`);
  const header = [
    `  "kind": ${JSON.stringify(SNAPSHOT_KIND)},`,
    `  "schema": ${SNAPSHOT_SCHEMA},`,
    `  "revision": ${JSON.stringify(snapshot.revision)},`,
    `  "generatedAt": ${JSON.stringify(snapshot.generatedAt)},`,
    `  "deviceId": ${JSON.stringify(snapshot.deviceId)},`,
    `  "deviceName": ${JSON.stringify(snapshot.deviceName)},`,
    `  "count": ${snapshot.entries.length},`,
  ];
  return `{\n${header.join('\n')}\n  "entries": [\n${entries.join(',\n')}\n  ]\n}\n`;
}

// ---------------------------------------------------------------------------
// 构造
// ---------------------------------------------------------------------------

export function createSnapshot(entries: Entry[], device: DeviceInfo, generatedAt = nowIso()): Snapshot {
  const normalized = normalizeIndexes(entries);
  return {
    schema: SNAPSHOT_SCHEMA,
    revision: computeRevision(normalized),
    generatedAt,
    deviceId: device.deviceId,
    deviceName: device.deviceName,
    entries: normalized,
  };
}

export function emptySnapshot(device: DeviceInfo): Snapshot {
  return createSnapshot([], device);
}

/** 换掉快照的设备信息但保留内容（用于"远端是谁写的"这类展示）。 */
export function withDevice(snapshot: Snapshot, device: DeviceInfo): Snapshot {
  return { ...snapshot, deviceId: device.deviceId, deviceName: device.deviceName };
}

// ---------------------------------------------------------------------------
// 解析
// ---------------------------------------------------------------------------

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function coerceEntry(raw: unknown, fallbackIndex: number, warnings: MergeWarning[]): Entry | null {
  if (!raw || typeof raw !== 'object') {
    warnings.push({ code: 'entry-dropped', message: '远端文件里有一条记录不是对象，已跳过。' });
    return null;
  }
  const source = raw as Record<string, unknown>;
  const url = typeof source.url === 'string' && source.url.length > 0 ? source.url : null;
  const rawKind = source.kind;
  let kind: NodeKind;
  if (rawKind === 'folder' || rawKind === 'bookmark') kind = rawKind;
  else kind = url ? 'bookmark' : 'folder';

  const index = typeof source.index === 'number' && Number.isFinite(source.index) && source.index >= 0
    ? Math.floor(source.index)
    : fallbackIndex;

  const now = nowIso();
  return {
    uid: asString(source.uid),
    parentUid: asString(source.parentUid, VIRTUAL_ROOT_UID),
    index,
    kind,
    title: asString(source.title),
    url: kind === 'bookmark' ? (url ?? '') : null,
    createdAt: asString(source.createdAt, now),
    updatedAt: asString(source.updatedAt, now),
  };
}

function normalizeEntries(rawList: unknown[], warnings: MergeWarning[]): Entry[] {
  const out: Entry[] = [];
  const seen = new Set<string>();
  rawList.forEach((raw, i) => {
    const entry = coerceEntry(raw, i, warnings);
    if (!entry) return;
    if (!entry.uid) entry.uid = newUid();
    if (seen.has(entry.uid)) {
      const replacement = newUid();
      warnings.push({
        code: 'uid-duplicated',
        message: `远端文件里有重复的身份标识，已为「${entry.title || entry.uid}」重新分配。`,
        uids: [entry.uid],
      });
      entry.uid = replacement;
    }
    seen.add(entry.uid);
    out.push(entry);
  });
  return out;
}

// ---- 旧格式迁移 -----------------------------------------------------------

const LEGACY_ROOT_KEYS = ['bookmark_bar', 'other', 'mobile'] as const;

interface LegacyWalkContext {
  entries: Entry[];
  warnings: MergeWarning[];
  now: string;
}

function migrateLegacyNode(
  raw: unknown,
  parentUid: string,
  index: number,
  ctx: LegacyWalkContext,
): string | null {
  if (!raw || typeof raw !== 'object') return null;
  const source = raw as Record<string, unknown>;
  const url = typeof source.url === 'string' && source.url.length > 0 ? source.url : null;
  const kind: NodeKind = source.type === 'folder' || source.type === 'bookmark'
    ? (source.type as NodeKind)
    : url
      ? 'bookmark'
      : 'folder';

  const uid = newUid();
  ctx.entries.push({
    uid,
    parentUid,
    index,
    kind,
    title: asString(source.title),
    url: kind === 'bookmark' ? (url ?? '') : null,
    createdAt: asString(source.createdAt, ctx.now),
    updatedAt: asString(source.updatedAt, ctx.now),
  });

  const children = Array.isArray(source.children) ? source.children : [];
  children.forEach((child, i) => migrateLegacyNode(child, uid, i, ctx));
  return uid;
}

function migrateLegacy(raw: Record<string, unknown>, warnings: MergeWarning[]): Entry[] {
  const roots = raw.roots as Record<string, unknown> | undefined;
  if (!roots || typeof roots !== 'object') {
    throw new AppError('remote-unreadable', '远端文件格式无法识别。');
  }
  const ctx: LegacyWalkContext = { entries: [], warnings, now: nowIso() };

  LEGACY_ROOT_KEYS.forEach((key, position) => {
    const node = roots[key];
    if (!node) return;
    const rootSource = node as Record<string, unknown>;
    const uid = rootUid(position);
    ctx.entries.push({
      uid,
      parentUid: VIRTUAL_ROOT_UID,
      index: position,
      kind: 'folder',
      title: asString(rootSource.title, ['书签栏', '其他书签', '移动设备书签'][position] ?? '书签'),
      url: null,
      createdAt: asString(rootSource.createdAt, ctx.now),
      updatedAt: asString(rootSource.updatedAt, ctx.now),
    });
    const children = Array.isArray(rootSource.children) ? rootSource.children : [];
    children.forEach((child, i) => migrateLegacyNode(child, uid, i, ctx));
  });

  if (ctx.entries.length === 0) {
    throw new AppError('remote-unreadable', '远端文件是旧格式，但里面没有任何书签。');
  }
  warnings.push({
    code: 'legacy-migrated',
    message: '检测到旧版本的书签数据，已自动转换成新格式。转换后会把新格式上传回 Gist。',
  });
  return ctx.entries;
}

/**
 * 解析远端文件内容。
 * 能识别：新格式、旧格式（v2 及以前）、完全看不懂（抛错）。
 */
export function parseSnapshot(
  text: string,
  fallbackDevice: DeviceInfo,
): { snapshot: Snapshot; migrated: boolean; warnings: MergeWarning[] } {
  const warnings: MergeWarning[] = [];
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new AppError('remote-unreadable', '远端文件不是合法的 JSON，可能被手工改坏了。');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AppError('remote-unreadable', '远端文件内容不是预期的对象结构。');
  }

  const source = raw as Record<string, unknown>;
  const device: DeviceInfo = {
    deviceId: asString(source.deviceId, 'unknown'),
    deviceName: asString(source.deviceName, '未知设备'),
  };

  let entries: Entry[];
  let migrated = false;

  if (Array.isArray(source.entries)) {
    entries = normalizeEntries(source.entries, warnings);
  } else if (source.roots && typeof source.roots === 'object') {
    entries = migrateLegacy(source, warnings);
    migrated = true;
  } else {
    throw new AppError(
      'remote-unreadable',
      '这个 Gist 里没有 CloudBookmark 的数据文件，或者文件结构不认识。',
    );
  }

  const repaired = repairHierarchy(entries);
  warnings.push(...repaired.warnings);

  return {
    snapshot: {
      schema: SNAPSHOT_SCHEMA,
      revision: computeRevision(repaired.entries),
      generatedAt: asString(source.generatedAt, nowIso()),
      deviceId: device.deviceId,
      deviceName: device.deviceName,
      entries: repaired.entries,
    },
    migrated,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// 派生信息
// ---------------------------------------------------------------------------

export { countKinds as snapshotStats };

/** 比较两份快照的差别，产出"新增/更新/移动/删除"数量。 */
export function diffCounts(before: Entry[], after: Entry[]): ChangeCounts {
  const beforeMap = entryMap(before);
  const afterMap = entryMap(after);
  const counts: ChangeCounts = { added: 0, updated: 0, removed: 0, moved: 0 };

  for (const [uid, next] of afterMap) {
    const prev = beforeMap.get(uid);
    if (!prev) {
      counts.added += 1;
      continue;
    }
    if (!bodyEquals(prev, next)) counts.updated += 1;
    if (prev.parentUid !== next.parentUid || prev.index !== next.index) counts.moved += 1;
  }
  for (const uid of beforeMap.keys()) {
    if (!afterMap.has(uid)) counts.removed += 1;
  }
  return counts;
}

/**
 * URL 归一化，用于"首次同步时把本地书签和远端书签认成同一条"。
 * 刻意保守：只统一大小写和末尾斜杠，不动查询参数和锚点，
 * 避免把两条真的不一样的书签合并掉。
 */
export function normalizeUrl(url: string): string {
  const trimmed = url.trim();
  try {
    const parsed = new URL(trimmed);
    const path = parsed.pathname === '/' ? '' : parsed.pathname;
    return `${parsed.protocol.toLowerCase()}//${parsed.host.toLowerCase()}${path}${parsed.search}${parsed.hash}`;
  } catch {
    return trimmed;
  }
}

/**
 * 首次同步配对：把本地和远端"其实是同一本书签"的记录认出来。
 *
 * 不这么做的话，新设备第一次同步会把远端所有书签再创建一遍，
 * 结果就是满屏重复——这是同类扩展最常见的坑。
 *
 * 配对规则（从可靠到不可靠）：
 *  1. 书签：URL 归一化后相同且都只出现一次 → 配对。
 *  2. 文件夹：标题 + 父亲都相同且唯一 → 配对。
 */
export function reconcileFirstSync(
  local: Entry[],
  remote: Entry[],
): { links: IdentityLink[]; localOnly: Entry[]; remoteOnly: Entry[] } {
  const links: IdentityLink[] = [];
  const usedLocal = new Set<string>();
  const usedRemote = new Set<string>();

  // 两边身份本来就一样的（例如根目录 root:0）直接算作已配对，不产生多余记录
  const remoteByUid = entryMap(remote);
  for (const entry of local) {
    if (remoteByUid.has(entry.uid)) {
      usedLocal.add(entry.uid);
      usedRemote.add(entry.uid);
    }
  }

  const bucket = (entries: Entry[], keyOf: (entry: Entry) => string | null) => {
    const map = new Map<string, Entry[]>();
    for (const entry of entries) {
      const key = keyOf(entry);
      if (key === null) continue;
      const list = map.get(key);
      if (list) list.push(entry);
      else map.set(key, [entry]);
    }
    return map;
  };

  const localBookmarks = bucket(local, (entry) => (entry.kind === 'bookmark' && entry.url ? normalizeUrl(entry.url) : null));
  const remoteBookmarks = bucket(remote, (entry) => (entry.kind === 'bookmark' && entry.url ? normalizeUrl(entry.url) : null));

  for (const [url, localList] of localBookmarks) {
    const remoteList = remoteBookmarks.get(url);
    if (!remoteList) continue;
    if (localList.length !== 1 || remoteList.length !== 1) continue; // 有歧义就不猜
    const l = localList[0]!;
    const r = remoteList[0]!;
    if (usedLocal.has(l.uid) || usedRemote.has(r.uid)) continue;
    if (l.uid === r.uid) continue; // 身份本来就一样，不需要配对
    links.push({ localUid: l.uid, remoteUid: r.uid });
    usedLocal.add(l.uid);
    usedRemote.add(r.uid);
  }

  const localFolders = bucket(local, (entry) => (entry.kind === 'folder' ? `${entry.parentUid}\u0001${entry.title}` : null));
  const remoteFolders = bucket(remote, (entry) => (entry.kind === 'folder' ? `${entry.parentUid}\u0001${entry.title}` : null));

  for (const [key, localList] of localFolders) {
    const remoteList = remoteFolders.get(key);
    if (!remoteList) continue;
    if (localList.length !== 1 || remoteList.length !== 1) continue;
    const l = localList[0]!;
    const r = remoteList[0]!;
    if (l.uid === r.uid) continue;
    if (usedLocal.has(l.uid) || usedRemote.has(r.uid)) continue;
    links.push({ localUid: l.uid, remoteUid: r.uid });
    usedLocal.add(l.uid);
    usedRemote.add(r.uid);
  }

  return {
    links,
    localOnly: local.filter((entry) => !usedLocal.has(entry.uid)),
    remoteOnly: remote.filter((entry) => !usedRemote.has(entry.uid)),
  };
}

/**
 * 按配对结果改写本地记录的 uid，让本地节点"认领"远端身份。
 * 这样后续合并就会认为它们是同一条，而不是各自新建一条。
 */
export function applyIdentityLinks(
  entries: Entry[],
  links: IdentityLink[],
): { entries: Entry[]; renames: Map<string, string> } {
  const renames = new Map<string, string>();
  for (const link of links) {
    if (link.localUid !== link.remoteUid) renames.set(link.localUid, link.remoteUid);
  }
  if (renames.size === 0) return { entries, renames };

  const rewrite = (uid: string) => renames.get(uid) ?? uid;
  const seen = new Set<string>();
  const out: Entry[] = [];
  for (const entry of entries) {
    const uid = rewrite(entry.uid);
    if (seen.has(uid)) continue; // 理论上不会发生，防御一下
    seen.add(uid);
    out.push({ ...entry, uid, parentUid: rewrite(entry.parentUid) });
  }
  return { entries: normalizeIndexes(out), renames };
}

/** 找出 URL 完全相同的书签（用于设置页里的"清理重复书签"工具）。 */
export function findDuplicateUrls(entries: Entry[]): Array<{ url: string; uids: string[]; title: string }> {
  const groups = new Map<string, Entry[]>();
  for (const entry of entries) {
    if (entry.kind !== 'bookmark' || !entry.url) continue;
    const key = normalizeUrl(entry.url);
    const list = groups.get(key);
    if (list) list.push(entry);
    else groups.set(key, [entry]);
  }
  return [...groups.entries()]
    .filter(([, list]) => list.length > 1)
    .map(([url, list]) => ({ url, uids: list.map((entry) => entry.uid), title: list[0]!.title }));
}
