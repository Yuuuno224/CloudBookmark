# CloudBookmark — 基于 GitHub Gist 的浏览器书签扩展技术方案

## 1. 文档信息

| 项目 | 内容 |
|------|------|
| 文档类型 | 技术设计文档 (TDD) |
| 项目名称 | CloudBookmark — 浏览器书签云端同步扩展 |
| 版本 | v1.0 |
| 日期 | 2026-06-03 |
| 状态 | 初稿 |

---

## 2. 背景与目标

### 2.1 背景

浏览器书签是用户日常浏览的重要资产，但主流浏览器（Chrome / Firefox / Edge）的原生同步机制存在以下痛点：

- 需要登录厂商账号，隐私敏感用户不愿使用
- 跨浏览器同步不支持（Chrome 书签无法同步到 Firefox）
- 企业环境或受限网络下原生同步可能被禁用
- 数据完全托管在厂商服务器，用户无法自主控制

GitHub Gist 提供了免费的、基于 Git 版本控制的文本存储服务，其 API 开放、无需付费、天然支持版本历史，是轻量级个人数据同步的理想后端。

### 2.2 目标

设计并实现一款浏览器扩展程序，以 GitHub Gist 作为唯一数据存储后端，实现：

1. 书签数据的云端持久化存储
2. 多设备、多浏览器之间的自动同步
3. 数据冲突的检测与自动/手动解决
4. Token 的安全存储与最小权限管理
5. 离线可用、在线自动同步的体验

---

## 3. 系统整体架构设计

### 3.1 架构总览

系统采用 **扩展前端 + Gist 后端** 的无服务器架构，整体分为四层：

```
┌─────────────────────────────────────────────────┐
│                  UI 层 (Popup / SidePanel)       │
│  ┌──────────┐ ┌──────────┐ ┌──────────────────┐ │
│  │ 书签管理  │ │ 同步状态  │ │ 设置 / Token 管理│ │
│  └──────────┘ └──────────┘ └──────────────────┘ │
├─────────────────────────────────────────────────┤
│              业务逻辑层 (Service Worker)          │
│  ┌──────────┐ ┌──────────┐ ┌──────────────────┐ │
│  │ SyncEngine│ │ConflictRes│ │ BookmarkManager │ │
│  └──────────┘ └──────────┘ └──────────────────┘ │
├─────────────────────────────────────────────────┤
│              数据层 (Storage Abstraction)         │
│  ┌──────────┐ ┌──────────┐ ┌──────────────────┐ │
│  │ LocalStore│ │ GistStore │ │  SyncMetaStore  │ │
│  └──────────┘ └──────────┘ └──────────────────┘ │
├─────────────────────────────────────────────────┤
│              通信层 (API Client)                  │
│  ┌──────────────────────────────────────────────┐ │
│  │         GitHub REST API v3 (Gist Endpoint)   │ │
│  └──────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────┘
```

### 3.2 核心模块职责

| 模块 | 职责 | 关键技术 |
|------|------|----------|
| **BookmarkManager** | 管理本地书签 CRUD，监听浏览器书签变更事件 | `chrome.bookmarks` API |
| **SyncEngine** | 编排同步流程：拉取远端 → 冲突检测 → 合并 → 推送 | 定时调度 + 事件触发 |
| **ConflictResolver** | 检测并解决本地与远端的数据冲突 | 三向合并 + 时间戳策略 |
| **LocalStore** | 本地数据持久化（书签树 + 同步元数据） | `chrome.storage.local` / IndexedDB |
| **GistStore** | 封装 Gist API 的数据读写操作 | GitHub REST API v3 |
| **TokenManager** | PAT 的安全存储、验证与权限检查 | `chrome.storage.session` + 加密 |

### 3.3 核心工作流程

#### 3.3.1 首次启动流程

```
用户安装扩展 → 展示引导页 → 输入 GitHub PAT
    → 验证 Token 有效性及 gist 权限
    → 搜索/创建专用 Gist（描述标记: "cloudbookmark-sync"）
    → 拉取远端数据或上传本地书签（首次以本地为准）
    → 写入同步元数据 → 进入正常同步循环
```

