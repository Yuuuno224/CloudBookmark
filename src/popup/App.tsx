import { createSignal, onMount, Show } from 'solid-js';
import { BookmarkList } from './components/BookmarkList';
import { SyncStatus } from './components/SyncStatus';
import { Settings } from './components/Settings';
import { tokenManager } from '@/auth';

export function App() {
  const [tab, setTab] = createSignal<'bookmarks' | 'settings'>('bookmarks');
  const [hasToken, setHasToken] = createSignal(false);

  onMount(async () => {
    const ok = await tokenManager.hasToken();
    setHasToken(ok);
    if (!ok) setTab('settings');
  });

  return (
    <div class="flex flex-col h-full">
      <header class="flex items-center justify-between px-4 py-3 bg-white border-b border-gray-200">
        <h1 class="text-lg font-semibold text-gray-800">CloudBookmark</h1>
        <div class="flex gap-1">
          <button
            classList={{
              'px-3 py-1 text-sm rounded-md': true,
              'bg-blue-500 text-white': tab() === 'bookmarks',
              'text-gray-600 hover:bg-gray-100': tab() !== 'bookmarks',
            }}
            onClick={() => setTab('bookmarks')}
          >
            书签
          </button>
          <button
            classList={{
              'px-3 py-1 text-sm rounded-md': true,
              'bg-blue-500 text-white': tab() === 'settings',
              'text-gray-600 hover:bg-gray-100': tab() !== 'settings',
            }}
            onClick={() => setTab('settings')}
          >
            设置
          </button>
        </div>
      </header>

      <Show when={hasToken()}>
        <SyncStatus />
      </Show>

      <main class="flex-1 overflow-y-auto">
        <Show
          when={tab() === 'bookmarks' && hasToken()}
          fallback={<Settings onTokenSaved={() => { setHasToken(true); setTab('bookmarks'); }} />}
        >
          <BookmarkList />
        </Show>
      </main>
    </div>
  );
}
