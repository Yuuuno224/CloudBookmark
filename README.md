# CloudBookmark

基于 GitHub Gist 的浏览器书签云端同步扩展，支持 Chrome 与 Edge 跨设备、跨浏览器同步。

## 特性

- **零服务器成本** — 数据存储在 GitHub Gist，无需自建后端
- **跨浏览器** — 支持 Google Chrome 与 Microsoft Edge
- **双模式同步** — 合并同步（三向合并）与拆分上传/下载（覆盖式）两种模式
- **冲突交互解决** — 同步冲突时弹出界面，逐项选择保留本地/使用远端/保留两者
- **URL 去重** — 相同 URL 的书签不会重复添加
- **变更记录** — 追踪书签的创建、删除、更新、移动操作，支持统计
- **版本历史** — Gist 天然支持 Git 版本历史，可回溯任意版本
- **数据自主** — 数据存储在用户自己的 GitHub 账号下，完全可控
- **Token 安全** — AES-GCM 加密存储，仅请求 gist 最小权限
- **竞态安全** — 互斥锁 + 版本守卫，防止快速连续点击导致状态异常

## 安装

### 从 Release 下载（推荐）

前往 [Releases](https://github.com/Yuuuno224/CloudBookmark/releases) 页面下载最新版本的 zip 包，解压后加载为浏览器扩展。

### 从源码构建

```bash
git clone https://github.com/Yuuuno224/CloudBookmark.git
cd CloudBookmark
npm install
npm run build
```

### 加载扩展

1. 打开 `chrome://extensions/`（Chrome）或 `edge://extensions/`（Edge）
2. 开启右上角 **开发者模式**
3. 点击 **加载已解压的扩展程序**
4. 选择项目的 `dist` 目录（或解压后的 Release 目录）

## 使用

1. 点击扩展图标，进入设置页
2. 输入 GitHub Personal Access Token（仅需 `gist` 权限）
3. 点击 **保存并验证**
4. 切换到书签页，选择同步模式并执行操作

### 创建 GitHub Token

1. 前往 GitHub → Settings → Developer settings → Personal access tokens → **Tokens (classic)**
2. 点击 **Generate new token**
3. 仅勾选 `gist` 权限
4. 生成并复制 Token

## 同步模式

### 合并同步

采用**手动触发 + 三向合并**策略：

1. 读取远端 Gist 数据（remote）和本地浏览器书签（local）
2. 读取上次同步基准态（base）
3. 执行三向合并：`merge(base, local, remote)` → 合并结果
4. 将合并结果应用到本地浏览器并推送到 Gist
5. 更新 base 为当前状态

冲突时按 `updatedAt` 时间戳 Last-Write-Wins 自动解决，或暂停等待用户选择。

### 拆分上传/下载

独立的单向覆盖操作，不做合并：

- **上传** — 将本地书签树完整覆盖到 Gist
- **下载** — 将远端书签树完整覆盖到本地浏览器

适合需要强制同步一端数据的场景。

### 冲突解决

当合并同步或下载检测到冲突时，弹出冲突解决界面：

- 每个冲突项并排展示本地与远端内容
- 三种选择：**保留本地** / **使用远端** / **保留两者**
- 全部选择后点击"应用选择"提交

## 跨浏览器兼容

通过 UserAgent 检测浏览器类型，使用位置索引（而非名称）识别书签根节点：

| 位置索引 | 规范 ID | Chrome 名称 | Edge 名称 |
|----------|---------|-------------|-----------|
| `children[0]` | `bookmark_bar` | 书签栏 | 收藏夹栏 |
| `children[1]` | `other` | 其他书签 | 其他收藏夹 |
| `children[2]` | `mobile` | 移动设备书签 | 移动设备收藏夹 |

## 技术栈

| 类别 | 技术 |
|------|------|
| 语言 | TypeScript |
| UI 框架 | Solid.js |
| 构建 | Vite 8 + CRXJS 2.4 |
| 样式 | TailwindCSS |
| 扩展标准 | Chrome Manifest V3 |
| 本地存储 | IndexedDB (via idb) |
| 加密 | Web Crypto API (AES-GCM + PBKDF2) |

## 开发

```bash
# 安装依赖
npm install

# 开发模式（HMR）
npm run dev

# 类型检查
npm run typecheck

# 生产构建
npm run build
```

## 项目结构

```
src/
├── api/            # GitHub Gist API 客户端
├── auth/           # Token 加密存储与验证
├── bookmark/       # 浏览器书签读写与适配
├── background/     # Service Worker
├── popup/          # Solid.js UI 界面
│   └── components/ # BookmarkList / SyncStatus / ChangeLog / Settings
├── storage/        # IndexedDB 本地存储
├── sync/           # 同步引擎（sync/push/pull）与三向合并
├── tracker/        # 变更记录追踪
├── types/          # TypeScript 类型定义
└── utils/          # 工具函数
```

## 与其他方案对比

| 维度 | GitHub Gist (本项目) | WebDAV | 自建后端 | 浏览器原生同步 |
|------|---------------------|--------|----------|---------------|
| 成本 | 免费 | 免费/低费 | 服务器费用 | 免费 |
| 运维 | 零 | 需维护 | 全栈运维 | 零 |
| 跨浏览器 | 支持 | 支持 | 支持 | 仅同厂商 |
| 版本历史 | 天然 Git | 部分支持 | 需自行实现 | 有限 |
| 实时性 | 手动触发 | 轮询 | WebSocket | 实时 |
| 数据主权 | 用户控制 | 用户控制 | 用户控制 | 厂商控制 |

## 免责声明

本项目按"原样"提供，不作任何明示或暗示的保证，包括但不限于适销性和特定用途适用性的暗示保证。使用本项目的全部风险由用户自行承担。

- 本项目依赖 [GitHub Gist API](https://docs.github.com/rest/gists) 进行数据存储，GitHub 可能随时变更 API 或速率限制策略，导致功能异常
- GitHub Personal Access Token 存储于浏览器本地，虽经加密处理，但无法防御具有扩展完整访问权限的恶意软件或浏览器漏洞
- 书签同步操作可能因网络异常、API 限制、数据冲突等因素导致数据丢失或损坏，**建议定期通过浏览器原生功能导出书签备份**
- 本项目与 GitHub, Inc. 无任何关联，GitHub 是 GitHub, Inc. 的注册商标
- 任何因使用本项目而产生的直接或间接损失，作者不承担任何责任

## 许可证

[Apache License 2.0](LICENSE)