#### 3.3.2 常规同步流程（双向增量同步）

```
触发同步（定时 / 事件 / 手动）
    → Step 1: 读取本地 lastSyncVersion (Gist commit SHA)
    → Step 2: GET /gists/:id → 获取远端 Gist 当前内容与 history
    → Step 3: 比较 lastSyncVersion 与远端最新 commit SHA
        → 相同：无远端变更，仅推送本地变更（如有）
        → 不同：存在远端变更，进入冲突检测
    → Step 4: 冲突检测
        → 本地有未推送变更 AND 远端有新变更 → 冲突
        → 仅一方有变更 → 无冲突，直接合并
    → Step 5: 冲突解决（详见第5节）
    → Step 6: 合并结果写入本地 + 推送至 Gist
    → Step 7: 更新 lastSyncVersion 为新 commit SHA
```

#### 3.3.3 书签变更事件流

```
浏览器书签变更 (onCreated / onRemoved / onMoved / onChanged)
    → 防抖聚合（500ms 窗口）
    → 标记本地 dirty = true
    → 触发同步引擎执行推送
```

---

## 4. GitHub Gist API 集成方法与数据读写交互机制

### 4.1 Gist 数据模型设计

每个用户使用 **一个专用 Gist** 存储全部书签数据，Gist 结构如下：

```
Gist Description: "cloudbookmark-sync"
Gist Files:
  ├── bookmarks.json      ← 书签树完整数据（主文件）
  ├── metadata.json       ← 同步元数据（设备ID、时间戳等）
  └── deleted.json        ← 已删除书签的墓碑记录（软删除）
```

#### bookmarks.json 结构

```json
{
  "version": 3,
  "updatedAt": "2026-06-03T12:00:00Z",
  "checksum": "sha256:abc123...",
  "roots": {
    "bookmark_bar": {
      "id": "1",
      "title": "书签栏",
      "type": "folder",
      "children": [
        {
          "id": "2",
          "title": "GitHub",
          "type": "bookmark",
          "url": "https://github.com",
          "createdAt": "2026-01-01T00:00:00Z",
          "updatedAt": "2026-01-01T00:00:00Z"
        }
      ]
    },
    "other": { ... },
    "mobile": { ... }
  }
}
```

#### metadata.json 结构

```json
{
  "schemaVersion": 1,
  "devices": {
    "device-abc123": {
      "name": "Chrome on Windows",
      "lastSyncAt": "2026-06-03T12:00:00Z",
      "lastSyncVersion": "a1b2c3d4..."
    }
  }
}
```

#### deleted.json 结构（墓碑记录）

```json
{
  "tombstones": [
    {
      "id": "bookmark-id-xyz",
      "deletedAt": "2026-06-02T08:00:00Z",
      "deletedBy": "device-abc123"
    }
  ]
}
```

### 4.2 核心 API 调用

| 操作 | API 端点 | 方法 | 说明 |
|------|----------|------|------|
| 查找专用 Gist | `GET /users/:username/gists` | GET | 遍历用户 Gist 列表，匹配 description 为 "cloudbookmark-sync" |
| 创建 Gist | `POST /gists` | POST | 首次使用时创建，设置 `public: false` |
| 读取 Gist | `GET /gists/:id` | GET | 获取当前最新内容 |
| 读取特定版本 | `GET /gists/:id/:sha` | GET | 获取指定 commit 版本的内容 |
| 更新 Gist | `PATCH /gists/:id` | PATCH | 仅更新变更的文件内容 |
| 获取历史 | `GET /gists/:id/commits` | GET | 获取最近 commit 历史，用于冲突检测 |
| 列出 Gist 所有 commit | `GET /gists/:id/commits?per_page=100` | GET | 分页获取历史版本 |

### 4.3 API 请求规范

- **基础 URL**: `https://api.github.com`
- **认证方式**: `Authorization: Bearer <PAT>`（Header）
- **版本标识**: `Accept: application/vnd.github.v3+json`
- **速率限制**: GitHub API 限制 5000 次/小时（认证用户），需实现速率限制监控
- **分页处理**: 遵循 `Link` Header 进行分页遍历

### 4.4 读写交互机制

#### 读取流程（Pull）

