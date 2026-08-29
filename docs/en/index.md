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
| Main process | Electron 43 (Node 24 built-in `node:sqlite`) + TypeScript + rolldown bundling |
| Renderer process | Vue 3 + Vite + Pinia + Element Plus |
| Streaming Markdown | markdown-it + highlight.js (current implementation; the earlier approach was markstream-vue + Shiki, see the difference note in [Architecture Design](./desktop-design.md)) |
| Agent runtime | `@ai-zen/agents-sdk` (Provider / Agent / MCP capabilities) |
| Data storage | SQLite (`node:sqlite` + worker_threads, zero native dependencies) |

> ⚠️ **Note on the source of truth**: The description of "markstream-vue + Shiki" in README / AGENTS.md refers to the **old implementation**.
> The renderer process currently uses `markdown-it + highlight.js` (see `packages/render/package.json`, `TODO.md`). This repository's documentation follows the current source code.

## Project Structure

```
desktop/
├── packages/
│   ├── main/       ← Electron main process (rolldown bundling, ESM; object-oriented single root DesktopApp)
│   ├── render/     ← Vue 3 renderer process (Vite; thin client, only calls services + subscribes to events)
│   └── shared/     ← Shared types / IPC event DTOs (pure types, zero runtime)
├── scripts/dev.mjs ← Root `pnpm dev` one-click development
├── AGENTS.md       ← Handover guide (collaboration principles / startup / pitfalls)
└── TODO.md         ← Feature Roadmap
```

## Communication Architecture

**Frontend/backend separation mindset**: render is a thin client and does not generate business state; everything goes through a single IPC channel for calls + event callbacks.

- **Call**: `invokeService(service, method, ...args)` dynamically dispatches to the corresponding service in the main process (exposed via preload, very thin, zero business definitions)
- **Push**: `chat:push` single-channel event stream `start → user → message → done / error` (+ independent `migrated` / `renamed`)

See [Architecture Design](./desktop-design.md) for the detailed architecture.

## Core Concepts

- **Workspace**: the only persisted entity, `{ id, name, cwd }`; `cwd` is injected into the Provider, one workspace corresponds to one local directory.
- **Conversation**: `{ id, workspaceId, agentId, modelId, name, messages, createdAt, updatedAt }`, multiple conversations per workspace.
- **Model priority**: conversation-level `modelId` > Agent definition > global default.
- **agent = the single source of truth for conversation state**: resident during runtime, released after run; when not running, the SQLite snapshot takes over.

## Documentation Navigation

- [Getting Started](./getting-started.md) — environment requirements, installation, startup, core concepts and usage flow
- [Architecture Design](./desktop-design.md) — layering, core entities, design decisions, data flow
- [Environment Setup](./electron-setup.md) — handling Electron binary download failures, `path.txt`, CDP port
- [CDP Debugging](./cdp-debug.md) — debugging the renderer process via the Chrome DevTools Protocol

For collaboration principles / startup / pitfalls, please read `AGENTS.md` at the repository root; feature roadmap is in `TODO.md`.
