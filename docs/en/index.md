---
title: AI-Zen Desktop
description: AI-Zen Desktop — a multi-workspace, multi-conversation AI workbench (Electron + Vue 3) project overview and documentation guide
outline: deep
---

# AI-Zen Desktop

> **npm package** `@ai-zen/desktop-workspace` · **License** ISC

AI-Zen Desktop is the **desktop workbench** of AI-Zen: built with Electron + Vue 3, it supports **multiple workspaces and multiple concurrent conversations**. Each workspace points to a local directory, where you have streaming conversations with the AI.

## Tech Stack

| Layer | Technology |
|-------|------------|
| Main process | Electron 43 (Node 24) + TypeScript + rolldown bundling |
| Renderer process | Vue 3 + Vite + Pinia + Element Plus |
| Streaming Markdown | markdown-it + highlight.js (languages registered on demand, synchronous rendering) |
| Agent runtime | `@ai-zen/agents-sdk` (Provider / Agent / MCP capabilities) — running on the **resident server** side |
| Data storage | the resident `agents-server` (workspaces and conversation archives live on its disk; Desktop's own persistence is just the one connection-settings file, `desktop/connection.json`) |

## Project Structure

```
desktop/
├── packages/
│   ├── main/       ← Electron main process (rolldown bundling, ESM; object-oriented single root DesktopApp)
│   ├── render/     ← Vue 3 renderer process (Vite; thin client, only calls services + subscribes to events)
│   └── shared/     ← Shared types / IPC event DTOs (pure types, zero runtime)
├── scripts/dev.mjs ← Root `pnpm dev` one-click development
└── AGENTS.md       ← Handover guide (collaboration principles / startup / pitfalls)
```

## Communication Architecture

**Frontend/backend separation mindset**: render is a thin client and does not generate business state; everything goes through a single IPC channel for calls + event callbacks.

- **Call**: `invokeService(service, method, ...args)` dynamically dispatches to the corresponding service in the main process (exposed via preload, very thin, zero business definitions)
- **Push**: `chat:push` single-channel event stream `start → user → message… → done / error` (+ independent `migrated` / `renamed` / `notice` / `agents`)

See [Architecture Design](./desktop-design.md) for details.

## Core Concepts

- **Workspace**: `{ id, name, cwd }`; `cwd` is the working directory conversations run in on the server, one workspace per local directory.
- **Conversation**: `{ id, workspaceId, agentId, modelId, name, messages, createdAt, updatedAt }`, multiple conversations per workspace.
- **Model priority**: conversation-level `modelId` > Agent definition > global default (resolved on the server; the client only reads the effective value).
- **The agent belongs to the server**: each conversation has an agent on the server, and it lives as long as the conversation does; when idle, the server's archive (`workspaces/<id>/sessions/`) takes over.

## Documentation Navigation

- [Getting Started](./getting-started.md) — environment requirements, installation, startup, core concepts and usage flow
- [Architecture Design](./desktop-design.md) — layering, connection, protocol surface, state ownership
- [Environment Setup](./electron-setup.md) — handling Electron binary download failures, `path.txt`
- [CDP Debugging](./cdp-debug.md) — debugging the renderer process via the Chrome DevTools Protocol

For collaboration principles / startup / pitfalls, please read `AGENTS.md` at the repository root.