1. `GET /gists/:id` 获取 Gist 最新内容
2. 解析 `bookmarks.json` → 反序列化为书签树结构
3. 解析 `deleted.json` → 获取墓碑列表
4. 与本地数据合并（详见冲突解决章节）
5. 应用墓碑：删除本地已标记删除的书签
6. 更新本地存储与 `lastSyncVersion`

#### 写入流程（Push）

1. 序列化本地书签树为 `bookmarks.json`
2. 计算内容 checksum（SHA-256），与上次推送的 checksum 比对
3. 若无变更则跳过推送（避免空提交）
4. `PATCH /gists/:id` 仅发送变更的文件内容
5. 记录返回的最新 commit SHA 为 `lastSyncVersion`

#### 乐观锁机制

Gist API 本身不提供 ETag 或版本锁，因此采用 **SHA-based 乐观锁**：

```
推送前:
  1. GET /gists/:id → 获取远端当前 SHA
  2. 若远端 SHA != 本地记录的 lastSyncVersion → 存在远端变更
  3. 先执行合并，再推送
  4. 推送后再次验证返回的 SHA 是否连续
```

### 4.5 API 速率限制处理

```javascript
// 速率限制监控
function checkRateLimit(response) {
  const remaining = parseInt(response.headers.get('x-ratelimit-remaining'));
  const resetAt = parseInt(response.headers.get('x-ratelimit-reset')) * 1000;
  
  if (remaining < 100) {
    // 进入节流模式：降低同步频率
    adjustSyncInterval(resetAt);
  }
  if (remaining === 0) {
    // 完全限流：等待 reset 时间后重试
    scheduleRetryAfter(resetAt - Date.now());
  }
}
```

---

## 5. 多设备并发同步时的数据冲突检测与解决策略

### 5.1 冲突场景分类

| 场景 | 描述 | 严重程度 |
|------|------|----------|
| **A. 双端同增** | 设备A和设备B同时新增不同书签 | 低 — 可自动合并 |
| **B. 双端同删** | 设备A和设备B同时删除同一书签 | 低 — 幂等操作，无冲突 |
| **C. 一增一删** | 设备A新增子书签，设备B删除其父文件夹 | 高 — 需要用户决策 |
| **D. 双端同改** | 设备A和设备B同时修改同一书签的属性 | 中 — 可自动合并或需用户选择 |
| **E. 结构冲突** | 设备A移动书签到文件夹X，设备B移动同一书签到文件夹Y | 高 — 需要用户决策 |

### 5.2 冲突检测机制

采用 **基于版本的三向比较** 检测冲突：

```
三方: Base（上次同步版本）, Local（当前本地）, Remote（当前远端）

1. 获取 Base 版本内容: GET /gists/:id/:lastSyncVersion
2. 分别计算 Local 与 Base 的差分 (localDiff)
3. 分别计算 Remote 与 Base 的差分 (remoteDiff)
4. 检测 localDiff 与 remoteDiff 是否操作了相同对象
   → 操作不同对象 → 无冲突
   → 操作相同对象但操作兼容（如双方都删除）→ 无冲突
   → 操作相同对象且操作不兼容 → 冲突，进入解决流程
```

### 5.3 冲突解决策略

#### 策略一：自动合并（适用于场景 A / B / 部分D）

**规则**：
- 新增操作：合并两方新增的书签（ID 不同则直接合并）
- 删除操作：取并集（双方删除的都是要删除的）
- 属性修改：对同一书签的不同字段修改可合并（如 A 改 title，B 改 url）
- 同一字段修改：采用 **Last-Write-Wins (LWW)** 策略，以 `updatedAt` 时间戳较晚者为准

#### 策略二：结构冲突自动降级（适用于场景 C / E）

**规则**：
- 一增一删：保留新增书签，将其移至根节点（书签栏），并标记为"冲突恢复项"
- 移动冲突：保留最新时间戳的移动操作，另一方移动目标记录在 `metadata.json` 的 `conflictLog` 中

#### 策略三：用户手动解决（高冲突场景）

当自动解决可能导致数据丢失时，弹出冲突解决界面：

