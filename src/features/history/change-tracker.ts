/**
 * 书签变更记录
 * ============
 *
 * 监听 chrome.bookmarks 的四个事件，把"你手动改了什么"记下来，
 * 在设置页的「历史」标签里展示。
 *
 * ## 两个必须知道的坑
 *
 * 1. **MV3 的 Service Worker 会随时休眠。**
 *    `chrome.bookmarks.onCreated.addListener` 必须在脚本**顶层**同步注册，
 *    不能放在 async 初始化函数里。否则 SW 被唤醒后监听器根本没装上，
 *    你会觉得"变更记录时有时无"。
 *
 * 2. **自己写入书签也会触发这些事件。**
 *    同步时我们把合并结果写回浏览器，会触发几百个 onCreated/onRemoved。
 *    所以有一个"静默窗口"：写入前打开，2.5 秒后自动关闭。
 *    用时间戳而不是布尔值，是因为事件是异步派发的，写完后马上关会漏掉尾巴。
 */

import { newRecordId, nowIso } from '@/core/ids';
import type { ChangeAction, ChangeRecord } from '@/core/types';
import { changeLogStore } from '@/platform/blob-store';

/** 默认的静默时长（毫秒）。写入几百条书签可能需要更久，所以留得比较宽。 */
const DEFAULT_SUPPRESS_MS = 3000;

/** 每记录这么多条就清理一次溢出。 */
const TRIM_INTERVAL = 200;

export class ChangeTracker {
  #suppressUntil = 0;
  #sinceTrim = 0;
  #limit = 2000;

  /** 打开静默窗口：这段时间内的书签事件不记录（都是我们自己写进去的）。 */
  suppressFor(ms = DEFAULT_SUPPRESS_MS): void {
    this.#suppressUntil = Math.max(this.#suppressUntil, Date.now() + ms);
  }

  get suppressed(): boolean {
    return Date.now() < this.#suppressUntil;
  }

  setLimit(limit: number): void {
    this.#limit = Math.max(100, limit);
  }

  /**
   * 注册监听。**必须同步调用**（在 Service Worker 顶层）。
   *
   * @param onChange 有"用户自己改的"变更时回调（用来标记"该同步了"）。
   *                 自己同步写入引发的变更不会触发它。
   */
  register(onChange?: () => void): void {
    const fire = () => {
      try {
        onChange?.();
      } catch {
        /* 忽略 */
      }
    };

    chrome.bookmarks.onCreated.addListener((id, node) => {
      if (this.suppressed) return;
      void this.#record('create', id, node.title ?? '', node.url ?? null);
      fire();
    });
    chrome.bookmarks.onRemoved.addListener((id, info) => {
      if (this.suppressed) return;
      void this.#record('remove', id, info.node?.title ?? '', info.node?.url ?? null);
      fire();
    });
    chrome.bookmarks.onChanged.addListener((id, info) => {
      if (this.suppressed) return;
      void this.#record('update', id, info.title ?? '', info.url ?? null);
      fire();
    });
    chrome.bookmarks.onMoved.addListener((id) => {
      if (this.suppressed) return;
      void this.#record('move', id, '', null);
      fire();
    });
  }

  async #record(action: ChangeAction, browserId: string, title: string, url: string | null): Promise<void> {
    const record: ChangeRecord = {
      id: newRecordId(),
      action,
      browserId,
      title,
      url,
      at: nowIso(),
    };
    try {
      await changeLogStore.add(record);
      this.#sinceTrim += 1;
      if (this.#sinceTrim >= TRIM_INTERVAL) {
        this.#sinceTrim = 0;
        await changeLogStore.trim(this.#limit);
      }
    } catch {
      // 记录失败不影响正常使用
    }
  }
}

export const changeTracker = new ChangeTracker();
