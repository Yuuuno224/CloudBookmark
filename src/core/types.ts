/**
 * 领域模型（Domain Model）
 * =======================
 *
 * 这个文件只描述"数据长什么样"，不包含任何浏览器 API 调用。
 * 整个扩展内部都用这里定义的结构来表示书签，只有在最外层
 * （src/platform/）才会把它翻译成 chrome.bookmarks 的格式。
 *
 * 这样做的原因：纯数据 + 纯函数的逻辑可以用单元测试完整覆盖，
 * 不需要真的开一个浏览器。
 */

// ---------------------------------------------------------------------------
// 身份（uid）
// ---------------------------------------------------------------------------

/**
 * 虚拟根。浏览器的书签树最顶上有一个看不见的根节点，它的孩子就是
 * "书签栏""其他书签"这些可见的根目录。
 * 我们用空字符串表示"我的父亲是那个看不见的根"。
 */
export const VIRTUAL_ROOT_UID = '';

/** 可见根目录的 uid 前缀，实际形如 `root:0`、`root:1`。 */
export const ROOT_UID_PREFIX = 'root:';

/** 根目录按位置编号生成的稳定 uid。 */
export function rootUid(position: number): string {
  return `${ROOT_UID_PREFIX}${position}`;
}

/** 判断某个 uid 是不是根目录。 */
export function isRootUid(uid: string): boolean {
  return uid.startsWith(ROOT_UID_PREFIX);
}

export type NodeKind = 'folder' | 'bookmark';

/**
 * 一条书签/文件夹记录（扁平结构，不含 children）。
 *
 * 为什么扁平？因为同步要逐条比较、逐条合并。层级关系用 parentUid 表达，
 * 需要树的时候再用 buildTree() 组装出来。
 */
export interface Entry {
  /** 跨设备稳定的身份。同一本书签在任何设备、任何浏览器上都是同一个 uid。 */
  uid: string;
  /** 父节点的 uid；空串表示它直接挂在浏览器根下（即它本身是一个根目录）。 */
  parentUid: string;
  /** 在同一个父节点下的排序位置，从 0 开始。 */
  index: number;
  kind: NodeKind;
  title: string;
  /** 只有 kind === 'bookmark' 时有值。 */
  url: string | null;
  /** ISO 时间字符串，仅用于展示。 */
  createdAt: string;
  /** ISO 时间字符串，近似值，仅用于展示。 */
  updatedAt: string;
}

/** 某个设备的一份书签"快照"。本地快照和远端快照用同一个结构。 */
export interface Snapshot {
  /** 格式版本号，用于以后平滑升级格式。 */
  schema: number;
  /** 内容指纹。内容一样则指纹一样，用来快速判断"有没有变化"。 */
  revision: string;
  generatedAt: string;
  deviceId: string;
  deviceName: string;
  entries: Entry[];
}

export interface DeviceInfo {
  deviceId: string;
  deviceName: string;
}

// ---------------------------------------------------------------------------
// 同步
// ---------------------------------------------------------------------------

/** 冲突涉及的字段。 */
export type ConflictField = 'kind' | 'title' | 'url' | 'parent';

/**
 * 一个需要用户裁决的冲突。
 *
 * - `fields`：同一把书签两端都改了，而且改的不是同一件事。
 * - `delete-modify`：一端删了，另一端改了（改动可能丢失，必须问）。
 */
export interface Conflict {
  id: string;
  kind: 'fields' | 'delete-modify';
  uid: string;
  /** 给界面看的名字。 */
  label: string;
  /** kind === 'fields' 时，具体哪些字段吵起来了。 */
  fields: ConflictField[];
  base: Entry | null;
  local: Entry | null;
  remote: Entry | null;
}

/** 用户对单个冲突的选择。 */
export type Resolution = 'local' | 'remote' | 'both';

/** 合并过程中产生的提示（不是错误，但用户应该知道）。 */
export interface MergeWarning {
  code: string;
  message: string;
  uids?: string[];
}

export interface MergeResult {
  /** 合并后的完整结果（已修复层级、已重排 index）。 */
  entries: Entry[];
  conflicts: Conflict[];
  warnings: MergeWarning[];
}

/** 首次同步时"本地这条 = 远端那条"的配对结果。 */
export interface IdentityLink {
  localUid: string;
  remoteUid: string;
}

/** 自动冲突策略。 */
export type ConflictPolicy = 'ask' | 'prefer-local' | 'prefer-remote';

/** 首次同步（本地还没有同步基准）时的策略。 */
export type FirstSyncStrategy = 'merge' | 'local-wins' | 'remote-wins';

/**
 * 界面主题。
 * - `system`：跟随操作系统的深浅色设置（默认）
 * - `light` / `dark`：强制浅色 / 深色
 */
export type ThemeMode = 'system' | 'light' | 'dark';

/** Token 的来源，只用于在界面上说明"这个 Token 是怎么来的"。 */
export type AuthMethod = 'pat' | 'oauth';

/**
 * 正在进行的 GitHub 设备授权（"用 GitHub 账号授权"）。
 *
 * 刻意存在存储里而不是内存变量里：后台 Service Worker 随时可能被浏览器回收，
 * 存在内存里的话轮询状态就丢了，用户得重来一遍。
 */
