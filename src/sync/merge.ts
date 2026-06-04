import type { BookmarkNode, BookmarkTree, ConflictEntry } from '@/types';
import { nowISO } from '@/utils/helpers';

export interface NodeMap {
  byId: Map<string, BookmarkNode>;
  byUrl: Map<string, BookmarkNode>;
}

export interface MergeResult {
  merged: BookmarkNode[];
  conflicts: ConflictEntry[];
}

export function buildNodeMap(nodes: BookmarkNode[]): NodeMap {
  const byId = new Map<string, BookmarkNode>();
  const byUrl = new Map<string, BookmarkNode>();
  for (const node of nodes) {
    byId.set(node.id, node);
    if (node.url && !byUrl.has(node.url)) {
      byUrl.set(node.url, node);
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
  const mergedUrls = new Set<string>();
  const conflicts: ConflictEntry[] = [];

  function addMerged(node: BookmarkNode): boolean {
    if (node.url) {
      if (mergedUrls.has(node.url)) return false;
      mergedUrls.add(node.url);
    }
    mergedMap.set(node.id, node);
    return true;
  }

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
        addMerged(localNode!);
      } else if (isSameContent(localNode!, baseNode!)) {
        addMerged(remoteNode!);
      } else if (isSameContent(remoteNode!, baseNode!)) {
        addMerged(localNode!);
      } else if (isSameContent(localNode!, remoteNode!)) {
        addMerged(localNode!);
      } else {
        const lTime = new Date(localNode!.updatedAt).getTime();
        const rTime = new Date(remoteNode!.updatedAt).getTime();
        conflicts.push({
          id,
          localValue: localNode!,
          remoteValue: remoteNode!,
          timestamp: nowISO(),
        });
        addMerged(lTime >= rTime ? localNode! : remoteNode!);
      }
    } else if (inBase && inLocal && !inRemote) {
      if (localNode!.url && remote.byUrl.has(localNode!.url)) {
        // remote has same URL under different ID — local deletion + remote rename
        const remoteMatch = remote.byUrl.get(localNode!.url!)!;
        addMerged(remoteMatch);
      } else {
        addMerged(localNode!);
      }
    } else if (inBase && !inLocal && inRemote) {
      if (remoteNode!.url && local.byUrl.has(remoteNode!.url)) {
        // local has same URL under different ID — remote deletion + local rename
        const localMatch = local.byUrl.get(remoteNode!.url!)!;
        addMerged(localMatch);
      } else {
        addMerged(remoteNode!);
      }
    } else if (inBase && !inLocal && !inRemote) {
      // both deleted — skip
    } else if (!inBase && inLocal && inRemote) {
      if (localNode!.url && remoteNode!.url && localNode!.url === remoteNode!.url) {
        const lTime = new Date(localNode!.updatedAt).getTime();
        const rTime = new Date(remoteNode!.updatedAt).getTime();
        addMerged(lTime >= rTime ? localNode! : remoteNode!);
      } else if (isSameContent(localNode!, remoteNode!)) {
        addMerged(localNode!);
      } else {
        addMerged(localNode!);
        const altNode: BookmarkNode = { ...remoteNode!, id: `${id}-remote` };
        if (!addMerged(altNode)) {
          conflicts.push({
            id,
            localValue: localNode!,
            remoteValue: remoteNode!,
            timestamp: nowISO(),
          });
        }
      }
    } else if (!inBase && inLocal && !inRemote) {
      addMerged(localNode!);
    } else if (!inBase && !inLocal && inRemote) {
      addMerged(remoteNode!);
    }
  }

  for (const remoteNode of remoteNodes) {
    if (mergedMap.has(remoteNode.id)) continue;
    if (base.byId.has(remoteNode.id)) continue;
    addMerged(remoteNode);
  }

  for (const localNode of localNodes) {
    if (mergedMap.has(localNode.id)) continue;
    if (base.byId.has(localNode.id)) continue;
    addMerged(localNode);
  }

  const merged = Array.from(mergedMap.values());
  return { merged, conflicts };
}

export function rebuildTree(mergedNodes: BookmarkNode[]): BookmarkTree {
  const now = nowISO();
  const rootIds = ['bookmark_bar', 'other', 'mobile'];

  const defaultRoots: Record<string, BookmarkNode> = {
    bookmark_bar: { id: 'bookmark_bar', title: '书签栏', type: 'folder', children: [], createdAt: now, updatedAt: now },
    other: { id: 'other', title: '其他书签', type: 'folder', children: [], createdAt: now, updatedAt: now },
    mobile: { id: 'mobile', title: '移动设备书签', type: 'folder', children: [], createdAt: now, updatedAt: now },
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

  return {
    version: 3,
    updatedAt: now,
    checksum: '',
    roots: {
      bookmark_bar: { ...defaultRoots.bookmark_bar, children: rootChildren.bookmark_bar.map(attachChildren) },
      other: { ...defaultRoots.other, children: rootChildren.other.map(attachChildren) },
      mobile: { ...defaultRoots.mobile, children: rootChildren.mobile.map(attachChildren) },
    },
  };
}
