import type { BookmarkNode, BookmarkTree } from '@/types';
import { localStore } from '@/storage';
import { nowISO, sha256, debounce } from '@/utils/helpers';

type DirtyCallback = () => void;

export class BookmarkManager {
  private dirtyCallback: DirtyCallback | null = null;
  private initialized = false;
  private applyingRemote = false;

  onDirty(callback: DirtyCallback): void {
    this.dirtyCallback = callback;
  }

  private markDirty(): void {
    if (this.applyingRemote) return;
    localStore.setSyncState({ isDirty: true });
    this.dirtyCallback?.();
  }

  private markDirtyDebounced = debounce(() => this.markDirty(), 500);

  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    chrome.bookmarks.onCreated.addListener(() => this.markDirtyDebounced());
    chrome.bookmarks.onRemoved.addListener(() => this.markDirtyDebounced());
    chrome.bookmarks.onChanged.addListener(() => this.markDirtyDebounced());
    chrome.bookmarks.onMoved.addListener(() => this.markDirtyDebounced());

    await this.syncFromBrowser();
  }

  private async syncFromBrowser(): Promise<void> {
    const tree = await this.readBrowserTree();
    const allNodes = this.flattenTree(tree);
    await localStore.clearBookmarks();
    await localStore.putBookmarks(allNodes);
  }

  private browserToCanonicalId = new Map<string, string>();
  private canonicalToBrowserId = new Map<string, string>();

  private mapId(browserId: string, canonicalId: string): void {
    this.browserToCanonicalId.set(browserId, canonicalId);
    this.canonicalToBrowserId.set(canonicalId, browserId);
  }

  private toCanonicalId(browserId: string): string {
    return this.browserToCanonicalId.get(browserId) || browserId;
  }

  private toBrowserId(canonicalId: string): string {
    return this.canonicalToBrowserId.get(canonicalId) || canonicalId;
  }

  async readBrowserTree(): Promise<BookmarkTree> {
    this.browserToCanonicalId.clear();
    this.canonicalToBrowserId.clear();

    const [treeResult] = await Promise.all([
      chrome.bookmarks.getTree(),
    ]);
    const root = treeResult[0];

    const barNode = root.children?.[0];
    const otherNode = root.children?.[1];
    const mobileNode = root.children?.[2];

    if (barNode) this.mapId(barNode.id, 'bookmark_bar');
    if (otherNode) this.mapId(otherNode.id, 'other');
    if (mobileNode) this.mapId(mobileNode.id, 'mobile');

    const bookmarkBar = barNode
      ? this.convertNode(barNode, 'bookmark_bar')
      : { id: 'bookmark_bar', title: '书签栏', type: 'folder' as const, children: [] as BookmarkNode[], createdAt: nowISO(), updatedAt: nowISO() };
    const other = otherNode
      ? this.convertNode(otherNode, 'other')
      : { id: 'other', title: '其他书签', type: 'folder' as const, children: [] as BookmarkNode[], createdAt: nowISO(), updatedAt: nowISO() };
    const mobile = mobileNode
      ? this.convertNode(mobileNode, 'mobile')
      : { id: 'mobile', title: '移动设备书签', type: 'folder' as const, children: [] as BookmarkNode[], createdAt: nowISO(), updatedAt: nowISO() };

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

  private flattenTree(tree: BookmarkTree): BookmarkNode[] {
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

  async applyRemoteTree(tree: BookmarkTree): Promise<void> {
    this.applyingRemote = true;
    try {
      const allLocal = await localStore.getAllBookmarks();
      const localMap = new Map(allLocal.map((n) => [n.id, n]));
      const remoteNodes = this.flattenTree(tree);
      const remoteMap = new Map(remoteNodes.map((n) => [n.id, n]));

      const toRemove: string[] = [];
      const toAdd: BookmarkNode[] = [];

      for (const local of allLocal) {
        if (!remoteMap.has(local.id)) {
          toRemove.push(local.id);
        }
      }

      for (const remote of remoteNodes) {
        const local = localMap.get(remote.id);
        if (!local || local.updatedAt < remote.updatedAt) {
          toAdd.push(remote);
        }
      }

      for (const canonicalId of toRemove) {
        await localStore.deleteBookmark(canonicalId);
        const browserId = this.toBrowserId(canonicalId);
        try {
          await chrome.bookmarks.remove(browserId);
        } catch {
          try {
            await chrome.bookmarks.removeTree(browserId);
          } catch {
            // already removed
          }
        }
      }

      const foldersFirst = toAdd.sort((a, b) => {
        if (a.type === 'folder' && b.type !== 'folder') return -1;
        if (a.type !== 'folder' && b.type === 'folder') return 1;
        return 0;
      });

      for (const node of foldersFirst) {
        await localStore.putBookmark(node);

        const browserParentId = node.parentId
          ? this.toBrowserId(node.parentId)
          : this.toBrowserId('bookmark_bar');

        if (node.type === 'folder' && !['bookmark_bar', 'other', 'mobile'].includes(node.id)) {
          try {
            const result = await chrome.bookmarks.create({
              parentId: browserParentId,
              title: node.title,
            });
            this.mapId(result.id, node.id);
          } catch {
            // parent may not exist yet, skip
          }
        } else if (node.type === 'bookmark' && node.url) {
          try {
            const result = await chrome.bookmarks.create({
              parentId: browserParentId,
              title: node.title,
              url: node.url,
            });
            this.mapId(result.id, node.id);
          } catch {
            // parent may not exist yet, skip
          }
        }
      }
    } finally {
      this.applyingRemote = false;
    }
  }

  async applyMergedTree(tree: BookmarkTree): Promise<void> {
    this.applyingRemote = true;
    try {
      const mergedNodes = this.flattenTree(tree);
      const mergedById = new Map(mergedNodes.map((n) => [n.id, n]));

      const existingTree = await this.readBrowserTree();
      const existingNodes = this.flattenTree(existingTree);
      const existingById = new Map(existingNodes.map((n) => [n.id, n]));

      const toRemove: string[] = [];
      for (const existing of existingNodes) {
        if (!mergedById.has(existing.id)) {
          if (!['bookmark_bar', 'other', 'mobile'].includes(existing.id) && existing.parentId) {
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
          } catch {
            // already removed
          }
        }
      }

      const folders = mergedNodes
        .filter((n) => n.type === 'folder' && !['bookmark_bar', 'other', 'mobile'].includes(n.id))
        .sort((a, b) => {
          const aDepth = a.parentId ? 0 : -1;
          const bDepth = b.parentId ? 0 : -1;
          return aDepth - bDepth;
        });
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
          } catch {
            // parent may not exist yet
          }
        }
      }

      for (const bm of bookmarks) {
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
          } catch {
            // parent may not exist yet
          }
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
