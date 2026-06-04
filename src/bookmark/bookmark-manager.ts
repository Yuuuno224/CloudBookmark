import type { BookmarkNode, BookmarkTree } from '@/types';
import { localStore } from '@/storage';
import { nowISO, sha256, debounce } from '@/utils/helpers';

type DirtyCallback = () => void;

export class BookmarkManager {
  private dirtyCallback: DirtyCallback | null = null;
  private initialized = false;

  onDirty(callback: DirtyCallback): void {
    this.dirtyCallback = callback;
  }

  private markDirty(): void {
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

  async readBrowserTree(): Promise<BookmarkTree> {
    const [treeResult] = await Promise.all([
      chrome.bookmarks.getTree(),
    ]);
    const root = treeResult[0];
    const barChildren = root.children?.[0]?.children || [];
    const otherChildren = root.children?.[1]?.children || [];
    const mobileChildren = root.children?.[2]?.children || [];

    const bookmarkBar = this.convertNode(
      root.children?.[0] || root,
      'bookmark_bar',
    );
    const other = this.convertNode(
      root.children?.[1] || { id: '2', title: 'Other Bookmarks' },
      'other',
    );
    const mobile = this.convertNode(
      root.children?.[2] || { id: '3', title: 'Mobile Bookmarks' },
      'mobile',
    );

    bookmarkBar.children = barChildren.map((c) => this.convertNode(c));
    other.children = otherChildren.map((c) => this.convertNode(c));
    mobile.children = mobileChildren.map((c) => this.convertNode(c));

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
    return {
      id: forceId || node.id,
      title: node.title,
      type: isFolder ? 'folder' : 'bookmark',
      url: node.url,
      parentId: node.parentId,
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

    for (const id of toRemove) {
      await localStore.deleteBookmark(id);
      try {
        await chrome.bookmarks.remove(id);
      } catch {
        try {
          await chrome.bookmarks.removeTree(id);
        } catch {
          // node may already be removed
        }
      }
    }

    const foldersFirst = toAdd.sort((a, b) => {
      if (a.type === 'folder' && b.type !== 'folder') return -1;
      if (a.type !== 'folder' && b.type === 'folder') return 1;
      return 0;
    });

    const idMapping = new Map<string, string>();

    for (const node of foldersFirst) {
      await localStore.putBookmark(node);

      const resolvedParentId = node.parentId
        ? idMapping.get(node.parentId) || node.parentId
        : undefined;

      if (node.type === 'folder') {
        try {
          const result = await chrome.bookmarks.create({
            parentId: resolvedParentId || '1',
            title: node.title,
          });
          if (result.id !== node.id) {
            idMapping.set(node.id, result.id);
          }
        } catch {
          // parent may not exist yet, skip
        }
      } else if (node.type === 'bookmark' && node.url) {
        try {
          await chrome.bookmarks.create({
            parentId: resolvedParentId || '1',
            title: node.title,
            url: node.url,
          });
        } catch {
          // parent may not exist yet, skip
        }
      }
    }
  }

  async getBookmarkTree(): Promise<BookmarkTree> {
    return this.readBrowserTree();
  }
}

export const bookmarkManager = new BookmarkManager();
