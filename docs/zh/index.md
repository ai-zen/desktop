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
| 主进程 | Electron 43（Node 24）+ TypeScript + rolldown 打包 |
| 渲染进程 | Vue 3 + Vite + Pinia + Element Plus |
| 流式 Markdown | markdown-it + highlight.js（按需注册语言，同步渲染） |
| Agent 运行时 | `@ai-zen/agents-sdk`（Provider / Agent / MCP 能力）—— 跑在**常驻服务端**那边 |
| 数据存储 | 常驻服务端 `agents-server`（工作区与会话存档都在它盘上，桌面端不落盘） |

## 项目结构

```
desktop/
├── packages/
│   ├── main/       ← Electron 主进程（rolldown 打包，ESM；面向对象单根 DesktopApp）
│   ├── render/     ← Vue 3 渲染进程（Vite；瘦客户端，只调服务 + 订阅事件）
│   └── shared/     ← 共享类型 / IPC 事件 DTO（纯类型，零运行时）
├── scripts/dev.mjs ← 根目录 `pnpm dev` 一键开发
└── AGENTS.md       ← 接手指南（协作原则 / 启动 / 踩坑记录）
```

## 通信架构

**前后端分离心智**：render 是瘦客户端，不产生业务状态；一切通过 IPC 单通道调用 + 事件回流。

- **调用**：`invokeService(service, method, ...args)` 动态分发到主进程对应 service（preload 暴露，极薄，零业务定义）
- **推送**：`chat:push` 单通道事件流 `start → user → message… → done / error`（+ 独立的 `migrated` / `renamed` / `notice` / `agents`）

详细架构见 [架构设计](./desktop-design.md)。

## 核心概念

- **Workspace**：`{ id, name, cwd }`；`cwd` 是会话在服务端运行时的工作目录，一个 workspace 对应一个本地目录。
- **Conversation**：`{ id, workspaceId, agentId, modelId, name, messages, createdAt, updatedAt }`，每 workspace 下多个会话。
- **模型优先级**：会话级 `modelId` > Agent 定义 > 全局默认（解析在服务端，客户端只读生效值）。
- **agent 归服务端**：每个会话在服务端有一个 agent，会话活着它就活着；不运行时的状态由服务端的存档（`workspaces/<id>/sessions/`）接管。

## 文档导航

- [快速开始](./getting-started.md) —— 环境要求、安装、启动、核心概念与使用流程
- [架构设计](./desktop-design.md) —— 分层、连接、协议面、状态归属
- [环境搭建](./electron-setup.md) —— Electron 二进制下载失败处理、`path.txt`
- [CDP 调试](./cdp-debug.md) —— 通过 Chrome DevTools Protocol 调试渲染进程

有关协作原则 / 启动 / 踩坑记录，请阅读仓库根目录的 `AGENTS.md`。
