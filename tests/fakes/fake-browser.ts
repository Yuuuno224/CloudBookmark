import type { BookmarkAdapter, BrowserNode, CreateInput, MoveTarget } from '@/platform/bookmarks';

interface FakeNode {
  id: string;
  parentId: string | null;
  title: string;
  url: string | null;
  children: string[];
  dateAdded: string | null;
}

/**
 * 内存版浏览器书签树，行为尽量贴近 chrome.bookmarks：
 *  - 顶层有两个根目录（id '1' 书签栏、id '2' 其他书签），parentId 为 null
 *  - 位置就是父节点 children 数组里的下标
 *  - remove 不能删非空文件夹，removeTree 可以
 *
 * 有了它，就能在几毫秒内模拟"两台设备来回同步"，不需要真的开浏览器。
 */
export class FakeBrowser implements BookmarkAdapter {
  readonly nodes = new Map<string, FakeNode>();
  readonly rootOrder: string[] = ['1', '2'];
  readonly barId = '1';
  readonly otherId = '2';

  #nextId = 100;

  constructor() {
    this.nodes.set('1', { id: '1', parentId: null, title: '书签栏', url: null, children: [], dateAdded: null });
    this.nodes.set('2', { id: '2', parentId: null, title: '其他书签', url: null, children: [], dateAdded: null });
  }

  // ---- BookmarkAdapter ----

  async readAll(): Promise<BrowserNode[]> {
    const out: BrowserNode[] = [];
    const walk = (ids: string[], parentId: string | null) => {
      ids.forEach((id, index) => {
        const node = this.nodes.get(id);
        if (!node) return;
        out.push({
          id: node.id,
          parentId,
          index,
          title: node.title,
          url: node.url,
          dateAdded: node.dateAdded,
          folder: node.url === null,
        });
        walk(node.children, node.id);
      });
    };
    walk(this.rootOrder, null);
    return out;
  }

  async create(input: CreateInput): Promise<{ id: string }> {
    const parent = this.nodes.get(input.parentId);
    if (!parent) throw new Error(`parent not found: ${input.parentId}`);
    const id = `n${this.#nextId++}`;
    this.nodes.set(id, {
      id,
      parentId: input.parentId,
      title: input.title,
      url: input.url ?? null,
      children: [],
      dateAdded: new Date(Date.UTC(2024, 0, 1)).toISOString(),
    });
    const at = input.index === undefined ? parent.children.length : Math.max(0, Math.min(input.index, parent.children.length));
    parent.children.splice(at, 0, id);
    return { id };
  }

  async update(id: string, patch: { title?: string; url?: string }): Promise<void> {
    const node = this.nodes.get(id);
    if (!node) throw new Error(`node not found: ${id}`);
    if (patch.title !== undefined) node.title = patch.title;
    if (patch.url !== undefined) node.url = patch.url;
  }

  async move(id: string, target: MoveTarget): Promise<void> {
    const node = this.nodes.get(id);
    if (!node) throw new Error(`node not found: ${id}`);
    const from = node.parentId ? this.nodes.get(node.parentId) : null;
    const to = this.nodes.get(target.parentId);
    if (!to) throw new Error(`parent not found: ${target.parentId}`);
    if (from) {
      const at = from.children.indexOf(id);
      if (at >= 0) from.children.splice(at, 1);
    }
    node.parentId = target.parentId;
    const index = Math.max(0, Math.min(target.index, to.children.length));
    to.children.splice(index, 0, id);
  }

  async remove(id: string): Promise<void> {
    const node = this.nodes.get(id);
    if (!node) throw new Error(`node not found: ${id}`);
    if (node.children.length > 0) throw new Error('Cannot remove non-empty folder');
    this.#detach(id);
    this.nodes.delete(id);
  }

  async removeTree(id: string): Promise<void> {
    const node = this.nodes.get(id);
    if (!node) throw new Error(`node not found: ${id}`);
    for (const child of [...node.children]) await this.removeTree(child);
    this.#detach(id);
    this.nodes.delete(id);
  }

  #detach(id: string): void {
    const node = this.nodes.get(id);
    const parent = node?.parentId ? this.nodes.get(node.parentId) : null;
    if (parent) {
      const at = parent.children.indexOf(id);
      if (at >= 0) parent.children.splice(at, 1);
    }
    const rootAt = this.rootOrder.indexOf(id);
    if (rootAt >= 0) this.rootOrder.splice(rootAt, 1);
  }

  // ---- 测试辅助 ----

  addFolder(parentId: string, title: string): string {
    const id = `n${this.#nextId++}`;
    this.nodes.set(id, {
      id,
      parentId,
      title,
      url: null,
      children: [],
      dateAdded: new Date(Date.UTC(2024, 0, 1)).toISOString(),
    });
    this.nodes.get(parentId)!.children.push(id);
    return id;
  }

  addBookmark(parentId: string, title: string, url: string): string {
    const id = `n${this.#nextId++}`;
    this.nodes.set(id, {
      id,
      parentId,
      title,
      url,
      children: [],
      dateAdded: new Date(Date.UTC(2024, 0, 1)).toISOString(),
    });
    this.nodes.get(parentId)!.children.push(id);
    return id;
  }

  /** 按路径取文件夹 id，例如 path('书签栏', '开发')。 */
  path(...titles: string[]): string {
    let currentId = titles[0] === '书签栏' ? this.barId : this.otherId;
    for (const title of titles.slice(1)) {
      const child = this.nodes.get(currentId)!.children
        .map((id) => this.nodes.get(id)!)
        .find((node) => node.title === title && node.url === null);
      if (!child) throw new Error(`找不到文件夹 ${titles.join('/')}（在 ${title} 处断了）`);
      currentId = child.id;
    }
    return currentId;
  }

  /** 某个父亲下孩子的标题顺序。 */
  titlesOf(parentId: string): string[] {
    return this.nodes.get(parentId)!.children.map((id) => this.nodes.get(id)!.title);
  }

  findIdByTitle(parentId: string, title: string): string | undefined {
    return this.nodes.get(parentId)!.children.find((id) => this.nodes.get(id)!.title === title);
  }

  findByUrl(url: string): FakeNode[] {
    return [...this.nodes.values()].filter((node) => node.url === url);
  }

  countByUrl(url: string): number {
    return this.findByUrl(url).length;
  }
}
