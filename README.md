# @ai-zen/desktop

AI-Zen Desktop — 多 Workspace、多会话并存的 AI 工作台（Electron + Vue 3）。

> **🤖 给 AI Agent / 开发者的接手指南**
> 任何 AI 助手或开发者**接手本项目前，务必先阅读 [AGENTS.md](./AGENTS.md)** —— 它包含最高优先级的协作原则、启动/调试方式、架构决策与关键踩坑记录。忽略它可能导致方向性错误或重复踩坑。

## 技术栈

| 层 | 技术 |
|----|------|
| 主进程 | Electron 43（Node 24）+ TypeScript + rolldown 打包 |
| 渲染进程 | Vue 3 + Vite + Pinia + Element Plus |
| 流式 Markdown | markdown-it + highlight.js（按需注册语言，同步渲染） |
| Agent 运行时 | `@ai-zen/agents-sdk`（Provider / Agent / MCP 能力）—— 跑在**常驻服务端**那边 |
| 数据存储 | 常驻服务端 `agents-server`（工作区与会话存档都在它盘上；桌面端自己的持久化只有连接设置那一个文件） |

## 项目结构

```
desktop/
├── packages/
│   ├── main/       ← Electron 主进程（rolldown 打包，ESM）
│   ├── render/     ← Vue 3 渲染进程（Vite）
│   └── shared/     ← 共享类型 / IPC 协议（纯类型，零运行时）
├── scripts/dev.mjs ← 根目录 `pnpm dev` 一键开发（见下）
└── AGENTS.md       ← ⚠️ 接手指南（协作原则 / 启动 / 踩坑，必读）
```

### main — 主进程（面向对象单根）

```
packages/main/src/
├── main.ts            ← 入口（仅一行：new DesktopApp().start()）
├── app.ts             ← DesktopApp 单根：窗口 / IPC / 原生对话框
├── config.ts          ← 路径常量 `AI_ZEN_DIR`（连接配置不在这个文件里）
├── preload.ts         ← contextBridge 暴露 window.electronAPI
├── connection/        ← 连本地还是远程：桌面端唯一一处自己的持久化
│   ├── settings.ts    ← 连接配置读写（`<AI_ZEN_DIR>/desktop/connection.json`，0600 + 原子写）
│   └── controller.ts  ← ConnectionController：当前连着哪一层 / 保存即重连 / 测试连接
└── server/            ← 常驻服务端的门面（组装根 = index.ts）
    ├── index.ts       ← createServerLayer：六个 Service + 事件翻译器 + 那一条常驻连接
    ├── call.ts        ← 一次协议调用（取一条活着的连接，不缓存 client）
    ├── services.ts    ← 六个 Service：render 的形状 ↔ 协议调用
    ├── ServicesManager.ts ← invokeService 动态分发（薄）
    ├── events.ts      ← 服务端事件 → `ChatStreamEvent`（订阅随连接重建自动重挂）
    ├── noticeSlots.ts ← 通知槽位：连上就补看未确认的（`notice.list`），显示后确认（`notice.ack`）
    └── notices.ts     ← 通知 code → 中文文案
```

### render — 渲染进程（瘦客户端：只调服务 + 订阅事件）

```
packages/render/src/
├── main.ts            ← Vue 入口（Pinia / ElementPlus）
├── App.vue            ← 根：TitleBar + Guide/Main/Settings 视图切换；初始化订阅 chat:push
├── components/
│   ├── TitleBar.vue         ← 自定义标题栏（窗口控制）
│   └── MarkdownContent.vue  ← markdown-it + highlight.js 渲染
├── views/
│   ├── guide/index.vue        ← 引导页（无工作空间时）
│   ├── main/
│   │   ├── index.vue          ← 主界面（Sidebar + ChatPanel）
│   │   ├── Sidebar.vue        ← 工作空间树 + 会话树 + 右键菜单（重命名/删除/新建）
│   │   ├── ChatPanel.vue      ← 对话面板（模型选择 / 消息列表 / 输入）
│   │   ├── MessageBubble.vue  ← 消息气泡（流式 Markdown / 工具结果折叠）
│   │   └── NewChatDialog.vue  ← 新建对话（选 Agent）
│   └── settings/index.vue     ← 设置页（服务端连接 / 默认模型 / 默认 Agent / API Key / 数据目录）
├── composables/       ← 消息分页窗口 + 自动滚动策略
├── stores/            ← Pinia
│   ├── ui.ts                  ← 当前视图 + Agent/Model 选项
│   ├── workspace.ts           ← 工作空间列表 + 激活
│   ├── conversation.ts        ← 会话列表（按 workspace 缓存）+ 激活 + 运行中标记
│   ├── chat.ts                ← ★ 按会话隔离的消息/流式状态（事件投影）
│   ├── agentView.ts           ← 子 Agent 栏目的纯逻辑（选中态修正 / Tab 循环）
│   └── connection.ts          ← 本地 / 远程连接设置（读 / 保存并重连 / 测试连接）
└── apis/              ← 与 main 的六个 service 一一对应（外加连接设置）
    ├── base.ts                ← invokeService + subscribeServiceEvent
    ├── workspace.ts / conversation.ts / agent.ts / model.ts / config.ts
    ├── chat.ts                ← sendChatMessage / getChatState / onChatPush
    └── connection.ts          ← 连接的三条专用通道（不属那六个 service）
```

