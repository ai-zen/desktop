# @ai-zen/desktop

AI-Zen Desktop — 多 Workspace、多会话并存的 AI 工作台（Electron + Vue 3）。

> **🤖 给 AI Agent / 开发者的接手指南**
> 任何 AI 助手或开发者**接手本项目前，务必先阅读 [AGENTS.md](./AGENTS.md)** —— 它包含最高优先级的协作原则、启动/调试方式、架构决策与关键踩坑记录。忽略它可能导致方向性错误或重复踩坑。

## 技术栈

| 层 | 技术 |
|----|------|
| 主进程 | Electron 43（Node 24）+ TypeScript + rolldown 打包 |
| 渲染进程 | Vue 3 + Vite + Pinia + Element Plus |
| 流式 Markdown | markstream-vue + Shiki 高亮 |
| Agent 运行时 | `@ai-zen/agents-sdk`（Provider / Agent / MCP 能力）—— 跑在**常驻服务端**那边 |
| 数据存储 | 常驻服务端 `agents-server`（工作区与会话存档都在它盘上，桌面端不落盘） |

## 项目结构

```
desktop/
├── packages/
│   ├── main/       ← Electron 主进程（rolldown 打包，ESM）
│   ├── render/     ← Vue 3 渲染进程（Vite）
│   └── shared/     ← 共享类型 / IPC 协议（纯类型，零运行时）
├── scripts/dev.mjs ← 根目录 `pnpm dev` 一键开发（见下）
├── AGENTS.md       ← ⚠️ 接手指南（协作原则 / 启动 / 踩坑，必读）
└── TODO.md         ← 功能 Roadmap
```

### main — 主进程（面向对象单根）

```
packages/main/src/
├── main.ts            ← 入口（仅一行：new DesktopApp().start()）
├── app.ts             ← DesktopApp 单根：窗口 / IPC / 原生对话框
├── config.ts          ← 路径常量（只剩 `AI_ZEN_DIR` 一个）
├── preload.ts         ← contextBridge 暴露 window.electronAPI
└── server/            ← 常驻服务端的门面（组装根 = index.ts）
    ├── index.ts       ← createServerLayer：六个 Service + 事件翻译器 + 那一条常驻连接
    ├── call.ts        ← 一次协议调用（取一条活着的连接，不缓存 client）
    ├── services.ts    ← 六个 Service：render 的形状 ↔ 协议调用
    ├── ServicesManager.ts ← invokeService 动态分发（薄）
    ├── events.ts      ← 服务端事件 → `ChatStreamEvent`（订阅随连接重建自动重挂）
    └── notices.ts     ← 通知 code → 中文文案
```

### render — 渲染进程（瘦客户端：只调服务 + 订阅事件）

```
packages/render/src/
├── main.ts            ← Vue 入口（Pinia / ElementPlus / MarkdownRender）
├── App.vue            ← 根：TitleBar + Guide/Main 视图切换；初始化订阅 chat:push
├── components/
│   └── TitleBar.vue   ← 自定义标题栏（窗口控制）
├── views/
│   ├── guide/index.vue        ← 引导页（无工作空间时）
│   └── main/
│       ├── index.vue          ← 主界面（Sidebar + ChatPanel）
│       ├── Sidebar.vue        ← 工作空间树 + 会话树 + 右键菜单（重命名/删除/新建）
│       ├── ChatPanel.vue      ← 对话面板（模型选择 / 消息列表 / 输入）
│       ├── MessageBubble.vue  ← 消息气泡（流式 Markdown / 工具结果折叠）
│       └── NewChatDialog.vue  ← 新建对话（选 Agent）
├── stores/            ← Pinia
│   ├── ui.ts                  ← 当前视图 + Agent/Model 选项
│   ├── workspace.ts           ← 工作空间列表 + 激活
│   ├── conversation.ts        ← 会话列表（按 workspace 缓存）+ 激活 + 运行中标记
│   └── chat.ts                ← ★ 按会话隔离的消息/流式状态（事件投影）
└── apis/              ← 与 main services 一一对应
    ├── base.ts                ← invokeService + subscribeServiceEvent
    ├── workspace.ts / conversation.ts / agent.ts / model.ts
    └── chat.ts                ← sendChatMessage / getChatState / onChatPush
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
  │   "create", wsId, agentId) ────────→│   ├─ workspace.service
  ├─ invokeService("chat","send",       │   ├─ conversation.service
  │   wsId, convId, content) ──────────→│   ├─ chat.service（转发 session.send）
  │                                     │   └─ agent / model
  │  on("chat:push", evt) ←─────────────┤ webContents.send("chat:push")
```

- **调用**：`invokeService(service, method, ...args)` 动态分发到对应 service（preload 暴露，极薄，零业务定义）
- **推送**：`chat:push` 单通道事件流 `user → start → delta… → done / error`（+ 异步 `renamed` / `notice` / `agents`）
- **出口**：main 不再自己跑 Agent —— 每个动作都是对常驻 `agents-server` 的一次协议调用（`session.*` / `workspace.*` / `config.*` …），事件由服务端推回

## 核心设计（会话执行与存档都在服务端）

- **agent = 服务端的运行注册表**：每个会话的 agent 仅运行期驻留（流式中可读），一轮收尾后释放；不运行时的状态由服务端的工作区存档接管（`workspaces/<id>/sessions/`）
- **`session.snapshot` 是运行时唯一真相**（含流式进行中的 user + assistant 占位）；桌面端收到的 `done` / `migrated` 就是这份快照的全量替换
- **send 只提交**：`session.send` 立刻回 `turnId`，过程与结果全走事件（一轮可能跑几分钟）
- **getState**：切回任何会话都问服务端要实时状态（`session.attach` + `session.snapshot`）——切换会话/窗口开关不丢状态
- **自动命名**：服务端在首轮之后异步起名，推 `session.titleChanged`；桌面端只把它翻成 `renamed`
- 删除会话/工作空间 → 服务端在 `session.remove` / `workspace.remove` 里关掉活会话（桌面端不再挂钩子）

## 数据存储

```
~/.ai-zen/                    ← 共享根（CLI / Desktop 共用；服务端的 AI_ZEN_DIR）
├── config.json               ← 全局配置（endpoints / models / 默认模型与 Agent）
├── agents/                   ← Agent 定义（入口 Agent）
├── sub-agents/               ← 子 Agent 定义
├── workspaces/<id>/          ← 每个工作区一个目录（workspace.json + sessions/*.json 存档）
└── run/server.json           ← 服务发现：常驻服务端此刻在哪个端口
```

- 桌面端**不读写**这里的任何数据文件：它只读 `run/server.json` 找到服务端，之后一切读写都发生在服务端那一侧
- 协议里没有「本地存档」这条路：会话清单、消息、工作区都由服务端给（`session.list` / `session.snapshot` / `workspace.list`）

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
- [TODO.md](./TODO.md) — 功能 Roadmap
- [desktop-design.md](docs/desktop-design.md) — 设计文档（架构决策）
- [electron-setup.md](docs/electron-setup.md) — Electron 环境搭建（二进制下载失败处理等）
- [cdp-debug.md](docs/cdp-debug.md) — CDP 远程调试

## Roadmap

见 [TODO.md](./TODO.md)。已完成：流式 Markdown 渲染（markstream-vue + Shiki）、对话右键菜单（重命名/删除/新建）、自动生成对话名称、agent 运行注册表 + getState + 每轮持久化。待办：设置页（SettingsView）。

## License

ISC
