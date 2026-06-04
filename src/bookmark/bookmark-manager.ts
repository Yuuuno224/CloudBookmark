import type { BookmarkNode, BookmarkTree } from '@/types';
import { localStore } from '@/storage';
import { nowISO, sha256 } from '@/utils/helpers';

export type BrowserType = 'chrome' | 'edge' | 'unknown';

export function detectBrowser(): BrowserType {
  const ua = navigator.userAgent;
  if (ua.includes('Edg/')) return 'edge';
  if (ua.includes('Chrome/')) return 'chrome';
  return 'unknown';
}

const ROOT_ID_MAP: Record<string, string> = {
  bookmark_bar: 'bookmark_bar',
  other: 'other',
  mobile: 'mobile',
};

export class BookmarkManager {
  private initialized = false;
  private applyingRemote = false;
  private browserType: BrowserType = 'unknown';

  private browserToCanonicalId = new Map<string, string>();
  private canonicalToBrowserId = new Map<string, string>();

  private mapId(browserId: string, canonicalId: string): void {
    this.browserToCanonicalId.set(browserId, canonicalId);
    this.canonicalToBrowserId.set(canonicalId, browserId);
  }

  toCanonicalId(browserId: string): string {
    return this.browserToCanonicalId.get(browserId) || browserId;
  }

  toBrowserId(canonicalId: string): string {
    return this.canonicalToBrowserId.get(canonicalId) || canonicalId;
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    this.browserType = detectBrowser();
    console.info(`[CloudBookmark] Browser detected: ${this.browserType}`);
    await this.syncFromBrowser();
  }

  private async syncFromBrowser(): Promise<void> {
    const tree = await this.readBrowserTree();
    const allNodes = this.flattenTree(tree);
    await localStore.clearBookmarks();
    await localStore.putBookmarks(allNodes);
  }

  async readBrowserTree(): Promise<BookmarkTree> {
    this.browserToCanonicalId.clear();
    this.canonicalToBrowserId.clear();

    const [treeResult] = await Promise.all([chrome.bookmarks.getTree()]);
    const root = treeResult[0];

    const barNode = root.children?.[0];
    const otherNode = root.children?.[1];
    const mobileNode = root.children?.[2];

    if (barNode) this.mapId(barNode.id, 'bookmark_bar');
    if (otherNode) this.mapId(otherNode.id, 'other');
    if (mobileNode) this.mapId(mobileNode.id, 'mobile');

    const bookmarkBar = barNode
      ? this.convertNode(barNode, 'bookmark_bar')
      : this.defaultRoot('bookmark_bar', '书签栏');
    const other = otherNode
      ? this.convertNode(otherNode, 'other')
      : this.defaultRoot('other', '其他书签');
    const mobile = mobileNode
      ? this.convertNode(mobileNode, 'mobile')
      : this.defaultRoot('mobile', '移动设备书签');

    bookmarkBar.children = (barNode?.children || []).map((c) => this.convertNode(c));
    other.children = (otherNode?.children || []).map((c) => this.convertNode(c));
    mobile.children = (mobileNode?.children || []).map((c) => this.convertNode(c));

    const tree: BookmarkTree = {
      version: 3,
      updatedAt: nowISO(),
      checksum: '',
      roots: { bookmark_bar: bookmarkBar, other, mobile },
    };
    tree.checksum = await sha256(JSON.stringify(tree.roots));
    return tree;
  }

  private defaultRoot(id: string, title: string): BookmarkNode {
    const now = nowISO();
    return { id, title, type: 'folder', children: [], createdAt: now, updatedAt: now };
  }

  private convertNode(
    node: chrome.bookmarks.BookmarkTreeNode,
    forceId?: string,
  ): BookmarkNode {
    const isFolder = !node.url;
    const canonicalId = forceId || `bm_${node.id}`;
    if (!forceId) this.mapId(node.id, canonicalId);

    const canonicalParentId = node.parentId
      ? this.toCanonicalId(node.parentId)
      : undefined;

    return {
      id: canonicalId,
      title: node.title,
      type: isFolder ? 'folder' : 'bookmark',
      url: node.url,
      parentId: canonicalParentId,
      children: isFolder ? [] : undefined,
      createdAt: node.dateAdded
        ? new Date(node.dateAdded).toISOString()
        : nowISO(),
      updatedAt: node.dateGroupModified
        ? new Date(node.dateGroupModified).toISOString()
        : nowISO(),
    };
  }