```
┌──────────────────────────────────────────┐
│  同步冲突 detected                        │
│                                          │
│  书签 "GitHub" 存在冲突:                  │
│                                          │
│  本地版本:  url=github.com, 文件夹=Dev    │
│  远端版本:  url=github.io, 文件夹=Work    │
│                                          │
│  ○ 保留本地版本                           │
│  ○ 保留远端版本                           │
│  ○ 保留两者（创建副本）                   │
│                                          │
│  [应用] [全部保留本地] [全部保留远端]      │
└──────────────────────────────────────────┘
```

### 5.4 墓碑机制（软删除）

为防止"删除同步"的丢失问题（设备A删除书签后同步到设备B，但设备B尚未拉取就新增了同名书签），采用墓碑记录：

1. 删除操作不直接移除书签，而是在 `deleted.json` 中记录墓碑
2. 同步时先应用远端墓碑（删除本地对应项），再应用远端新增
3. 墓碑保留 30 天，过期后由 Gist 维护任务清理
4. 墓碑的 `deletedAt` 时间戳用于与新增操作的时间戳比较，决定最终状态

### 5.5 同步锁与防重入

```javascript
// Service Worker 中的同步锁
class SyncEngine {
  #syncPromise = null;

  async sync() {
    if (this.#syncPromise) {
      return this.#syncPromise; // 防重入：复用正在进行的同步
    }
    this.#syncPromise = this._doSync();
    try {
      return await this.#syncPromise;
    } finally {
      this.#syncPromise = null;
    }
  }
}
```

---

## 6. GitHub Personal Access Token 的安全存储与权限管理机制

### 6.1 Token 权限要求

| 权限 (Scope) | 必要性 | 说明 |
|---------------|--------|------|
| `gist` | **必须** | 创建、读取、更新 Gist |
| 其他权限 | **禁止** | 不请求任何额外权限，遵循最小权限原则 |

创建 PAT 时的推荐设置：
- **Fine-grained token**（优先）：Account permissions → Gists → Read and Write
- **Classic token**：仅勾选 `gist` scope

### 6.2 Token 安全存储方案

#### 存储层级

| 存储位置 | 用途 | 生命周期 | 安全性 |
|----------|------|----------|--------|
| `chrome.storage.session` | 运行时 Token 缓存 | 扩展进程生命周期（Service Worker 重启后清除） | 高 — 不持久化到磁盘 |
| `chrome.storage.local` (加密) | 持久化存储 | 永久（直到用户移除） | 中 — 加密存储，需主密钥 |
| 用户手动输入 | 首次配置 / 重新配置 | 用户控制 | — |

#### 加密方案

采用 **Web Crypto API** 进行 AES-GCM 加密：

```javascript
// 加密流程
async function encryptToken(token, masterKey) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey(
    'raw', masterKey, 'AES-GCM', false, ['encrypt']
  );
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, key, new TextEncoder().encode(token)
  );
  return { iv: arrayBufferToBase64(iv), data: arrayBufferToBase64(encrypted) };
}

// 主密钥来源：基于扩展 ID + 用户机器特征派生
async function deriveMasterKey() {
  const extensionId = chrome.runtime.id;
  const machineInfo = await getMachineSpecificInfo(); // 如安装时间戳
  const seed = new TextEncoder().encode(extensionId + machineInfo);
  const keyMaterial = await crypto.subtle.importKey(
    'raw', seed, 'PBKDF2', false, ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: seed, iterations: 100000, hash: 'SHA-256' },
    keyMaterial, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
  );
}
```

#### Token 生命周期管理

```
安装扩展
  → 用户输入 PAT
  → 验证 Token（调用 GET /user 验证有效性 + 检查 gist 权限）
  → 加密后存储到 chrome.storage.local
  → 运行时解密到 chrome.storage.session（Service Worker 启动时）
  → 每次同步前检查 Token 有效性
  → Token 失效时通知用户重新配置
  → 用户卸载扩展 → chrome.storage 自动清除
```

### 6.3 Token 安全最佳实践

