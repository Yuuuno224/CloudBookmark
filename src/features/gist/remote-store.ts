/**
 * 把快照读写到 GitHub Gist
 * ========================
 *
 * Gist 里长这样：
 *
 *   cloudbookmark.json   ← 全部书签数据（主文件）
 *   README.md            ← 说明文件，方便你打开 Gist 时知道这是什么
 *
 * 兼容旧版本：如果只找到旧的 `bookmarks.json`，会自动读出来转换成新格式，
 * 转换后写回时顺手把旧文件删掉（PATCH 时把文件设为 null 即可删除）。
 */

import { AppError, type DeviceInfo, type MergeWarning, type Snapshot } from '@/core/types';
import {
  GIST_DESCRIPTION,
  GIST_README_CONTENT,
  GIST_README_FILE,
  LEGACY_SNAPSHOT_FILE,
  SNAPSHOT_FILE,
  emptySnapshot,
  parseSnapshot,
  serializeSnapshot,
} from '@/core/snapshot';
import type { GistClient } from './client';
import type { Gist } from './types';

export interface RemoteRead {
  snapshot: Snapshot;
  /** 远端文件真实内容的指纹（按内容重新算，不信任文件里写的）。 */
  revision: string;
  /** 是否是旧格式迁移来的。 */
  migrated: boolean;
  warnings: MergeWarning[];
  gistId: string;
  gistUrl: string;
}

export interface GistIdStore {
  get(): Promise<string | null>;
  set(value: string | null): Promise<void>;
}

/** 接口形式，方便测试时换成"内存里的假远端"。 */
export interface RemoteGateway {
  ensure(): Promise<{ gistId: string; gistUrl: string }>;
  read(): Promise<RemoteRead>;
  write(snapshot: Snapshot): Promise<void>;
  forget(): Promise<void>;
}

/** 最多翻几页 Gist 列表去找我们自己的 Gist（每页 100 条）。 */
const MAX_GIST_PAGES = 3;

export class GistRemoteStore implements RemoteGateway {
  #client: GistClient;
  #device: DeviceInfo;
  #ids: GistIdStore;
  #onGistChange: (gistId: string, gistUrl: string) => void;

  constructor(deps: {
    client: GistClient;
    device: DeviceInfo;
    gistIds: GistIdStore;
    onGistChange?: (gistId: string, gistUrl: string) => void;
  }) {
    this.#client = deps.client;
    this.#device = deps.device;
    this.#ids = deps.gistIds;
    this.#onGistChange = deps.onGistChange ?? (() => {});
  }

  // -------------------------------------------------------------------------

  /** 找到（或创建）用来存书签的 Gist。 */
  async ensure(): Promise<{ gistId: string; gistUrl: string }> {
    const known = await this.#ids.get();
    if (known) {
      try {
        const gist = await this.#client.getGist(known);
        return this.#remember(gist);
      } catch (error) {
        if (!(error instanceof AppError) || error.code !== 'gist-missing') throw error;
        // Gist 被删了，下面重新找/建
        await this.#ids.set(null);
      }
    }

    const found = await this.#findExisting();
    if (found) return this.#remember(found);

    const created = await this.#client.createGist({
      description: GIST_DESCRIPTION,
      public: false,
      files: {
        [SNAPSHOT_FILE]: { content: serializeSnapshot(emptySnapshot(this.#device)) },
        [GIST_README_FILE]: { content: GIST_README_CONTENT },
      },
    });
    return this.#remember(created);
  }

  async #findExisting(): Promise<Gist | null> {
    let fallback: Gist | null = null;
    for (let page = 1; page <= MAX_GIST_PAGES; page += 1) {
      const gists = await this.#client.listGists(page);
      for (const gist of gists) {
        if (gist.files?.[SNAPSHOT_FILE]) return gist;
        if (!fallback && (gist.files?.[LEGACY_SNAPSHOT_FILE] || gist.description === GIST_DESCRIPTION)) {
          fallback = gist;
        }
      }
      if (gists.length < 100) break;
    }
    return fallback;
  }

  #remember(gist: Gist): { gistId: string; gistUrl: string } {
    void this.#ids.set(gist.id);
    this.#onGistChange(gist.id, gist.html_url);
    return { gistId: gist.id, gistUrl: gist.html_url };
  }

  // -------------------------------------------------------------------------

  async read(): Promise<RemoteRead> {
    const { gistId, gistUrl } = await this.ensure();
    const gist = await this.#client.getGist(gistId);
    const warnings: MergeWarning[] = [];

    const file = gist.files?.[SNAPSHOT_FILE] ?? gist.files?.[LEGACY_SNAPSHOT_FILE];
    if (!file) {
      warnings.push({
        code: 'remote-empty',
        message: 'Gist 里还没有书签数据文件，将把本地书签作为初始数据上传。',
      });
      const snapshot = emptySnapshot({ ...this.#device });
      return { snapshot, revision: snapshot.revision, migrated: false, warnings, gistId, gistUrl };
    }

    // 大文件会被 GitHub 截断，这时要按 raw_url 重新取全文
    let text = file.content ?? '';
    if (file.truncated || text.length === 0) {
      text = await this.#client.fetchRaw(file.raw_url);
    }

    const parsed = parseSnapshot(text, { ...this.#device, deviceId: gist.owner?.login ?? this.#device.deviceId });
    warnings.push(...parsed.warnings);

    return {
      snapshot: parsed.snapshot,
      revision: parsed.snapshot.revision,
      migrated: parsed.migrated,
      warnings,
      gistId,
      gistUrl,
    };
  }

  async write(snapshot: Snapshot): Promise<void> {
    const { gistId } = await this.ensure();
    const files: Record<string, { content: string } | null> = {
      [SNAPSHOT_FILE]: { content: serializeSnapshot(snapshot) },
    };
    // 迁移完之后把旧文件删掉，保持 Gist 干净（删文件 = 把内容设为 null）
    files[LEGACY_SNAPSHOT_FILE] = null;

    try {
      await this.#client.updateGist(gistId, files as Record<string, { content: string }>);
    } catch (error) {
      if (error instanceof AppError && error.code === 'payload-rejected') {
        throw new AppError(
          'payload-rejected',
          '书签数据太大，GitHub 拒绝了这次上传。建议先清理重复书签，或减少同步的根目录。',
          error.detail,
        );
      }
      throw error;
    }
  }

  async forget(): Promise<void> {
    await this.#ids.set(null);
  }
}
