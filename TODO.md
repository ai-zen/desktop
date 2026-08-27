# TODO — AI-Zen Desktop

功能开发待办清单（按优先级排序）。

## ✅ 已完成

- Markdown 渲染：markdown-it + highlight.js（按需注册 30 语言、同步渲染）替换 markstream-vue + Shiki —— 窗口内代码块全部即时高亮，无懒加载/渐进渲染导致的滚动抖动
- 消息窗口性能：QQ/微信式分页（首屏 20 条 + 上翻 20 条 + DOM 常驻上限 200，窗口内整页立即渲染）替代虚拟滚动；`v-show` 常驻提示 + 稳定 key（= 消息 id），折叠状态天然保持
- Message.id 全链路：agents-core 3.1.0（构造自动生成、跨环境随机）+ agents-sdk 0.5.1（core 依赖改 `workspace:^` 范围版本）；user/delta 事件携带 agent 真实消息 id，render 按 id 就地累积，v-for key 全程 = msg.id；历史消息懒迁移补 id（幂等）
- 对话重命名与删除（侧栏右键菜单）
- 自动生成对话名称（首轮后异步，防覆盖手动改名）
- agent 运行注册表（运行期驻留、运行完释放）+ getState + 每轮内循环持久化
- UI：Markdown 字体收敛（正文 13px，标题 16/15/14/13）
- UI：标题栏窗口控制（hover 加强 + 最大化/还原方块图标）
- UI：消息头像（User / ChatDotRound 图标 + rgba 低透明背景适配深浅主题）
- UI：消息气泡圆角（助手左上 / 用户右上尖锐）
- 性能：main 同步 IO 异步化——SQLite 走 worker_threads（dbWorker 独立线程）、fs 用 `fs/promises`（app.ts / ProviderPool），主进程事件循环不再被同步 SQL 阻塞
- 清理：移除消息隐藏功能（contentHidden/眼睛按钮，鸡肋且默认隐藏反直觉）
- 中止生成：streaming 时发送按钮切换「停止」→ `ChatService.abort()` + IPC `chat.abort`；中断保留已生成部分（Aborted），core 3.3.0 接管防孤儿（删除 `cleanupOrphanToolMessages`，formatHistory 过滤 Aborted）——已端到端实测：中断后无孤儿消息、继续对话无 400
- 上下文迁移 + 护栏：`ChatService` 引入 `AutoRefreshToolsPlugin` / `ContextGuardPlugin` / `AutoMigratePlugin`（参照 CLI conversation-runner）；`DesktopMigrationService` 迁移后保留旧历史并打 `omit`（已作废）标记，UI 可见但不进请求；新增独立 `migrated` 事件 + `MessageBubble`「已作废」徽标
- 设置页 `SettingsView`：侧栏「设置」入口；默认模型 / 默认 Agent / 各端点 API Key / 数据目录，读改写 `~/.ai-zen/config.json`（新增 `ConfigService`）
- 思考/工具调用自动折叠：流式生成中自动展开，完成后自动折叠；用户手动切换（`*Touched`）后再变状态不被自动覆盖

## 1. UI：更换软件 LOGO（低优先级，等找到合适的 LOGO 素材再完成）

- 现状：项目内无任何图标/LOGO 资源（png/ico/icns/svg 全无）——TitleBar 用 `MagicStick` 图标 + "AI-Zen" 渐变文字；BrowserWindow 无自定义 icon（显示默认 Electron 图标）
- 目标：
  - 设计一个 LOGO（与 AI-Zen 品牌一致，如 AI/魔法主题）
  - 覆盖：TitleBar 应用图标、BrowserWindow 窗口/任务栏图标（`BrowserWindow({ icon })`）、打包图标（.ico/.icns）
  - 资源文件放 `packages/main/assets/` 或 `resources/`，render 侧引用需走打包路径
- 注意：LOGO 尺寸需覆盖 16px（TitleBar）~ 256px（打包）；生成 SVG 源文件 + 导出各尺寸

## 2. 端到端实测（功能已实现，需逐项验收）

- 错误重试 UI：消息 error 状态 → 重试按钮 → 重新发送
- 切换模型后发送：对话级 `modelId` 覆盖 Agent 定义（优先级：对话 > Agent > 全局）
- 运行中删除会话：abort 进行中的 agent + 释放注册表（`release()` 已实现，需实测）
- worker 崩溃重建路径：dbWorker 异常后主进程的恢复行为
- autoRename 兜底名：本地降级取名（首条用户消息前 16 字符）是否合适

## 3. 设置页：完整全局资源管理（AGENTS / SUBAGENTS / MCP / SKILLS / TOOLS）

- 现状：设置页目前仅支持 默认模型 / 默认 Agent / 各端点 API Key / 数据目录 / 图片模型等基础配置（`ConfigService` 读写 `config.json`）；Agent 列表仅展示，无法新建/编辑/删除
- 目标：设置页加入完整的全局资源管理与增删改查：
  - **AGENTS**：新建/编辑/删除 Agent 定义（预设消息、权限、模型绑定），落盘 `agents/<id>.json`
  - **SUBAGENTS**：管理子 Agent（`sub-agents/<id>.json`，含 `function` 定义与权限）
  - **MCP**：配置 MCP 服务器（`mcp.json`，stdio/http/sse + 环境变量 + OAuth）
  - **SKILLS**：管理 Skill（`skills/<id>/SKILL.md`，加载/启用/禁用）
  - **TOOLS**：管理用户工具（`tools/*.mjs`，列出/禁用/删除）
- 数据来源：均落盘到全局 `~/.ai-zen` 或工作空间对应子目录，复用 `EntityRepository` / `ConfigManager` / `Provider` 能力，与 `ConfigService` 现有读写路径保持一致
- 注意：区分「全局」与「工作空间（workspace）」两套资源；MCP/SKILLS/TOOLS 涉及沙箱/加载，改动后需 `AutoRefreshToolsPlugin` 刷新生效
- 渲染：设置页按资源类型分区（Tab 或分组面板），列表 + 表单编辑，保存后回流到运行时（`Provider.refresh` / `ConfigManager`）