export interface PendingDeviceAuth {
  clientId: string;
  /** 长码，用于向 GitHub 换 token，不给用户看。 */
  deviceCode: string;
  /** 短码，显示给用户填到 GitHub 页面上。 */
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string | null;
  /** 当前轮询间隔（秒），收到 slow_down 会变大。 */
  interval: number;
  /** 过期时间（毫秒时间戳）。 */
  expiresAt: number;
  startedAt: string;
}

/**
 * OAuth 授权换来的凭据的附加信息。
 *
 * 只有 OAuth App 开启了 "Expiring user tokens" 时才会有内容：
 * 那种情况下 access token 只有 8 小时有效期，需要靠 refresh token 续期。
 * 默认是关闭的，本项目也建议保持关闭（否则书签同步每 8 小时就要重新授权一次）。
 */
export interface OAuthTokenMeta {
  clientId: string;
  refreshToken: string | null;
  /** access token 的过期时间（毫秒时间戳）；永不过期时为 null。 */
  expiresAt: number | null;
}

// ---------------------------------------------------------------------------
// 设置与状态
// ---------------------------------------------------------------------------

export interface Settings {
  /** 设备名字，会写在 Gist 里，方便你知道"上次是谁推的"。 */
  deviceName: string;
  /** 界面主题。 */
  theme: ThemeMode;
  /** 是否开启定时合并同步。 */
  autoSyncEnabled: boolean;
  /** 定时同步间隔（分钟）。 */
  autoSyncIntervalMinutes: number;
  /** 本地书签发生变化后是否自动同步。 */
  autoUploadOnChange: boolean;
  conflictPolicy: ConflictPolicy;
  firstSyncStrategy: FirstSyncStrategy;
  /** 变更记录最多保留多少条。 */
  changeLogLimit: number;
  /**
   * OAuth 授权时使用的 GitHub OAuth App 的 client_id。
   * client_id 是公开信息（不是密钥），可以放心填；留空则只能用 PAT 方式。
   */
  oauthClientId: string;
}

export type SyncStatus =
  | 'unconfigured' // 还没填 Token
  | 'idle'
  | 'syncing'
  | 'conflict' // 有冲突等用户裁决
  | 'error';

export interface SyncState {
  status: SyncStatus;
  /** 同步进行到哪一步了（给人看的文案）。 */
  phase: string | null;
  lastSyncAt: string | null;
  lastError: string | null;
  /** 上一次成功同步时，远端文件的指纹。 */
  lastSyncedRevision: string | null;
  /** 远端文件当前的指纹（每次读远端都会更新）。 */
  remoteRevision: string | null;
  /** 远端最后是被哪台设备、什么时候写的。 */
  remoteDeviceName: string | null;
  remoteUpdatedAt: string | null;
  /** 待用户解决的冲突数量。 */
  conflictCount: number;
  /** 本地有没有还没推上去的改动。 */
  dirty: boolean;
  gistId: string | null;
  gistUrl: string | null;
  /** 本地书签条数，界面上展示用。 */
  entryCount: number;
  /** 正在同步的操作类型。 */
  runningMode: SyncMode | null;
}

export type SyncMode = 'merge' | 'push' | 'pull';

/** 一次同步的历史记录。 */
export interface SyncLogEntry {
  id: string;
  at: string;
  mode: SyncMode;
  ok: boolean;
  added: number;
  updated: number;
  removed: number;
  moved: number;
  pushed: boolean;
  conflictCount: number;
  error: string | null;
}

/** 本地书签变更记录（由 chrome.bookmarks 事件产生）。 */
export type ChangeAction = 'create' | 'remove' | 'update' | 'move';

export interface ChangeRecord {
  id: string;
  action: ChangeAction;
  /** 发生变更的浏览器节点 id（原始 id，排查问题时有用）。 */
  browserId: string;
  title: string;
  url: string | null;
  at: string;
}

/** 一次同步改动量的统计。 */
export interface ChangeCounts {
  added: number;
  updated: number;
  removed: number;
  moved: number;
}

// ---------------------------------------------------------------------------
// 待用户处理的同步（存在本地，界面读取后渲染冲突列表）
// ---------------------------------------------------------------------------

export interface PendingSync {
  id: string;
  createdAt: string;
  /** 已经自动合并完成、但还没写回本地的结果。 */
  merged: Entry[];
  conflicts: Conflict[];
  warnings: MergeWarning[];
  remoteRevision: string;
  baseRevision: string;
  localSnapshot: Snapshot;
  remoteSnapshot: Snapshot;
}

// ---------------------------------------------------------------------------
// 同步报告 / 错误
// ---------------------------------------------------------------------------

export interface SyncOutcome {
  ok: boolean;
  mode: SyncMode;
  /** 需要用户先确认（例如覆盖远端会把别人的改动冲掉）。 */
  needsConfirm: 'overwrite-remote' | 'overwrite-local' | null;
  counts: ChangeCounts;
  pushed: boolean;
  conflictCount: number;
  warnings: MergeWarning[];
  error: string | null;
}

/** 有业务含义的错误，界面可以根据 code 给出更友好的提示。 */
export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public detail?: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}
