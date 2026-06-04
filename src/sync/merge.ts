import type { BookmarkNode, BookmarkTree, ConflictEntry } from '@/types';
import { nowISO, generateId } from '@/utils/helpers';

export interface NodeMap {
  byId: Map<string, BookmarkNode>;
  byUrl: Map<string, BookmarkNode[]>;
}

export interface MergeResult {
  merged: BookmarkNode[];
  conflicts: ConflictEntry[];
  localOnly: BookmarkNode[];
  remoteOnly: BookmarkNode[];
}

export function buildNodeMap(nodes: BookmarkNode[]): NodeMap {
  const byId = new Map<string, BookmarkNode>();
  const byUrl = new Map<string, BookmarkNode[]>();
  for (const node of nodes) {
    byId.set(node.id, node);
    if (node.url) {
      const list = byUrl.get(node.url) || [];
      list.push(node);
      byUrl.set(node.url, list);
    }
  }
  return { byId, byUrl };
}

export function flattenTree(tree: BookmarkTree): BookmarkNode[] {
  const nodes: BookmarkNode[] = [];
  const walk = (node: BookmarkNode) => {
    const { children, ...flat } = node;
    nodes.push(flat as BookmarkNode);
    if (children) {
      for (const child of children) {
        walk(child);
      }
    }
  };
  walk(tree.roots.bookmark_bar);
  walk(tree.roots.other);
  walk(tree.roots.mobile);
  return nodes;
}

function nodeKey(node: BookmarkNode): string {
  if (node.url) return `url:${node.url}`;
  return `id:${node.id}`;
}

function isSameContent(a: BookmarkNode, b: BookmarkNode): boolean {
  return (
    a.title === b.title &&
    a.url === b.url &&
    a.type === b.type &&
    a.parentId === b.parentId
  );
}

export function threeWayMerge(
  baseNodes: BookmarkNode[],
  localNodes: BookmarkNode[],
  remoteNodes: BookmarkNode[],
): MergeResult {
  const base = buildNodeMap(baseNodes);
  const local = buildNodeMap(localNodes);
  const remote = buildNodeMap(remoteNodes);

  const mergedMap = new Map<string, BookmarkNode>();
  const conflicts: ConflictEntry[] = [];
  const localOnly: BookmarkNode[] = [];
  const remoteOnly: BookmarkNode[] = [];

  const allIds = new Set([
    ...base.byId.keys(),
    ...local.byId.keys(),
    ...remote.byId.keys(),
  ]);

  for (const id of allIds) {
    const baseNode = base.byId.get(id);
    const localNode = local.byId.get(id);
    const remoteNode = remote.byId.get(id);

    const inBase = baseNode !== undefined;
    const inLocal = localNode !== undefined;
    const inRemote = remoteNode !== undefined;

    if (inBase && inLocal && inRemote) {
      if (isSameContent(localNode!, baseNode!) && isSameContent(remoteNode!, baseNode!)) {
        mergedMap.set(id, localNode!);
      } else if (isSameContent(localNode!, baseNode!)) {
        mergedMap.set(id, remoteNode!);
      } else if (isSameContent(remoteNode!, baseNode!)) {
        mergedMap.set(id, localNode!);
      } else if (isSameContent(localNode!, remoteNode!)) {
        mergedMap.set(id, localNode!);
      } else {
        const lTime = new Date(localNode!.updatedAt).getTime();
        const rTime = new Date(remoteNode!.updatedAt).getTime();
        conflicts.push({
          id,
          localValue: localNode!,
          remoteValue: remoteNode!,
          timestamp: nowISO(),
        });
        mergedMap.set(id, lTime >= rTime ? localNode! : remoteNode!);
      }
    } else if (inBase && inLocal && !inRemote) {
      const baseUrl = baseNode!.url;
      const remoteHasSameUrl = baseUrl && remote.byUrl.has(baseUrl);
      if (remoteHasSameUrl) {
        const remoteMatches = remote.byUrl.get(baseUrl!)!;
        const remoteMatch = remoteMatches.find(
          (r) => r.title === baseNode!.title && !base.byId.has(r.id),
        );
        if (remoteMatch) {
          mergedMap.set(id, { ...localNode!, url: remoteMatch.url, title: remoteMatch.title, updatedAt: remoteMatch.updatedAt });
        } else {
          localOnly.push(localNode!);
          mergedMap.set(id, localNode!);
        }
      } else {
        localOnly.push(localNode!);
        mergedMap.set(id, localNode!);
      }
    } else if (inBase && !inLocal && inRemote) {
      const baseUrl = baseNode!.url;
      const localHasSameUrl = baseUrl && local.byUrl.has(baseUrl);
      if (localHasSameUrl) {
        remoteOnly.push(remoteNode!);
        mergedMap.set(id, remoteNode!);
      } else {
        remoteOnly.push(remoteNode!);
        mergedMap.set(id, remoteNode!);
      }
    } else if (inBase && !inLocal && !inRemote) {
      // both deleted - skip
    } else if (!inBase && inLocal && inRemote) {
      if (isSameContent(localNode!, remoteNode!)) {
        mergedMap.set(id, localNode!);
      } else if (localNode!.url && remoteNode!.url && localNode!.url === remoteNode!.url) {
        const lTime = new Date(localNode!.updatedAt).getTime();
        const rTime = new Date(remoteNode!.updatedAt).getTime();
        mergedMap.set(id, lTime >= rTime ? localNode! : remoteNode!);
      } else {
        mergedMap.set(id, localNode!);
        const altId = `${id}-remote`;
        mergedMap.set(altId, { ...remoteNode!, id: altId });
        conflicts.push({
          id,
          localValue: localNode!,
          remoteValue: remoteNode!,
          timestamp: nowISO(),
        });
      }
    } else if (!inBase && inLocal && !inRemote) {
      mergedMap.set(id, localNode!);
      localOnly.push(localNode!);
    } else if (!inBase && !inLocal && inRemote) {
      mergedMap.set(id, remoteNode!);
      remoteOnly.push(remoteNode!);
    }
  }

  for (const remoteNode of remoteNodes) {
    if (mergedMap.has(remoteNode.id)) continue;
    if (base.byId.has(remoteNode.id)) continue;

    if (remoteNode.url) {
      const localMatches = local.byUrl.get(remoteNode.url);
      if (localMatches) {
        const alreadyMerged = [...mergedMap.values()].some(
          (m) => m.url === remoteNode.url && m.title === remoteNode.title,
        );
        if (alreadyMerged) continue;
      }
    }

    mergedMap.set(remoteNode.id, remoteNode);
    remoteOnly.push(remoteNode);
  }

  for (const localNode of localNodes) {
    if (mergedMap.has(localNode.id)) continue;
    if (base.byId.has(localNode.id)) continue;
    mergedMap.set(localNode.id, localNode);
    localOnly.push(localNode);
  }

  const merged = Array.from(mergedMap.values());
  return { merged, conflicts, localOnly, remoteOnly };
}