1. **永不将 Token 写入 DOM**：所有 API 调用在 Service Worker 中完成
2. **永不将 Token 写入 console.log**：生产构建移除所有调试日志
3. **不通过消息传递明文 Token**：content script 与 Service Worker 通信时传递操作指令而非 Token
4. **Token 轮换提醒**：检测 Token 过期时间（通过 API 响应头），提前提醒用户轮换
5. **导出/备份排除 Token**：扩展的导出功能不包含 Token
6. **CSP 策略**：manifest.json 中设置严格的 content_security_policy，防止 XSS 窃取

```json
{
  "content_security_policy": {
    "extension_pages": "script-src 'self'; object-src 'self'; connect-src https://api.github.com"
  }
}
```

### 6.4 Token 验证与错误处理

```javascript
async function validateToken(token) {
  const response = await fetch('https://api.github.com/user', {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  
  if (!response.ok) {
    if (response.status === 401) throw new TokenError('INVALID');
    if (response.status === 403) throw new TokenError('EXPIRED_OR_REVOKED');
  }
  
  // 检查 gist 权限
  const scopes = response.headers.get('x-oauth-scopes')?.split(', ') || [];
  if (!scopes.includes('gist')) {
    throw new TokenError('MISSING_GIST_SCOPE');
  }
  
  return await response.json();
}
```

---

## 7. 特性、适用场景、优势与局限性

### 7.1 核心特性

| 特性 | 说明 |
|------|------|
| **零服务器成本** | 完全基于 GitHub Gist，无需自建或租用任何服务器 |
| **跨浏览器支持** | 基于 WebExtension API，支持 Chrome / Firefox / Edge |
| **跨设备同步** | 任意设备安装扩展 + 同一 PAT 即可同步 |
| **版本历史** | Gist 天然支持 Git 版本历史，可回溯任意版本 |
| **离线优先** | 本地优先读写，在线时自动同步 |
| **数据自主** | 数据存储在用户自己的 GitHub 账号下，完全可控 |
| **隐私保护** | Gist 设置为 secret（非公开），数据仅用户可见 |
| **轻量级** | 扩展包体积极小（< 500KB），无重型依赖 |

### 7.2 适用场景

| 场景 | 说明 |
|------|------|
| **个人开发者** | 已有 GitHub 账号，希望简单同步书签而不额外注册服务 |
| **多浏览器用户** | 同时使用 Chrome + Firefox，需要书签互通 |
| **隐私敏感用户** | 不信任浏览器厂商的云端同步，希望数据自管 |
| **企业受限环境** | 浏览器原生同步被 IT 策略禁用，但 GitHub 可访问 |
| **书签版本管理** | 需要书签的历史版本和回滚能力 |
| **临时设备** | 在公共/临时电脑上快速恢复个人书签 |

### 7.3 优势

1. **零运维成本**：无需部署、维护、监控任何服务器
2. **天然版本控制**：Gist 基于 Git，每次更新自动产生 commit，支持历史回溯
3. **数据可移植**：标准 JSON 格式，可随时导出/迁移到其他服务
4. **API 稳定**：GitHub REST API v3 是成熟稳定的公开 API
5. **安全传输**：全链路 HTTPS，Token 认证
6. **免费额度充足**：GitHub 免费账户即可使用 Gist API，速率限制 5000 次/小时
7. **无需注册新账号**：GitHub 用户直接复用现有账号

### 7.4 局限性

| 局限性 | 影响 | 缓解措施 |
|--------|------|----------|
| **单文件 1MB 限制** | 超大书签集（>1MB JSON）无法存储 | 分片存储（多文件拆分）；实际场景下 1MB 可容纳约 10000+ 书签 |
| **API 速率限制** | 5000 次/小时，高频同步可能触及 | 智能节流：仅在变更时同步，合并短时间内的多次变更 |
| **无实时推送** | Gist 无 WebSocket/Webhook 推送能力 | 轮询间隔可配置（默认 5 分钟），结合事件触发 |
| **依赖 GitHub 可用性** | GitHub 宕机时无法同步 | 离线优先设计：本地正常使用，恢复后自动同步 |
| **Token 安全性** | PAT 存储在扩展本地，存在被提取风险 | 加密存储 + 最小权限 + 严格 CSP |
| **无协作能力** | 不支持多用户共享书签 | 可通过公开 Gist 实现只读共享 |
| **Gist 数量限制** | 单用户无限制，但大量 Gist 管理不便 | 仅使用 1 个 Gist，结构化管理 |
| **Service Worker 生命周期** | MV3 下 Service Worker 可能被杀，影响定时同步 | 使用 `chrome.alarms` API 替代 setInterval |
| **首次同步延迟** | 新设备首次同步需下载完整书签数据 | 增量同步优化（仅传输差分） |

