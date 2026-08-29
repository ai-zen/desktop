---
title: Architecture Design
description: AI-Zen Desktop's layered architecture, core entities, design decisions and data flow (an early v0.5 design outline, which differs from the current implementation)
outline: deep
---

# Desktop Design Outline (v0.5 final)

> Status: **Architecture + key decisions + user scenarios + render layering finalized**.
> Development strategy: **UI first** — prototype = UI = actual interaction, main is built to fulfill UI requirements.
> Prerequisite: SDK 0.5.0 removed the session/draft product layer; Desktop builds its own product layer.

> ⚠️ **Note**: This document is an **early version (v0.5) design outline**, reflecting the architecture ideas at that time, **which differs from the current implementation**.
> The current implementation (source code is the source of truth) has evolved into: storage changed to SQLite (`node:sqlite` + worker_threads, see `packages/main/src/storage/`),
> the main process uses an object-oriented single root `DesktopApp` for assembly (see `packages/main/src/app.ts`, handwritten DI / constructor injection),
> render uses markdown-it + highlight.js, IPC goes through `invokeService` dynamic dispatch (see `ServicesManager`) and `chat:push` event callbacks.
> The core concepts in this document (Workspace / Conversation / agent run registry / `chat:push`) still match the current implementation.

---

## 1. Positioning

- Desktop is an Electron desktop application that consumes `@ai-zen/agents-sdk` (engine) and `@ai-zen/agents-core` (message model).
- The SDK only handles "driving + capabilities" (Provider / Agent / tools / plugins); Workspace and Conversation are **product data** that Desktop maintains itself.
- Target form: multiple workspaces (each pointing to a local directory), multiple concurrent conversations, streaming conversation interface.

---

## 2. Layered Skeleton

```
render    Vue + Pinia view layer (transport / stores / views / components)
shared    type contract layer (pure types)       — entities + IPC event DTOs
main      main process host layer (object-oriented: classes + constructor injection)
  ├─ services/   application service classes (ProviderPool / Workspace / Conversation / Chat)
  ├─ storage/    storage classes (Workspace repository / Conversation repository)
  ├─ events/     event dispatch (interface + Electron implementation)
  ├─ provider/   engine interaction wrapper classes (ProviderFactory / AgentFactory)
  ├─ ipc/        IPC registration classes
  ├─ window/     window management classes
  ├─ container.ts  manual DI assembly (new everything, in dependency order)
  └─ main.ts        entry boot
```

Dependency direction: render → shared; main → shared + SDK; each layer uses constructor injection / converged dependencies, no global singletons, no scattered calls.

---

## 3. Core Entities (Conceptual)

- **Workspace**: `{ id, name, cwd }` — the only persisted entity, stored in `workspaces.json`.
- **Conversation**: `{ id, workspaceId, agentId, modelId, name, messages, timestamps }` — multiple conversations per workspace, one file per conversation.
  - `modelId` is a **conversation-level local parameter**, overriding the Agent definition (priority: conversation > Agent definition > global default).
- **Message model**: directly reuses Core's `AgentNS.Message`, no new model, no adapter; use inheritance if extension is truly needed.
- **Event DTO**: `chat:push { conversationId, type: start|delta|done|error, ... }` — single-channel publish/subscribe.

---

## 4. Design Decisions (Finalized)

### A. Architecture Decisions

| # | Decision | Rationale |
|---|----------|------------|
| A1 | Workspace is the only persisted entity; **Provider is not persisted**, maps 1:1 at runtime, **lazy-loaded** | Avoid dual writes; create on demand |
| A2 | One Provider per workspace (injecting `cwd`), **multiple concurrent conversations** don't interfere | Tools use Provider.cwd as the base |
| A3 | Conversation repository reuses the SDK `EntityRepository`, directory `conversations/{wsId}/{id}.json` | Reuse mature CRUD; directory isolation is naturally safe |
| A4 | Delete `conversations-index.json`; the list is derived by repository scanning | Single source of truth, no dual writes |
| A5 | **preload is only a communication channel (transport)**: `invoke/on/off` + the window four-piece set, zero business definitions, replaceable (future ws/http also possible) | Changing transport doesn't affect the contract; piling definitions into preload is anti-pattern |
| A6 | Business push goes through **EventDispatcher (pub/sub)**: ChatService only emits, render subscribes on demand | Decouple window objects; multiple consumers subscribe directly |
| A7 | Message model **directly reuses Core `AgentNS.Message`**, unified across three layers with zero conversion | Avoid dual-model splitting |
| A8 | Restore history as `agent.messages = history`; after `agent.send()` do a **full snapshot** write, even on error | Single source of truth; don't manually construct user messages |

### B. Product Decisions