export function rebuildTree(mergedNodes: BookmarkNode[]): BookmarkTree {
  const now = nowISO();
  const nodeMap = new Map(mergedNodes.map((n) => [n.id, n]));

  const rootIds = ['bookmark_bar', 'other', 'mobile'];
  const defaultRoots: Record<string, BookmarkNode> = {
    bookmark_bar: { id: 'bookmark_bar', title: '书签栏', type: 'folder', children: [], createdAt: now, updatedAt: now },
    other: { id: 'other', title: '其他书签', type: 'folder', children: [], createdAt: now, updatedAt: now },
    mobile: { id: 'mobile', title: '移动设备书签', type: 'folder', children: [], createdAt: now, updatedAt: now },
  };

  const roots: BookmarkTree['roots'] = {
    bookmark_bar: { ...defaultRoots.bookmark_bar },
    other: { ...defaultRoots.other },
    mobile: { ...defaultRoots.mobile },
  };

  const rootChildren: Record<string, BookmarkNode[]> = {
    bookmark_bar: [],
    other: [],
    mobile: [],
  };

  const childMap = new Map<string, BookmarkNode[]>();
  for (const node of mergedNodes) {
    if (rootIds.includes(node.id)) continue;
    const pid = node.parentId || 'bookmark_bar';
    if (rootIds.includes(pid)) {
      rootChildren[pid].push({ ...node, children: node.type === 'folder' ? [] : undefined });
    } else {
      if (!childMap.has(pid)) childMap.set(pid, []);
      childMap.get(pid)!.push({ ...node, children: node.type === 'folder' ? [] : undefined });
    }
  }

  function attachChildren(node: BookmarkNode): BookmarkNode {
    const kids = childMap.get(node.id);
    if (!kids) return node;
    return { ...node, children: kids.map(attachChildren) };
  }

  roots.bookmark_bar = { ...defaultRoots.bookmark_bar, children: rootChildren.bookmark_bar.map(attachChildren) };
  roots.other = { ...defaultRoots.other, children: rootChildren.other.map(attachChildren) };
  roots.mobile = { ...defaultRoots.mobile, children: rootChildren.mobile.map(attachChildren) };

  return { version: 3, updatedAt: now, checksum: '', roots };
}
