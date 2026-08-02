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

## 7. UI：更换助手/用户图标 + 头像背景适配主题（低优先级）

- 现状：`MessageBubble.vue` 头像——用户用 `UserFilled`（`--el-color-success` 绿）+ 背景 `--el-color-success-light-9`；助手用 `MagicStick`（`--el-color-primary` 蓝）+ 背景 `--el-color-primary-light-9`
- 问题：
  - 图标（UserFilled / MagicStick）不够贴合"助手/用户"语义，需更换
  - 头像背景用 `-light-9` **混白变量**（深色模式下大量混白，刺眼）——违反项目偏好，需改为适配主题的写法（如 `rgba(var(--el-color-*-rgb), 0.1~0.15)` 或主题色低透明度）
- 注意：改完回归浅色/深色两种主题下的对比度

## 8. UI：更换软件 LOGO（低优先级）

- 现状：项目内无任何图标/LOGO 资源（png/ico/icns/svg 全无）——TitleBar 用 `MagicStick` 图标 + "AI-Zen" 渐变文字；BrowserWindow 无自定义 icon（显示默认 Electron 图标）
- 目标：
  - 设计一个 LOGO（与 AI-Zen 品牌一致，如 AI/魔法主题）
  - 覆盖：TitleBar 应用图标、BrowserWindow 窗口/任务栏图标（`BrowserWindow({ icon })`）、打包图标（.ico/.icns）
  - 资源文件放 `packages/main/assets/` 或 `resources/`，render 侧引用需走打包路径
- 注意：LOGO 尺寸需覆盖 16px（TitleBar）~ 256px（打包）；生成 SVG 源文件 + 导出各尺寸

## 9. UI：消息气泡圆角尖锐角调整（低优先级）

- 现状：`MessageBubble.vue` —— 用户气泡 `border-radius: 12px 12px 4px 12px`（**右下角**尖锐 4px）；助手气泡 `12px 12px 12px 4px`（**左下角**尖锐 4px）
- 目标：尖锐角改到靠近头像的一端（聊天气泡常规风格）：
  - 助手消息（左对齐，头像在左）→ **左上角**尖锐：`4px 12px 12px 12px`
  - 用户消息（右对齐，头像在右）→ **右上角**尖锐：`12px 4px 12px 12px`
- 注意：仅改两处 `border-radius`，不动背景/边框/内边距
