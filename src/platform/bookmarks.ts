/**
 * 浏览器书签 API 的适配层
 * ======================
 *
 * 整个扩展只有这个文件（以及 chrome-* 系列）直接调用 chrome.* API。
 * 其它地方都通过下面这个 BookmarkAdapter 接口操作书签，
 * 好处有两个：
 *
 *  1. 单元测试可以塞一个"内存版浏览器"，几毫秒就能模拟两台设备来回同步；
 *  2. 以后要支持 Firefox（browser.bookmarks），只要再写一个适配器。
 */

/** 浏览器里一个书签节点的"快照"，字段名和 chrome.bookmarks 不同，更贴近我们的模型。 */
export interface BrowserNode {
  id: string;
  /** null 表示它是顶层节点（浏览器那个看不见的根的孩子）。 */
  parentId: string | null;
  /** 在同一个父亲下的位置。chrome 只在部分回调里给 index，所以适配器自己按数组顺序算。 */
  index: number;
  title: string;
  /** 文件夹为 null。 */
  url: string | null;
  /** ISO 字符串，浏览器没提供时为 null。 */
  dateAdded: string | null;
  folder: boolean;
}

export interface CreateInput {
  parentId: string;
  index?: number;
  title: string;
  url?: string;
}

export interface MoveTarget {
  parentId: string;
  index: number;
}

export interface BookmarkAdapter {
  /** 读出整棵树（扁平数组，父在前子在后的顺序不保证）。 */
  readAll(): Promise<BrowserNode[]>;
  create(input: CreateInput): Promise<{ id: string }>;
  update(id: string, patch: { title?: string; url?: string }): Promise<void>;
  move(id: string, target: MoveTarget): Promise<void>;
  /** 删除单个书签或空文件夹。 */
  remove(id: string): Promise<void>;
  /** 连文件夹带内容一起删。 */
  removeTree(id: string): Promise<void>;
}

/** Chrome / Edge 的实现。 */
export function createChromeBookmarkAdapter(): BookmarkAdapter {
  return {
    async readAll(): Promise<BrowserNode[]> {
      const tree = await chrome.bookmarks.getTree();
      const root = tree[0];
      const nodes: BrowserNode[] = [];

      const walk = (children: chrome.bookmarks.BookmarkTreeNode[], parentId: string | null) => {
        children.forEach((child, index) => {
          nodes.push({
            id: child.id,
            parentId,
            index,
            title: child.title ?? '',
            url: child.url ?? null,
            dateAdded: child.dateAdded ? new Date(child.dateAdded).toISOString() : null,
            folder: !child.url,
          });
          if (child.children && child.children.length > 0) walk(child.children, child.id);
        });
      };

      walk(root?.children ?? [], null);
      return nodes;
    },

    async create(input: CreateInput) {
      const created = await chrome.bookmarks.create({
        parentId: input.parentId,
        index: input.index,
        title: input.title,
        url: input.url,
      });
      return { id: created.id };
    },

    async update(id, patch) {
      const changes: { title?: string; url?: string } = {};
      if (patch.title !== undefined) changes.title = patch.title;
      if (patch.url !== undefined) changes.url = patch.url;
      if (Object.keys(changes).length === 0) return;
      await chrome.bookmarks.update(id, changes);
    },

    async move(id, target) {
      await chrome.bookmarks.move(id, { parentId: target.parentId, index: target.index });
    },

    async remove(id) {
      await chrome.bookmarks.remove(id);
    },

    async removeTree(id) {
      await chrome.bookmarks.removeTree(id);
    },
  };
}
