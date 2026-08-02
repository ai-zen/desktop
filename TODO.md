# TODO — AI-Zen Desktop

功能开发待办清单（按优先级排序）。

## ✅ 已完成

- Markdown 渲染（markstream-vue + Shiki）
- 对话重命名与删除（侧栏右键菜单）
- 自动生成对话名称（首轮后异步，防覆盖手动改名）
- agent 运行注册表（运行期驻留、运行完释放）+ getState + 每轮内循环持久化
- UI：Markdown 字体收敛（正文 13px，标题 16/15/14/13）
- UI：标题栏窗口控制（hover 加强 + 最大化/还原方块图标）
- UI：消息头像（User / ChatDotRound 图标 + rgba 低透明背景适配深浅主题）
- UI：消息气泡圆角（助手左上 / 用户右上尖锐）

## 1. 性能：main 同步代码改为异步（高优先级）

- **现状**：
  - SQLite 用 `node:sqlite` 的 `DatabaseSync`，**全部是同步 API**——`WorkspaceRepository` / `ConversationRepository` 的 list/read/write 都同步阻塞主进程事件循环
  - `app.ts` / `ProviderPool.ts` 有同步 fs（`existsSync` / `mkdirSync`）
  - SDK 侧 `AgentRepository` / `ConfigManager` 的读取若为同步也需一并评估
- **影响**：流式热路径上 `persistSnapshot` 每轮 read + write 同步阻塞；发送 / 列表刷新 / 落库并发时互相卡顿（大对话尤甚）
- **目标**：IO 全部异步化，不阻塞主进程
  - SQLite：`DatabaseSync` → worker_threads 封装（或等价异步方案），Repository 接口改 async
  - fs：`existsSync` / `mkdirSync` → `fs.promises`
  - SDK 同步读取：确认后决定包异步 or 接受低频阻塞（启动/切会话）
- **注意**：Repository 接口签名变更会波及 services / render 调用点——优先保持接口稳定，内部异步化

## 2. 性能：render 切换对话虚拟滚动（高优先级）

- **现状**：`ChatPanel` 对全部消息 `v-for` 渲染；每条 assistant 消息走 `markstream-vue` + Shiki 高亮（DOM 重、高亮贵）；大对话（50+ 条）切换时一次性全量渲染，明显卡顿
- **目标**：消息列表虚拟滚动（只渲染视口附近），候选：
  - `@tanstack/vue-virtual`（轻量，无额外依赖）
  - `vue-virtual-scroller`（功能全）
- **注意**：
  - 流式进行中的消息必须始终在视口内（自动滚底逻辑要适配虚拟化）
  - 复用在视口外的已渲染消息，避免滚动时反复触发 Shiki 高亮
  - 折叠区（思考过程 / 工具调用 / 工具结果）的展开状态在虚拟化下如何保持

## 3. 设置页 SettingsView（低优先级）

- 现状：`uiStore.currentView` 已支持 `settings`，入口未加
- 目标：设置页 SettingsView，内容：API Key / 默认模型 / Agent 列表 / 数据目录

## 4. UI：更换软件 LOGO（低优先级，等找到合适的 LOGO 素材再完成）

- 现状：项目内无任何图标/LOGO 资源（png/ico/icns/svg 全无）——TitleBar 用 `MagicStick` 图标 + "AI-Zen" 渐变文字；BrowserWindow 无自定义 icon（显示默认 Electron 图标）
- 目标：
  - 设计一个 LOGO（与 AI-Zen 品牌一致，如 AI/魔法主题）
  - 覆盖：TitleBar 应用图标、BrowserWindow 窗口/任务栏图标（`BrowserWindow({ icon })`）、打包图标（.ico/.icns）
  - 资源文件放 `packages/main/assets/` 或 `resources/`，render 侧引用需走打包路径
- 注意：LOGO 尺寸需覆盖 16px（TitleBar）~ 256px（打包）；生成 SVG 源文件 + 导出各尺寸
