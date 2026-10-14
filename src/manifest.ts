import { defineManifest } from '@crxjs/vite-plugin';
import pkg from '../package.json';

/**
 * 扩展清单（Manifest V3）
 * ======================
 *
 * 几个容易踩坑、这里特意说明了的地方：
 *
 * 1. **host_permissions 必须有。**
 *    MV3 里扩展页面请求外部域名，必须在清单里声明权限，否则会被浏览器拦掉。
 *    老版本漏了这一条，表现就是"接口调不通"，而且报错信息很难懂。
 *
 * 2. **不要再写 content_security_policy.connect-src。**
 *    MV3 只允许在 extension_pages 里限制脚本来源，写 connect-src 既没用也可能
 *    让清单校验失败。跨域请求靠上面的 host_permissions 就够了。
 *
 * 3. **图标必须用 PNG。**
 *    Chrome 的工具箱图标不支持 SVG，所以 public/icons 下放的是 PNG。
 */
export default defineManifest({
  manifest_version: 3,
  name: 'CloudBookmark',
  description: '把浏览器书签同步到你自己的 GitHub Gist —— 跨浏览器、跨设备、不需要自建服务器。',
  version: pkg.version,
  minimum_chrome_version: '116',

  permissions: [
    'bookmarks', // 读写浏览器书签
    'storage', // 保存设置与加密后的 Token
    'alarms', // MV3 下的定时同步
  ],

  // 只允许访问 GitHub：api.github.com 用于 Gist 接口，
  // github.com 用于 OAuth 设备授权流程（换 access token）。
  // 不多要任何其它域名。
  host_permissions: ['https://api.github.com/*', 'https://github.com/*'],

  background: {
    service_worker: 'src/background/index.ts',
    type: 'module',
  },

  action: {
    default_popup: 'src/ui/popup/index.html',
    default_title: 'CloudBookmark',
    default_icon: {
      16: 'icons/icon16.png',
      32: 'icons/icon32.png',
      48: 'icons/icon48.png',
      128: 'icons/icon128.png',
    },
  },

  // 冲突处理、数据管理这些信息量大的界面放在独立整页里
  options_ui: {
    page: 'src/ui/options/index.html',
    open_in_tab: true,
  },

  icons: {
    16: 'icons/icon16.png',
    32: 'icons/icon32.png',
    48: 'icons/icon48.png',
    128: 'icons/icon128.png',
  },
});