| # | Decision | Description |
|---|----------|-------------|
| B1 | Provider lazy loading | Create on use, optional warmUp |
| B2 | main depends on SDK via **online 0.5.0** | Consistent with CLI; temporary link during development |
| B3 | **UI first**: fully develop the UI from the user's perspective as an interactive prototype, main built to fulfill UI requirements | Prototype = UI = actual interaction |
| B4 | No pre-embedded extension fields on messages | YAGNI, add when needed |
| B5 | Creating a conversation: button + dropdown to select Agent; switch model within a conversation (conversation-level local parameter override) | `agent.model = createModel(provider, conv.modelId)`, model is a Core writable field, **no SDK change needed** |
| B6 | Single event channel `chat:push` + discriminated union | render converges into one subscription function |

### C. Engineering Principles (OO but not over-abstracted)

| # | Principle | Description |
|---|-----------|-------------|
| C1 | **Everything is a class + constructor injection**, no global singletons | Explicit dependency relationships; AI reads the constructor to know the boundaries |
| C2 | **No pre-embedded abstractions**: only extract interfaces when "there are genuinely multiple implementations / runtime replacement is needed / crossing external boundaries" | Reject Java-style interface/impl duplication bloat |
| C3 | **Current abstractions**: main-side `IEventDispatcher`; render-side `Transport` (both because of multiple implementations: electron ↔ mock/ws) | Genuine multi-implementation boundaries |
| C4 | Composition over inheritance, single responsibility; SDK interactions converge into factory classes (ProviderFactory / AgentFactory) | Avoid scattered SDK calls |
| C5 | `container.ts` manual DI assembly; render's `mock-transport` can be swapped entirely | No framework; swap implementation to test / integrate |

### D. Scenario Decisions

| # | Decision | Description |
|---|----------|-------------|
| D1 | **MVP scope** = 11 P0 scenarios (see Section 5) | Core path: start → create workspace → create conversation → chat → switch |
| D2 | First launch shows the **guide page** (when no workspace) | `GuideView`, switch to main interface after creation |
| D3 | **Remember last active state** (workspace + conversation), auto-restore on startup | Separate UI state file, not in the workspace entity |
| D4 | Agent list = `~/.ai-zen/agents` (reuse SDK `AgentRepository`) | Single source; sub-agent multi-source handled by SDK |
| D5 | Model list = global `config.models` (reuse SDK `ConfigManager`) | Shares configuration with CLI |
| D6 | Streaming **full data**, UI compromise: body first, **reasoning/tool calls collapsed & expandable** | Get the full data, render on demand |
| D7 | Provide **retry** after error (send the same content again) | High-frequency scenario, good UX |
| D8 | Multiple concurrent conversations: **focus current + sidebar running indicator** | Refresh the backing conversation list when a background conversation completes |

---

## 5. User Scenario List

### P0 (MVP core path)

| # | Scenario | Action → UI behavior |
|---|----------|----------------------|
| 1 | First-launch guide | No workspace → `GuideView` "create the first workspace" |
| 2 | Startup restore | Load the list, restore the last active workspace/conversation |
| 3 | Create workspace | Fill name + choose directory → appears in sidebar and activates |
| 6 | Create conversation | Button + right dropdown to select Agent (default preselected) → enter the conversation |
| 7 | Conversation list | Name/message count/time, sorted by update time descending; running indicator |
| 8 | Switch conversation | Load history messages |
| 11 | Send message | User message appears on screen → AI streams a reply |
| 12 | Streaming render | Reasoning/body/tool calls incrementally displayed (reasoning and tool calls collapsible) |
| 13 | Sending state | Input still typeable; indicator shown while replying |
| 15 | Error feedback | Clear prompt + retry button; conversation keeps its progress |
| 18 | Window controls | Frameless custom title bar (already present) |

### P1 (Enhancements)

| # | Scenario | Action → UI behavior |
|---|----------|----------------------|
| 4 | Rename workspace | Hover/right-click → rename |
| 5 | Delete workspace | Delete after confirmation, cascading to its conversations |
| 9 | Delete conversation | Delete after confirmation |
| 14 | Switch model within a conversation | Select model at the conversation header → applies to subsequent messages |
| 17 | Multiple concurrent workspaces | Each with its own Provider, no interference; sidebar running indicator |
| 20 | **Settings page** | `SettingsView`: API Key / default model / Agent list / data directory |

### P2 (Postponed)

| # | Scenario |
|---|----------|
| 10 | Rename conversation |
| 16 | Clear conversation |
| 19 | Theme (light/dark follow system) |

---

## 6. render Layering