  flattenTree(tree: BookmarkTree): BookmarkNode[] {
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

  async applyMergedTree(tree: BookmarkTree): Promise<void> {
    this.applyingRemote = true;
    try {
      const mergedNodes = this.flattenTree(tree);
      const mergedById = new Map(mergedNodes.map((n) => [n.id, n]));

      const existingTree = await this.readBrowserTree();
      const existingNodes = this.flattenTree(existingTree);
      const existingById = new Map(existingNodes.map((n) => [n.id, n]));
      const existingByUrl = new Map<string, BookmarkNode>();
      for (const n of existingNodes) {
        if (n.url) existingByUrl.set(n.url, n);
      }

      const toRemove: string[] = [];
      for (const existing of existingNodes) {
        if (!mergedById.has(existing.id)) {
          if (!Object.values(ROOT_ID_MAP).includes(existing.id) && existing.parentId) {
            toRemove.push(existing.id);
          }
        }
      }

      for (const canonicalId of toRemove) {
        const browserId = this.toBrowserId(canonicalId);
        try {
          await chrome.bookmarks.remove(browserId);
        } catch {
          try {
            await chrome.bookmarks.removeTree(browserId);
          } catch { /* already removed */ }
        }
      }

      const rootIds = Object.values(ROOT_ID_MAP);
      const folders = mergedNodes
        .filter((n) => n.type === 'folder' && !rootIds.includes(n.id))
        .sort((a, b) => (a.parentId ? 0 : -1) - (b.parentId ? 0 : -1));
      const bookmarks = mergedNodes.filter((n) => n.type === 'bookmark');

      for (const folder of folders) {
        const browserParentId = folder.parentId
          ? this.toBrowserId(folder.parentId)
          : this.toBrowserId('bookmark_bar');

        if (existingById.has(folder.id)) {
          const browserId = this.toBrowserId(folder.id);
          const existing = existingById.get(folder.id)!;
          if (existing.title !== folder.title) {
            try { await chrome.bookmarks.update(browserId, { title: folder.title }); } catch { /* skip */ }
          }
          if (existing.parentId !== folder.parentId) {
            try { await chrome.bookmarks.move(browserId, { parentId: browserParentId }); } catch { /* skip */ }
          }
        } else {
          try {
            const result = await chrome.bookmarks.create({
              parentId: browserParentId,
              title: folder.title,
            });
            this.mapId(result.id, folder.id);
          } catch { /* parent may not exist yet */ }
        }
      }

      for (const bm of bookmarks) {
        if (bm.url && existingByUrl.has(bm.url)) {
          const existingDupe = existingByUrl.get(bm.url)!;
          if (existingById.has(bm.id) && existingDupe.id === bm.id) {
            const browserId = this.toBrowserId(bm.id);
            const existing = existingById.get(bm.id)!;
            const updates: { title?: string; url?: string } = {};
            if (existing.title !== bm.title) updates.title = bm.title;
            if (existing.url !== bm.url && bm.url) updates.url = bm.url;
            if (updates.title || updates.url) {
              try { await chrome.bookmarks.update(browserId, updates); } catch { /* skip */ }
            }
            if (existing.parentId !== bm.parentId) {
              const browserParentId = bm.parentId
                ? this.toBrowserId(bm.parentId)
                : this.toBrowserId('bookmark_bar');
              try { await chrome.bookmarks.move(browserId, { parentId: browserParentId }); } catch { /* skip */ }
            }
          }
          continue;
        }

        const browserParentId = bm.parentId
          ? this.toBrowserId(bm.parentId)
          : this.toBrowserId('bookmark_bar');

        if (existingById.has(bm.id)) {
          const browserId = this.toBrowserId(bm.id);
          const existing = existingById.get(bm.id)!;
          const updates: { title?: string; url?: string } = {};
          if (existing.title !== bm.title) updates.title = bm.title;
          if (existing.url !== bm.url && bm.url) updates.url = bm.url;
          if (updates.title || updates.url) {
            try { await chrome.bookmarks.update(browserId, updates); } catch { /* skip */ }
          }
          if (existing.parentId !== bm.parentId) {
            try { await chrome.bookmarks.move(browserId, { parentId: browserParentId }); } catch { /* skip */ }
          }
        } else {
          try {
            const result = await chrome.bookmarks.create({
              parentId: browserParentId,
              title: bm.title,
              url: bm.url,
            });
            this.mapId(result.id, bm.id);
          } catch { /* parent may not exist yet */ }
        }
      }
    } finally {
      this.applyingRemote = false;
    }
  }

  async getBookmarkTree(): Promise<BookmarkTree> {
    return this.readBrowserTree();
  }
}

export const bookmarkManager = new BookmarkManager();
