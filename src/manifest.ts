import { defineManifest } from '@crxjs/vite-plugin';

export default defineManifest({
  manifest_version: 3,
  name: 'CloudBookmark',
  description: '基于 GitHub Gist 的浏览器书签云端同步扩展',
  version: '1.0.0',
  permissions: ['bookmarks', 'storage', 'alarms'],
  background: {
    service_worker: 'src/background/sw.ts',
    type: 'module',
  },
  action: {
    default_popup: 'src/popup/index.html',
    default_icon: {
      '16': 'icons/icon16.svg',
      '48': 'icons/icon48.svg',
      '128': 'icons/icon128.svg',
    },
  },
  icons: {
    '16': 'icons/icon16.svg',
    '48': 'icons/icon48.svg',
    '128': 'icons/icon128.svg',
  },
  content_security_policy: {
    extension_pages:
      "script-src 'self'; object-src 'self'; connect-src https://api.github.com",
  },
});