---

## 8. 与其他云端同步方案的对比分析

### 8.1 方案概览

| 维度 | GitHub Gist | WebDAV | 自建后端服务器 | 浏览器原生同步 | 云存储（S3/R2） |
|------|-------------|--------|----------------|----------------|-----------------|
| **成本** | 免费 | 免费/低费（取决于托管） | 服务器费用 + 运维成本 | 免费 | 按量计费 |
| **运维** | 零运维 | 需维护 WebDAV 服务 | 需全栈运维 | 零运维 | 低运维 |
| **API 复杂度** | 低（REST） | 中（WebDAV 协议） | 自定义 | 无（内置） | 低（REST/S3） |
| **版本历史** | 天然支持（Git） | 部分支持（依赖服务器） | 需自行实现 | 有限 | 需自行实现 |
| **冲突解决** | 需自行实现 | 需自行实现 | 可服务端辅助 | 厂商实现 | 需自行实现 |
| **实时性** | 轮询（无推送） | 轮询 | WebSocket 推送 | 实时 | 事件通知 |
| **跨浏览器** | 支持 | 支持 | 支持 | 仅同厂商 | 支持 |
| **数据主权** | 用户完全控制 | 用户控制 | 用户控制 | 厂商控制 | 用户控制 |
| **速率限制** | 5000次/时 | 取决于服务 | 自定义 | 无感 | 按配额 |
| **单文件大小** | 1MB | 取决于服务 | 自定义 | 无感 | TB 级 |
| **认证方式** | PAT | HTTP Basic/Digest | 自定义 | OAuth | AK/SK |
| **隐私性** | Secret Gist | 取决于服务 | 取决于部署 | 厂商托管 | 取决于配置 |

### 8.2 详细对比

#### GitHub Gist vs WebDAV

| 对比项 | Gist 优势 | WebDAV 优势 |
|--------|-----------|-------------|
| 部署 | 零配置，无需自建服务 | 可使用坚果云等现成 WebDAV 服务 |
| 版本 | 天然 Git 版本历史 | 需服务端额外支持 |
| 协议 | HTTPS + JSON，开发简单 | WebDAV 协议复杂（LOCK/UNLOCK/PROPFIND） |
| 容量 | 1MB/文件限制 | 通常无此限制 |
| 生态 | GitHub 生态，开发者友好 | 通用协议，NAS/网盘广泛支持 |

**结论**：Gist 更适合开发者个人使用，WebDAV 更适合需要大容量或已有 NAS/网盘基础设施的用户。

#### GitHub Gist vs 自建后端服务器

| 对比项 | Gist 优势 | 自建后端优势 |
|--------|-----------|-------------|
| 成本 | 零成本 | 需服务器费用 |
| 运维 | 零运维 | 需持续运维 |
| 实时性 | 轮询 | 可 WebSocket 实时推送 |
| 冲突 | 客户端解决 | 可服务端辅助（OT/CRDT） |
| 定制 | 受限于 Gist API | 完全自定义 |
| 扩展 | 单用户场景 | 可支持多用户协作 |
| 可靠性 | 依赖 GitHub SLA | 自主控制 |

**结论**：Gist 适合个人轻量场景，自建后端适合团队协作或需要实时性/高定制化的场景。

#### GitHub Gist vs 浏览器原生同步

| 对比项 | Gist 优势 | 原生同步优势 |
|--------|-----------|-------------|
| 跨浏览器 | 支持 | 不支持 |
| 隐私 | 数据自管 | 数据托管在厂商 |
| 依赖 | 需 GitHub 账号 | 需厂商账号 |
| 体验 | 需安装扩展 | 开箱即用 |
| 实时性 | 轮询（分钟级） | 实时 |
| 冲突 | 透明可控 | 黑盒处理 |
| 稳定性 | 依赖 GitHub | 厂商保障 |