### shared — 共享契约

```
packages/shared/src/
└── types.ts   ← Workspace / Conversation / ConversationState / ChatStreamEvent /
                 ElectronAPI（IPC 协议纯类型）
```

## 通信架构

**前后端分离心智**：render 是瘦客户端，不产生业务状态；一切通过 IPC 单通道调用 + 事件回流。

```
渲染进程                              主进程
  │                                     │
  ├─ invokeService("workspace","list") ─┤
  ├─ invokeService("conversation",      │ ServicesManager 动态分发
  │   "create", wsId, agentId) ────────→│   ├─ workspace
  ├─ invokeService("chat","send",       │   ├─ conversation
  │   wsId, convId, content) ──────────→│   ├─ chat（转发 session.send）
  │                                     │   └─ agent / model / config
  │  on("chat:push", evt) ←─────────────┤ webContents.send("chat:push")
```

- **调用**：`invokeService(service, method, ...args)` 动态分发到对应 service（preload 暴露，极薄，零业务定义）
- **推送**：`chat:push` 单通道事件流 `start → user → message… → done / error`（+ 独立的 `migrated` / `renamed` / `notice` / `agents`）
- **出口**：main 不再自己跑 Agent —— 每个动作都是对常驻 `agents-server` 的一次协议调用（`session.*` / `workspace.*` / `config.*` …），事件由服务端推回
- **例外是「连哪台服务端」**：它不进那六个分发键，走三条专用通道 `connection:get` / `save` / `test`（preload 暴露成 `window.electronAPI.connection`）—— 它要在服务端还不存在的时候回答，见「[设置页](#设置页)」

## 核心设计（会话执行与存档都在服务端）

- **agent 活服务端**：每个会话在服务端有一个 agent，会话活着它就活着（流式中可读），服务端按空闲宽限期回收；不运行时的状态由服务端的工作区存档接管（`workspaces/<id>/sessions/`）
- **`session.snapshot` 是运行时唯一真相**（含流式进行中的 user + assistant 占位）；桌面端收到的 `done` / `migrated` 就是这份快照的全量替换
- **send 只提交**：`session.send` 立刻回 `turnId`，过程与结果全走事件（一轮可能跑几分钟）
- **getState**：切回任何会话都问服务端要实时状态（`session.attach` + `session.snapshot`）——切换会话/窗口开关不丢状态
- **自动命名**：服务端在首轮之后异步起名，推 `session-title-changed`；桌面端只把它翻成 `renamed`
- 删除会话/工作空间 → 服务端在 `session.remove` / `workspace.remove` 里关掉活会话（桌面端不再挂钩子）

## 数据存储

```
~/.ai-zen/                    ← 共享根（CLI / Desktop 共用；服务端的 AI_ZEN_DIR）
├── config.json               ← 全局配置（endpoints / models / 默认模型与 Agent）
├── agents/                   ← Agent 定义（入口 Agent）
├── sub-agents/               ← 子 Agent 定义
├── workspaces/<id>/          ← 每个工作区一个目录（workspace.json + sessions/*.json 存档）
├── desktop/                  ← 桌面端自己写（就这一个文件）
│   └── connection.json       ← 连接设置（本地 / 远程 + 地址 + 凭证，0600；删掉即回到「本地」；本地模式下不存地址与凭证 —— 切到本地并保存会把它们清掉）
└── run/                      ← 服务端自己写：怎么找到它
    ├── server.json           ← 服务发现：常驻服务端此刻在哪个端口
    └── token                 ← 凭证（服务端启动时读或生成，0600）
```

- 数据文件仍然只归服务端：默认从 `<AI_ZEN_DIR>/run/server.json` 读地址、从 `<AI_ZEN_DIR>/run/token` 读凭证，之后一切读写都发生在服务端那一侧（会话清单 / 消息 / 工作区都由服务端给：`session.list` / `session.snapshot` / `workspace.list`）
- **连接配置是唯一的例外，落在本机而不在服务端**：`<AI_ZEN_DIR>/desktop/connection.json`（权限 `0600`、原子写 —— 里面有凭证）。理由是先有鸡先有蛋：得先知道**连哪台**，才谈得上把它手上的配置发回来；把「连哪台」也存到服务端，等于要求用户先连上服务端才能选服务端。这个文件读不到 / 坏掉 / 字段不合法 → 一律回退「本地」并照常启动；**整个删掉就是回到默认**（本地 = 发现文件 + 本机 `run/token`）
- 远程模式**只连、不拉起**捆绑的 server（本机拉起来的那份一定不在那个地址上；只留一条只说地址、不含凭证的 log）

## 设置页

设置页开头是「**服务端连接**」一节：单选**本地** / **远程**，远程时填**地址**（`ws://` / `wss://` / `http://` / `https://`，支持 path，如 `wss://example.com/ai-zen`）与**凭证**（留空 = 用本机 `<AI_ZEN_DIR>/run/token`）。

- **这一节自带两个按钮：「测试连接」与「保存并重连」** —— 与页面底部那个「保存」是两件事。底部那个保存把「默认模型 / 默认 Agent / API Key」写给**服务端**（连的还是同一台），不换连接
- **测试连接**只探测候选值：不落盘、不影响当前连接。成功显示服务端自报的 `protocol` / `version` / 耗时；失败显示客户端翻好的人话（例如引导去核对凭证）
- **保存并重连**立刻生效：main 先落盘、再 dispose 旧连接、再按新配置建一条并 start，**不需要重启 App**；进行中的回答会中断（所以保存前有确认框）
- 保存成功后界面会重拉所有来自服务端的数据（会话 / 工作区 / Agent / 模型列表）—— 换了服务端就是换了一整个世界
- 远程模式下看到的会话 / 工作区都属于那台机器；远程**不会**在本机拉起服务端，本地模式才是「发现文件 + 按需拉起」
- 切到「**本地**」并保存，会把远端地址与凭证从 `desktop/connection.json` 里**清掉** —— 不用的时候不把钥匙留在盘上（`0600` 也只是同用户可读）；要再连那台，重新填一次即可（面板里的输入框在**保存前**只是临时副本，切来切去还能看见，但保存后盘上那份就没了）

## 开发

```bash
# 一键开发（推荐）：rolldown watch(main) + vite(render) + nodemon 重启 electron
pnpm dev

# 构建全部
pnpm build

# 类型检查
cd packages/main && pnpm exec tsc --noEmit
cd packages/render && pnpm exec vue-tsc --noEmit
```

- 开发模式 Electron 加载 `http://localhost:5173`（写死），CDP 调试端口 `9222`
- **⚠️ 启动前先确认没有已运行的 dev 实例**（vite 5173 / Electron 9222 抢端口）；已运行则直接用 CDP 调试，勿再 `pnpm dev`（详见 AGENTS.md）

## 文档

- [AGENTS.md](./AGENTS.md) — 接手指南（协作原则 / 启动 / 踩坑记录，⚠️ 必读）
- [docs/zh/desktop-design.md](docs/zh/desktop-design.md) — 设计文档（架构决策）
- [docs/zh/electron-setup.md](docs/zh/electron-setup.md) — Electron 环境搭建（二进制下载失败处理等）
- [docs/zh/cdp-debug.md](docs/zh/cdp-debug.md) — CDP 远程调试
- 其余文档见 [docs/zh/index.md](docs/zh/index.md)（英文版在 `docs/en/`，清单见 `docs/manifest.json`）

## License

ISC
