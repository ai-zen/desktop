# TODO — AI-Zen Desktop

功能开发待办清单（按优先级排序）。

## ✅ 已完成

- Markdown 渲染（markstream-vue + Shiki）
- 对话重命名与删除（侧栏右键菜单）
- 自动生成对话名称（首轮后异步，防覆盖手动改名）
- agent 运行注册表（运行期驻留、运行完释放）+ getState + 每轮内循环持久化

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

## 4. UI：Markdown 字体过大（低优先级）

- 现状：`.md-content` 基础 14px，但标题偏大——h1 18px / h2 16px / h3 15px，视觉上尤其标题过大，与系统字号不协调
- 目标：整体下调——基础 13~14px，标题按比例缩小（如 h1 16px / h2 15px / h3 14px），与正文层级拉开但不突兀
- 注意：样式在 `MessageBubble.vue` 的 `.md-content` 内（`MarkdownRender` 的 `:deep` 覆盖），改完需回归流式/代码块/列表的排版

## 5. UI：标题栏窗口控制按钮优化（低优先级）

- 现状：
  - 最小化/最大化按钮 hover 反馈过弱——`.control-btn:hover` 只有 `--el-fill-color-light`，浅色下几乎无感（看起来像"没有 hover"）
  - 最大化图标用 `FullScreen`（偏"全屏"语义，不直观）；还原用 `CopyDocument`
- 目标：
  - hover 反馈更明确（背景加深 / 圆角色块，可参考关闭键的强反馈但更柔和）
  - 最大化/还原图标换成更直观的方块风格（单个方块 = 最大化，重叠方块 = 还原）
- 注意：`TitleBar.vue` 的 `.control-btn` 样式 + 图标；hover 颜色遵守项目偏好（不用 `-light-N` 混白变量）
