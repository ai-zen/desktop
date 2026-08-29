---
title: AI-Zen Desktop
description: AI-Zen Desktop — 多 Workspace、多会话并存的 AI 工作台（Electron + Vue 3）项目概览与文档导览
outline: deep
---

# AI-Zen Desktop

> **npm 包名** `@ai-zen/desktop-workspace` · **License** ISC

AI-Zen Desktop 是 AI-Zen 的**桌面工作台**：以 Electron + Vue 3 构建，支持**多 Workspace、多会话并存**。每个 Workspace 指向一个本地目录，在该目录下与 AI 进行流式对话。

## 技术栈

| 层 | 技术 |
|----|------|
| 主进程 | Electron 43（Node 24 内置 `node:sqlite`）+ TypeScript + rolldown 打包 |
| 渲染进程 | Vue 3 + Vite + Pinia + Element Plus |
| 流式 Markdown | markdown-it + highlight.js（当前实现；早期方案 markstream-vue + Shiki，见[架构设计](./desktop-design.md)的差异说明） |
| Agent 运行时 | `@ai-zen/agents-sdk`（Provider / Agent / MCP 能力） |
| 数据存储 | SQLite（`node:sqlite` + worker_threads，零 native 依赖） |

> ⚠️ **口径说明**：README / AGENTS.md 中关于「markstream-vue + Shiki」的描述为**旧实现**。
> 当前渲染进程实际使用 `markdown-it + highlight.js`（见 `packages/render/package.json`、`TODO.md`）。本仓库文档以源码现状为准。

## 项目结构

```
desktop/
├── packages/
│   ├── main/       ← Electron 主进程（rolldown 打包，ESM；面向对象单根 DesktopApp）
│   ├── render/     ← Vue 3 渲染进程（Vite；瘦客户端，只调服务 + 订阅事件）
│   └── shared/     ← 共享类型 / IPC 事件 DTO（纯类型，零运行时）
├── scripts/dev.mjs ← 根目录 `pnpm dev` 一键开发
├── AGENTS.md       ← 接手指南（协作原则 / 启动 / 踩坑记录）
└── TODO.md         ← 功能 Roadmap
```

## 通信架构

**前后端分离心智**：render 是瘦客户端，不产生业务状态；一切通过 IPC 单通道调用 + 事件回流。

- **调用**：`invokeService(service, method, ...args)` 动态分发到主进程对应 service（preload 暴露，极薄，零业务定义）
- **推送**：`chat:push` 单通道事件流 `start → user → message → done / error`（+ 独立的 `migrated` / `renamed`）

详细架构见 [架构设计](./desktop-design.md)。

## 核心概念

- **Workspace**：唯一持久化实体，`{ id, name, cwd }`；`cwd` 注入给 Provider，一个 workspace 对应一个本地目录。
- **Conversation**：`{ id, workspaceId, agentId, modelId, name, messages, createdAt, updatedAt }`，每 workspace 下多个会话。
- **模型优先级**：对话级 `modelId` > Agent 定义 > 全局默认。
- **agent = 会话状态唯一真相**：运行期驻留、运行完释放；不运行时由 SQLite 快照接管。

## 文档导航

- [快速开始](./getting-started.md) —— 环境要求、安装、启动、核心概念与使用流程
- [架构设计](./desktop-design.md) —— 分层、核心实体、设计决策、数据流
- [环境搭建](./electron-setup.md) —— Electron 二进制下载失败处理、`path.txt`、CDP 端口
- [CDP 调试](./cdp-debug.md) —— 通过 Chrome DevTools Protocol 调试渲染进程

有关协作原则 / 启动 / 踩坑记录，请阅读仓库根目录的 `AGENTS.md`；功能 Roadmap 见 `TODO.md`。
