---
title: 快速开始
description: AI-Zen Desktop 的环境要求、安装、启动、使用流程与核心概念速览
outline: deep
---

# 快速开始

## 环境要求

| 项 | 要求 |
|----|------|
| 包管理 | pnpm（仓库使用 pnpm workspace，见 `pnpm-workspace.yaml`） |
| Node.js | `package.json` 未声明 `engines`；开发需具备 Node 工具链。Electron 43 内置 Node 24.x |
| 平台 | Electron 跨平台；调试示例以 Windows 为主 |
| CDP 工具 | `.ai-zen/tools/cdp-*.mjs` 需要 Node.js ≥ 21（内置 `WebSocket` / `fetch`，零外部依赖） |

## 安装

```bash
# 在仓库根目录安装所有 workspace 依赖
pnpm install
```

> 若 Electron 二进制下载失败，见 [环境搭建](./electron-setup.md)。

## 启动开发环境

```bash
# 一键开发：rolldown watch(main) + vite(render) + nodemon 重启 electron
pnpm dev
```

- 组合：`vite`（render 热更新）+ `rolldown --watch`（main 编译）+ `nodemon`（main 变更重启 electron）+ `electron`（带 `--remote-debugging-port=9222`）
- 开发模式 Electron 加载 `http://localhost:5173`（**写死**于 `packages/main/src/app.ts`），CDP 调试端口 `9222`（可用环境变量 `CDP_PORT` 覆盖）

> ⚠️ **启动前务必确认没有已运行的 dev 实例**：
> 两个 vite 会抢 5173 端口（后启动退让到 5174，但 Electron 写死加载 5173）、两个 Electron 抢 CDP 9222，会导致行为不可控。
> 若已有实例，直接用 [CDP 调试](./cdp-debug.md)，不要再 `pnpm dev`。

## 构建与类型检查

```bash
# 构建全部
pnpm build

# render 类型检查（改 apis/stores/views 后）
cd packages/render && pnpm exec vue-tsc --noEmit

# main 构建（改 server/main 后）
cd packages/main && pnpm build
```

## 使用流程（用户视角）

启动后的第一屏是**连接状态屏**（窗口先出来、连接在后面）：显示「正在连接 <label>」（重试等待中多一句「第 N 次重试，约 X 秒后」）；连上（`ready`）之后才按有没有 workspace 落到引导页或主界面。连不上时这一屏给一句错误（含「已重试 3 次仍未连上」）加「重试」与「去设置」—— **未连接也能进设置页**，在那里改回「本地」或换地址 / 凭证，保存并重连成功后自动进主界面。

连上之后，首次启动进入**引导页**（无 workspace 时），创建一个工作空间（名称/目录均选填，目录默认桌面），随后进入主界面：

1. **创建工作空间**：侧栏「创建」→ 填名称 + 选目录（`dialog:selectDirectory` 原生目录选择器，默认桌面、记住上次位置）
2. **新建对话**：按钮 + 下拉选 Agent（默认预选）→ 进入对话
3. **发送消息**：用户消息上屏 → AI 流式回复（思考/工具调用可折叠）
4. **中止生成**：流式中发送按钮切换「停止」→ 服务端取消本轮，中断保留已生成部分
5. **切换会话**：随时切换，`getState` 每次都向服务端要实时快照，不丢状态

## 核心概念

- **Workspace**：`{ id, name, cwd }`；`cwd` 是会话在服务端运行时的工作目录，默认桌面兜底；删除 workspace 级联删除会话。
- **Conversation**：`{ id, workspaceId, agentId, modelId, name, messages, createdAt, updatedAt }`；`modelId` 是这段会话**生效**的模型（服务端三级解析的结果）。
- **模型优先级**：对话 `modelId` > Agent 定义 > 全局默认。
- **agent 归服务端**：每个会话在服务端有一个 agent，会话活着它就活着（流式中可读），服务端按空闲宽限期回收；不运行时状态由服务端的存档接管。
- **`chat:push` 事件**：`start → user → message… → done / error`（+ 独立的 `migrated` / `renamed` / `notice` / `agents`）。

## 参考

- [架构设计](./desktop-design.md) —— 分层、连接、协议面、状态归属
- [环境搭建](./electron-setup.md) —— Electron 二进制、`path.txt`
- [CDP 调试](./cdp-debug.md) —— DevTools Protocol 调试方法
