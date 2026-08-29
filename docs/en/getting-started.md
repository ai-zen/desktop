---
title: Getting Started
description: Environment requirements, installation, startup, usage flow and a quick overview of core concepts for AI-Zen Desktop
outline: deep
---

# Getting Started

## Environment Requirements

| Item | Requirement |
|------|-------------|
| Package manager | pnpm (the repository uses a pnpm workspace, see `pnpm-workspace.yaml`) |
| Node.js | `package.json` does not declare `engines`; a Node toolchain is required for development. Electron 43 ships Node 24.x (with `node:sqlite`), zero native dependencies |
| Platform | Electron is cross-platform; debugging examples mainly target Windows |
| CDP tools | `.ai-zen/tools/cdp-*.mjs` need Node.js ≥ 21 (built-in `WebSocket` / `fetch`, zero external dependencies) |

## Installation

```bash
# Install all workspace dependencies at the repository root
pnpm install
```

> If the Electron binary download fails, see [Environment Setup](./electron-setup.md).

## Start the Development Environment

```bash
# One-click development: rolldown watch(main) + vite(render) + nodemon restarts electron
pnpm dev
```

- Composition: `vite` (render hot reload) + `rolldown --watch` (main compile) + `nodemon` (restart electron on main changes) + `electron` (with `--remote-debugging-port=9222`)
- In development mode Electron loads `http://localhost:5173` (**hard-coded** in `packages/main/src/main.ts`), CDP debug port `9222`

> ⚠️ **Make sure there is no already-running dev instance before starting**:
> Two vite processes fight over port 5173 (the later one backs off to 5174, but Electron hard-codes 5173), and two Electron processes fight over CDP 9222, leading to unpredictable behavior.
> If an instance already exists, use [CDP Debugging](./cdp-debug.md) directly and do not run `pnpm dev` again.

## Build and Type Check

```bash
# Build everything
pnpm build

# render type check (after changing apis/stores/views)
cd packages/render && pnpm exec vue-tsc --noEmit

# main build (after changing services/storage/main)
cd packages/main && pnpm build
```

## Usage Flow (User Perspective)

On first launch, you enter the **guide page** (when there is no workspace), create a workspace (name/directory are both optional; directory defaults to Desktop), then enter the main interface:

1. **Create a workspace**: Sidebar "Create" → fill in name + choose directory (`dialog:selectDirectory` native directory picker, defaults to Desktop, remembers last location)
2. **Create a conversation**: Button + dropdown to select an Agent (default preselected) → enter the conversation
3. **Send a message**: User message appears on screen → AI streams a reply (reasoning / tool calls can be collapsed)
4. **Stop generation**: While streaming, the send button switches to "Stop" → `ChatService.abort()`, interruption keeps the already-generated part
5. **Switch conversations**: Switch at any time; the main process `getState` guarantees state is not lost

## Core Concepts

- **Workspace**: `{ id, name, cwd }`; `cwd` is the injection base for the Provider, defaulting to Desktop as fallback; deleting a workspace cascades to delete its conversations.
- **Conversation**: `{ id, workspaceId, agentId, modelId, name, messages, createdAt, updatedAt }`; `modelId` is a conversation-level local parameter.
- **Model priority**: conversation `modelId` > Agent definition > global default.
- **agent run registry**: each conversation's agent is resident only during runtime (readable while streaming), released after `done/error`; when not running, the SQLite snapshot takes over.
- **`chat:push` events**: `start → user → message → done / error` (+ independent `migrated` / `renamed`).

## References

- [Architecture Design](./desktop-design.md) — layering, design decisions, data flow
- [Environment Setup](./electron-setup.md) — Electron binary, `path.txt`, CDP port
- [CDP Debugging](./cdp-debug.md) — DevTools Protocol debugging methods
