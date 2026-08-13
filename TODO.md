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

## 1. 设置页 SettingsView（中优先级）

- 现状：`uiStore.currentView` 已支持 `settings`，入口未加
- 目标：设置页 SettingsView，内容：API Key / 默认模型 / Agent 列表 / 数据目录

## 2. UI：更换软件 LOGO（低优先级，等找到合适的 LOGO 素材再完成）

- 现状：项目内无任何图标/LOGO 资源（png/ico/icns/svg 全无）——TitleBar 用 `MagicStick` 图标 + "AI-Zen" 渐变文字；BrowserWindow 无自定义 icon（显示默认 Electron 图标）
- 目标：
  - 设计一个 LOGO（与 AI-Zen 品牌一致，如 AI/魔法主题）
  - 覆盖：TitleBar 应用图标、BrowserWindow 窗口/任务栏图标（`BrowserWindow({ icon })`）、打包图标（.ico/.icns）
  - 资源文件放 `packages/main/assets/` 或 `resources/`，render 侧引用需走打包路径
- 注意：LOGO 尺寸需覆盖 16px（TitleBar）~ 256px（打包）；生成 SVG 源文件 + 导出各尺寸

## 3. 端到端实测（功能已实现，需逐项验收）

- 错误重试 UI：消息 error 状态 → 重试按钮 → 重新发送
- 切换模型后发送：对话级 `modelId` 覆盖 Agent 定义（优先级：对话 > Agent > 全局）
- 运行中删除会话：abort 进行中的 agent + 释放注册表（`release()` 已实现，需实测）
- worker 崩溃重建路径：dbWorker 异常后主进程的恢复行为
- autoRename 兜底名：本地降级取名（首条用户消息前 16 字符）是否合适

## 4. UI：思考过程/工具调用的展示与自动折叠（中优先级）

- 现状：MessageBubble 中「思考过程」「工具调用」「工具结果」折叠区**默认全部折叠**（`showThinking`/`showTools`/`showToolResult` 初始为 `false`）——生成过程中用户看不到思考内容和工具调用进展，需手动点开
- 目标：折叠状态由**消息时序**自动驱动：
  - 思考过程：流式生成中**自动展开**展示思考内容；思考完毕（消息完成）**自动折叠**回一行「思考过程」
  - 工具调用：工具执行中**自动展开**展示调用内容；调用完成**自动折叠**
  - （可选）工具结果同理：执行中展开、完成后折叠
- 注意：需与「DOM 常驻、折叠状态由组件内部保持」的既有设计配合——仅在「进行中 → 完成」转变时自动收拢/展开，不覆盖用户手动切换的中间态；MessageBubble 需感知消息状态（如 `status` 从流式变为 `completed`，或通过 props 传入 streaming 标记）
