/**
 * 后台入口（Service Worker）
 * ==========================
 *
 * ## 读这个文件前请先记住一件事
 *
 * Manifest V3 的 Service Worker **不是常驻的**：浏览器觉得它闲着就会把它杀掉，
 * 有事件时再重新启动一遍这个文件。所以：
 *
 *   - 所有 `chrome.xxx.addListener` 都必须写在**模块顶层**，
 *     不能塞进 async 初始化函数里——否则脚本被重新启动时监听器根本没装上，
 *     表现就是"有时能用有时不能用"。
 *   - 需要跨事件保存的东西必须落到存储里（chrome.storage / IndexedDB），
 *     不能只放在内存变量里。
 *
 * 这个文件本身很薄，只做"接线"：把各个模块的监听器装到浏览器的对应事件上。
 */

import { changeTracker } from '@/features/history/change-tracker';
import { registerMessageHandler } from '@/platform/messaging';
import { handleRequest } from './handlers';
import { bootstrap, onBookmarkChanged, refreshStateAndBadge, registerScheduler } from './scheduler';

// ---------------------------------------------------------------------------
// 顶层注册 —— 顺序无所谓，但必须在这里，不能延后
// ---------------------------------------------------------------------------

// 1) 书签变更记录 + "该同步了"的标记（自己同步写入的不会触发）
changeTracker.register(() => {
  void onBookmarkChanged();
});

// 2) 界面通过 sendMessage 发来的请求
registerMessageHandler(handleRequest);

// 3) 定时同步的闹钟
registerScheduler();

// 4) 安装 / 更新 / 浏览器启动
chrome.runtime.onInstalled.addListener((details) => {
  console.info(`[CloudBookmark] 扩展${describeReason(details.reason)}，版本 ${chrome.runtime.getManifest().version}`);
  void bootstrap(details.reason);
});

chrome.runtime.onStartup.addListener(() => {
  void bootstrap('startup');
});

// 5) 每次 Service Worker 被唤醒时，顺手刷新一次图标徽章
void refreshStateAndBadge();

function describeReason(reason: chrome.runtime.OnInstalledReason | string): string {
  switch (reason) {
    case 'install':
      return '已安装';
    case 'update':
      return '已更新';
    case 'chrome_update':
      return '随浏览器更新';
    case 'shared_module_update':
      return '依赖模块更新';
    default:
      return '状态变化';
  }
}
