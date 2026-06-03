import { createSignal, onMount, For, Show } from 'solid-js';

interface BookmarkItem {
  id: string;
  title: string;
  url?: string;
  type: 'bookmark' | 'folder';
}

export function BookmarkList() {
  const [bookmarks, setBookmarks] = createSignal<BookmarkItem[]>([]);
  const [loading, setLoading] = createSignal(true);

  onMount(async () => {
    try {
      const tree = await chrome.bookmarks.getTree();
      const root = tree[0];
      const items: BookmarkItem[] = [];

      const walk = (nodes: chrome.bookmarks.BookmarkTreeNode[]) => {
        for (const node of nodes) {
          items.push({
            id: node.id,
            title: node.title || (node.url ? new URL(node.url).hostname : '未命名'),
            url: node.url,
            type: node.url ? 'bookmark' : 'folder',
          });
          if (node.children) walk(node.children);
        }
      };

      if (root.children) {
        for (const child of root.children) {
          if (child.children) walk(child.children);
        }
      }

      setBookmarks(items);
    } catch (err) {
      console.error('Failed to load bookmarks:', err);
    } finally {
      setLoading(false);
    }
  });

  return (
    <div class="p-2">
      <Show when={loading()} fallback={
        <For each={bookmarks()} fallback={<p class="text-center text-gray-400 py-8">暂无书签</p>}>
          {(item) => (
            <a
              href={item.url}
              target="_blank"
              class="flex items-center gap-2 px-3 py-2 rounded-md hover:bg-gray-100 cursor-pointer"
            >
              <span classList={{
                'text-lg': true,
                '📁': item.type === 'folder',
                '🔗': item.type === 'bookmark',
              }} />
              <span class="text-sm text-gray-700 truncate">{item.title}</span>
            </a>
          )}
        </For>
      }>
        <p class="text-center text-gray-400 py-8">加载中...</p>
      </Show>
    </div>
  );
}