**结论**：原生同步适合普通用户开箱即用，Gist 方案适合隐私敏感、跨浏览器或有数据自主需求的用户。

### 8.3 方案选型建议

```
个人开发者 + 已有 GitHub 账号 + 无实时性要求
  → 推荐 GitHub Gist 方案 ✅

需要大容量存储 + 已有 NAS/网盘
  → 推荐 WebDAV 方案

团队协作 + 实时同步 + 有开发资源
  → 推荐自建后端方案

普通用户 + 单浏览器 + 无隐私顾虑
  → 推荐浏览器原生同步
```

---

## 9. 技术选型与实现规范

### 9.1 技术栈

| 层面 | 选型 | 理由 |
|------|------|------|
| 扩展框架 | Manifest V3 | Chrome 最新标准，长期支持 |
| 语言 | TypeScript | 类型安全，提升代码质量与可维护性 |
| 构建 | Vite + CRXJS | 快速构建 + 扩展 HMR 开发体验 |
| UI | Solid.js | 轻量级响应式框架，包体积小 |
| 样式 | TailwindCSS | 原子化 CSS，快速开发 |
| 状态管理 | Zustand | 轻量级，TypeScript 友好 |
| 本地存储 | IndexedDB (via idb) | 支持结构化大数据存储 |
| 加密 | Web Crypto API | 浏览器原生，无需外部依赖 |
| 测试 | Vitest + Playwright | 单元测试 + E2E 测试 |
| Lint | ESLint + Prettier | 代码规范 |

### 9.2 Manifest V3 关键配置

```json
{
  "manifest_version": 3,
  "name": "CloudBookmark",
  "version": "1.0.0",
  "permissions": [
    "bookmarks",
    "storage",
    "alarms",
    "identity"
  ],
  "background": {
    "service_worker": "src/background/sw.ts",
    "type": "module"
  },
  "action": {
    "default_popup": "src/popup/index.html"
  },
  "content_security_policy": {
    "extension_pages": "script-src 'self'; object-src 'self'; connect-src https://api.github.com"
  }
}
```

### 9.3 定时同步（MV3 兼容）

```javascript
// 注册定时同步（替代 setInterval，兼容 Service Worker 生命周期）
chrome.alarms.create('sync', {
  periodInMinutes: 5,  // 每5分钟同步一次
  delayInMinutes: 0.1
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'sync') {
    syncEngine.sync();
  }
});
```

---

## 10. 风险与缓解

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|----------|
| GitHub API 不可用 | 低 | 高 | 离线优先设计；本地数据完整可用；恢复后自动同步 |
| PAT 泄露 | 中 | 高 | 加密存储；最小权限（仅 gist）；CSP 防注入；支持快速轮换 |
| 书签数据超过 1MB | 低 | 中 | 数据分片；压缩存储；超出时警告用户 |
| API 速率耗尽 | 中 | 中 | 智能节流；变更聚合推送；速率余量监控 |
| Gist 被意外删除 | 极低 | 高 | 本地保留完整副本；检测到 Gist 丢失时自动重建 |
| 浏览器 API 变更 | 低 | 中 | 抽象层隔离浏览器 API；MV3 标准已稳定 |
| Service Worker 休眠 | 必然 | 低 | chrome.alarms API 替代定时器；事件驱动唤醒 |

---

## 11. 开放问题与后续演进

| 问题 | 状态 | 备注 |
|------|------|------|
| 是否支持书签标签/颜色标记 | 待定 | 需扩展数据模型，可能超出浏览器原生 bookmark 能力 |
| 是否支持书签分享（公开 Gist） | 待定 | 安全与隐私需评估 |
| 是否支持 Firefox Account 免 Token 同步 | 待定 | 需浏览器特定 API |
| 数据分片策略的具体实现 | 待设计 | 当书签数据接近 1MB 时需启动 |
| 增量同步（仅传输差分） | 待设计 | 当前为全量同步，大书签集下效率待优化 |
| 移动端支持 | 待评估 | iOS/Android 浏览器扩展生态有限 |