```
render/src/
  transport/          # communication layer —— the only abstraction (mock ↔ electron, two implementations)
    transport.ts      #   Transport interface: invoke(service,method,...args) / on / off
    electron-transport.ts   # Electron implementation (wraps window.electronAPI)
    mock-transport.ts       # Mock implementation (UI first: in-memory data + simulated streaming push)
    api.ts                  # Typed API: invoke converged into methods (contract derived from UI usage)

  stores/             # state layer —— the only data entry point
    workspace.store.ts
    conversation.store.ts
    chat.store.ts
    ui.store.ts         #   page switching (currentView) + guide state

  views/              # page layer —— one directory per page, entry fixed as index.vue, other components PascalCase
    guide/
      index.vue         # guide page
    main/
      index.vue         # main interface: combines Sidebar + ChatPanel
      Sidebar.vue
      ChatPanel.vue
      MessageBubble.vue
      NewChatDialog.vue
      ModelSelect.vue
    settings/
      index.vue         # settings page
      ApiKeyForm.vue

  components/         # cross-page shared components (promote only when a second usage appears, YAGNI)
    TitleBar.vue

  App.vue             # root: switches pages by uiStore.currentView (v-if, no router)
  main.ts
  styles/
```

### render Layering Principles

| Principle | Implementation |
|-----------|----------------|
| Components/pages don't touch transport | Only call store actions / read store state |
| store is the only data entry | store internally calls api (typed methods) |
| transport converges invoke/on/off | No scattered `invoke("workspace","list")` strings |
| **mock lives in the transport layer** | UI first uses mock-transport; switch to electron-transport when the real main is ready, zero UI changes |
| Page-specific components stay in the page dir | Promote to `components/` only for cross-page sharing |
| Component naming | Page entry `index.vue`, others **PascalCase** |
| Page switching | `uiStore.currentView` + v-if (few pages, no router) |

---

## 7. main Layering (object-oriented, not over-abstracted)

```
main/src/
  services/    ProviderPool / WorkspaceService / ConversationService / ChatService
  storage/     WorkspaceRepository / ConversationRepository (reuse EntityRepository)
  events/      IEventDispatcher + ElectronEventDispatcher (the only abstraction)
  provider/    ProviderFactory / AgentFactory (converge SDK interactions)
  ipc/         IpcRegistrar
  window/      WindowManager
  container.ts manual DI assembly
  main.ts      boot
```

One-sentence module responsibilities:
- **ProviderPool**: workspaceId → Provider 1:1 mapping + lazy-load lifecycle.
- **WorkspaceService**: workspace CRUD, composes ProviderPool.
- **ConversationService**: conversation CRUD + message snapshot save (only touches storage, not the Agent).
- **ChatService**: send → get Provider → AgentFactory builds Agent → send → stream push → persist.
- **WorkspaceRepository**: read/write workspaces.json.
- **ConversationRepository**: reuses EntityRepository, directory `conversations/{wsId}`.
- **EventDispatcher**: `emit(channel, payload)` (interface + Electron implementation).
- **ProviderFactory**: wraps `Provider.create(cwd)`.
- **AgentFactory**: wraps `createAgent + restore history + override model`.
- **IpcRegistrar**: registers invoke routes + window controls.
- **WindowManager**: window creation/management.
- **container**: assembles the dependency graph; **main.ts**: boot.

---

## 8. Core Data Flow (Conceptual)

Sending a message:
1. render `chatStore.send` → api → main `ChatService`
2. Read the conversation → ProviderPool gets the workspace's Provider → AgentFactory builds the Agent (restore history → override model)
3. `agent.send()`, chunk events → EventDispatcher → `chat:push` push → render `chatStore.applyEvent` → incremental render
4. On send end → full message snapshot to disk → push `done`

---

## 9. Boundary with the SDK

| SDK / Core provides | Desktop builds itself |
|---------------------|-----------------------|
| Provider (cwd / capability pipeline) | ProviderPool (1:1 lazy-load management) |
| createAgent / SdkAgent / tools / plugins | AgentFactory (restore history + override model), conversation storage, stream push adaptation, UI |
| `AgentNS.Message` (message model) | reuse directly (no new model) |
| `AgentRepository` / `ConfigManager` | Agent/model lists reused directly (D4/D5) |

---

## 10. Implementation Order (UI first)

1. **Build the UI skeleton**: transport (mock) + stores + App page switching + GuideView guide page (scenario 1)
2. **Main interface**: MainView (Sidebar tree + conversation list + create conversation → ChatPanel streaming chat, scenarios 2/3/6/7/8/11/12/13/15)
3. **Extract service contracts from the UI**: api.ts method signatures + event channels + shared types
4. **main implementation** (services → storage → events → provider → ipc → container), switch to electron-transport for integration
5. **Enhancements**: P1 (rename/delete/switch model/concurrent/settings page)
6. **Integration verification**: multiple concurrent workspaces, model override, streaming render, retry

---

## 11. Decided / Postponed Items

- **Decided**: A1–A8, B1–B6, C1–C5, D1–D8; P0/P1/P2 scenarios; render layering (views organization, PascalCase naming, v-if page switching); main layering.
- **Postponed**: window form (single main window + custom title bar as-is), rendering technical details (stream diff, markdown rendering), full IPC method list (derived after UI finalization), whether storage needs an interface (extract when a second implementation appears).
