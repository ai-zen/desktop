# @ai-zen/desktop

AI-ZEN Desktop — 多 Workspace、多会话并存的 AI 工作台。

## 项目结构

```
desktop/
├── packages/
│   ├── main/       ← Electron 主进程（rolldown 打包）
│   ├── render/     ← Vue 3 渲染进程（Vite 8）
│   └── shared/     ← 共享类型/IPC 协议
```

### main — 主进程

```
packages/main/src/
├── main.ts                           ← 入口（窗口创建、IPC 注册）
├── preload.ts                        ← preload（暴露 invoke/on/off）
└── modules/
    ├── servicesManager.ts            ← 通用服务调用调度器 + ServiceContext
    ├── workspace/
    │   └── workspace.service.ts      ← Workspace CRUD
    ├── conversation/
    │   └── conversation.service.ts   ← 对话 CRUD + 索引
    └── chat/
        └── chat.service.ts           ← 对话发送 + 流式推送
```

### render — 渲染进程

```
packages/render/src/
├── main.ts                           ← Vue 入口
├── App.vue                           ← 根组件（侧边栏 + 对话区）
├── components/
│   ├── Sidebar.vue                   ← 左侧 Workspace/对话树
│   └── ChatPanel.vue                 ← 右侧对话面板
└── stores/                           ← 状态管理
```

### shared — 共享类型

```
packages/shared/src/
└── types.ts                          ← Workspace、Conversation、Message、ElectronAPI
```

## 通信架构

采用通用服务调用 IPC 模式，所有业务逻辑通过单一通道路由：

```
渲染进程                             主进程
  │                                    │
  ├── invoke("workspace", "list") ────→│
  ├── invoke("conversation",           │ ServicesManager
  │   "create", "default", "agent1") ─→│   │
  ├── invoke("chat", "send",           │   ├── workspace.service.ts
  │   "conv-xxx", "你好") ────────────→│   ├── conversation.service.ts
  │                                    │   └── chat.service.ts
  │                              ←─────┤
  │  on("chat:chunk", cb) ←────────────│  webContents.send
```

各 service 为 class，通过 `ServiceContext` 持有 provider 和互访引用。

## 目录结构

```
~/.ai-zen/                    ← 共享根
├── desktop/                  ← Desktop 运行时数据
│   ├── workspaces.json       ← Workspace 列表
│   ├── conversations-index.json ← 对话摘要索引
│   └── conversations/        ← 对话完整内容
├── agents/                   ← Agent 定义（与 CLI 共用）
├── sub-agents/               ← SubAgent 定义（共用）
├── skills/                   ← Skill 目录（共用）
├── tools/                    ← 用户工具（共用）
├── mcp.json                  ← MCP 配置（共用）
└── mcp-oauth/                ← MCP OAuth 令牌（共用）
```

## 开发

```bash
# 安装依赖
pnpm install

# 构建渲染进程（开发模式，带热更新）
pnpm dev:render

# 构建主进程（开发模式，watch）
pnpm dev:main

# 构建全部
pnpm build

# 启动
pnpm start
```

## 开发文档

- [Electron 环境搭建](docs/electron-setup.md) — 首次搭建、二进制下载失败处理、path.txt 注意事项
- [CDP 远程调试](docs/cdp-debug.md) — 通过 Chrome DevTools Protocol 调试 Electron 页面（推荐使用 `.ai-zen/tools/` 中的 CDP 工具集）

## License

ISC
