import { createSignal, onMount, Show } from 'solid-js';
import { BookmarkList } from './components/BookmarkList';
import { SyncStatus } from './components/SyncStatus';
import { Settings } from './components/Settings';
import { ChangeLog } from './components/ChangeLog';
import { tokenManager } from '@/auth';

type Tab = 'bookmarks' | 'changelog' | 'settings';

export function App() {
  const [tab, setTab] = createSignal<Tab>('bookmarks');
  const [hasToken, setHasToken] = createSignal(false);

  onMount(async () => {
    const ok = await tokenManager.hasToken();
    setHasToken(ok);
    if (!ok) setTab('settings');
  });

  const tabs: { key: Tab; label: string }[] = [
    { key: 'bookmarks', label: '书签' },
    { key: 'changelog', label: '记录' },
    { key: 'settings', label: '设置' },
  ];

  return (
    <div class="flex flex-col h-full">
      <header class="flex items-center justify-between px-4 py-3 bg-white border-b border-gray-200">
        <h1 class="text-lg font-semibold text-gray-800">CloudBookmark</h1>
        <div class="flex gap-1">
          {tabs.map((t) => (
            <button
              classList={{
                'px-3 py-1 text-sm rounded-md': true,
                'bg-blue-500 text-white': tab() === t.key,
                'text-gray-600 hover:bg-gray-100': tab() !== t.key,
              }}
              onClick={() => setTab(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>
      </header>

      <Show when={hasToken()}>
        <SyncStatus />
      </Show>

      <main class="flex-1 overflow-y-auto">
        <Show when={tab() === 'changelog' && hasToken()}>
          <ChangeLog />
        </Show>
        <Show when={tab() === 'bookmarks' && hasToken()}>
          <BookmarkList />
        </Show>
        <Show when={tab() === 'settings' || !hasToken()}>
          <Settings onTokenSaved={() => { setHasToken(true); setTab('bookmarks'); }} />
        </Show>
      </main>
    </div>
  );
}
