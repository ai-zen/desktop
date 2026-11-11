---
title: Architecture Design
description: AI-Zen Desktop's layering, connection, protocol surface and state ownership
outline: deep
---

# Architecture Design

## 1. Positioning: desktop shell + a resident server

Desktop is the **desktop shell** of AI-Zen: windows, native dialogs and IPC belong to it; conversation execution (the Agent loop, model requests, tools, archiving) belongs entirely to the **resident `agents-server`**. Desktop is therefore a thin client — it runs no Agent and keeps no local database. It holds one connection to the server, translates every action into a protocol call, and translates events pushed by the server into the shapes render understands.

The payoff is concrete: a crashed client loses no conversation (the server still has it), a restarted server lets the client grow back by itself (section 4), and "what state is this conversation in" always has exactly one answer — the server's.

## 2. Three packages

```
packages/
├── main/     Electron main process (rolldown, ESM)
├── render/   Vue 3 renderer (Vite; only calls services and subscribes to events)
└── shared/   type contract (pure types, zero runtime)
```

Dependency direction: `render → shared`, `main → shared + @ai-zen/agents-client`. render imports nothing from main; the only thing both sides share is the entities and IPC DTOs in `packages/shared/src/types.ts`.

## 3. main's layering

```
packages/main/src/
├── main.ts     entry: new DesktopApp().start()
├── app.ts      DesktopApp: window / IPC / native dialogs / events pushed to render
├── config.ts   the only path constant: AI_ZEN_DIR
├── preload.ts  contextBridge exposing window.electronAPI
└── server/     the server facade (directly verifiable by vitest + a real daemon)
    ├── index.ts            assembly root: createServerLayer
    ├── call.ts             one protocol call (fetches a live connection each time, caches no client)
    ├── services.ts         six Services: render's shapes ↔ protocol calls
    ├── ServicesManager.ts  invokeService dynamic dispatch
    ├── events.ts           server events → ChatStreamEvent
    ├── launch.ts           starts the server shipped with the app (on Electron's Node)
    └── notices.ts          notice code → Chinese text
```

Two hard boundaries:

- **`server/` never touches electron.** `createServerLayer` takes only four non-electron facts (config root, handshake identity, default working directory, event sink), so a test can start it directly; `app.getPath` / `dialog` / `webContents.send` appear only in `packages/main/src/app.ts`, passed in as arguments or callbacks.
- **`server/` never touches disk.** Conversation lists, messages, workspaces and config all come from the server over the protocol. The one exception is a process, not data: `launch.ts` starts a server process; it reads and writes no data files itself.

## 4. One connection (`ServerConnection`)

"Which server, and what if the connection dies" lives in exactly one implementation: `agents/packages/client/src/transport/connection.ts` in `@ai-zen/agents-client`. `packages/main/src/server/index.ts` assembles it once:

- **Which server** is answered by the discovery file (`<AI_ZEN_DIR>/run/server.json`). A restarted server switches ports and rewrites the file; this layer caches no port and remembers no pid.
- **Launching one when none is running**: `startServerProcess` is injected as `server/launch.ts`, which starts the copy **shipped with the app** (`dist/server.mjs`, built as a self-contained file by the `server` entry in `rolldown.config.mjs`) on Electron's bundled Node (`ELECTRON_RUN_AS_NODE=1`). A customer machine may have neither Node.js nor npm, so this path cannot use `npx` — that is the CLI's route, and it assumes npm is there.

Note that "prefer one that is already running" is not this layer's doing: it is `ensureServer`'s order — read the discovery file, `ping` once, use it if it answers. Spawning only happens when no live server exists.
- **What if it dies**: `client()` checks `closed` on every use and rebuilds in place when shut; `watch()` makes that connection start receiving events; `onOpen()` tells the layer above to re-attach its listeners when the connection was replaced.

All three matter, and the last one is the easiest to miss: listeners are attached to one **specific** `ServerClient`, and the client clears its listener table the moment the socket drops. Without re-attaching, the new connection can send requests but receives no events at all — the UI just sits there silently (no error, no reconnect, no notice).

`packages/main/src/server/call.ts` is the only seam between this layer and the connection: `protocolCall(connection)` awaits `connection.client()` and then `call(method, params)` on every invocation. It holds no state, so there is no second place that could stash a stale client.

## 5. Protocol surface

render has exactly one entry point: `electronAPI.invokeService(service, method, ...args)`, which `ServicesManager` looks up and dispatches to one of six Services.

| Dispatch key | Implementation | Main actions |
|--------------|----------------|--------------|
| `workspace` | `ServerWorkspaceService` | `workspace.list` / `create` (= `workspace.resolve`, plus one `workspace.rename` when a name was given) / `rename` / `remove` |
| `conversation` | `ServerConversationService` | `session.list` / `create` / `attach` + `snapshot` / `rename` / `remove` / `model.set` |
| `agent` | `ServerAgentService` | `agent.list` (entry Agents only) |
| `model` | `ServerModelService` | `models` out of `config.get` |
| `chat` | `ServerChatService` | `session.send` / `cancel` / `close` / `attach` + `snapshot` |
| `config` | `ServerConfigService` | `config.get` / narrow setters for defaults / `config.save` |

On the event side the contract has three unions (`agents/packages/server/src/protocol/sessions.ts`): `AgentEventName` with 8 entries (the original names of core's `Agent.events`), `SessionEventName` with 6 (things the server derives or decides), `ServerEventName` with 1 (a server notice bound to no conversation). Event names are always kebab-case — `session-turn-end`, `session-title-changed`, `server-notice`.

Method and event names are **literal union types** in `@ai-zen/agents-server/protocol`, never written as literals: a contract change then fails to compile here instead of returning a 500 at runtime.

## 6. Event translation (`packages/main/src/server/events.ts`)

`ChatEventBridge` subscribes to 12 of them and translates into the 9 `ChatStreamEvent` kinds render knows: `start` / `user` / `message` / `done` / `migrated` / `error` / `renamed` / `notice` / `agents`.

"what has to be remembered within a turn" is *not* here — which message deltas accumulate onto, how sub-agent deltas merge with server snapshots, whether a failure is terminal — that belongs to `SessionStream` in `@ai-zen/agents-client` (a pure state machine, zero I/O). Desktop has one connection carrying many concurrent conversations, so this layer keeps **one state machine per conversation** (`Map<conversationId, SessionStream>`); background conversations keep receiving events.

The translation layer does four things:

1. **The body of `user`.** The protocol does not push user messages (`chunk-parsed` carries model deltas only), so the body is registered on the `chat.send` side (`noteSend`) and consumed when `start` is dispatched. The placeholder id is `${conversation}:user:${turnId}` — it exists to give render a stable `v-for` key.
2. **The id of the placeholder assistant message.** The streaming temporary message inside the state machine deliberately carries no id (the settling snapshot supplies the real one; inventing a fake id would collide with it), so the key is minted here: one per turn (`${conversation}:assistant:${turnId}`). Text and tool calls land on the same message, whichever arrives first.
3. **Settling and migration follow the server snapshot.** `session-turn-end` carries only `ok` / `error`, so the layer fetches `session.snapshot` once, hands it to `stream.settle()`, and pushes the merged result as `done` (message status and the server's cleanup of history exist only in the snapshot). `session-id-changed` must **collapse aliases** (new id → the key render knows) and push `migrated`, otherwise a running conversation waits forever on the old id for a completion that will never come.
4. **`session-question` is auto-answered with "skip".** Desktop has no question UI, and not answering means the server waits out its timeout (`ASK_TIMEOUT_MS`, 5 minutes) while the user sees a UI that looks frozen. `choice: null` is the same value as the server's own fallback for this path, so this does not decide anything for the user — it just expresses the timeout early.

## 7. render's layering

```
packages/render/src/
├── main.ts        Vue entry (Pinia / ElementPlus)
├── App.vue        root: TitleBar + Guide/Main/Settings switching; subscribes to chat:push
├── views/         guide/index.vue, main/{index,Sidebar,ChatPanel,MessageBubble,NewChatDialog}.vue, settings/index.vue
├── components/    TitleBar.vue, MarkdownContent.vue
├── composables/   useMessageWindow (paged window), useAutoScroll (scroll policy)
├── stores/        ui / workspace / conversation / chat / agentView
└── apis/          base + workspace / conversation / chat / agent / model / config
```

- **apis only forwards**: `invokeService` is converged into methods and errors are normalized into `InvokeServerError`; `subscribeServiceEvent("chat:push", …)` is the single event entry point.
- **stores are the only data entry**: views never call `invokeService` with a string. `chat` slots state by `byConversation[id]`, so switching conversations only switches the viewpoint and each conversation's streaming state stays independent.
- **The sub-agent strip runs parallel to the main conversation**: `agents` is a wholesale replacement of `SubAgentView[]` (the server pushes the whole list on every change) and render does no diffing; selection repair and Tab cycling live in `packages/render/src/stores/agentView.ts` as pure, testable functions.
- **Notices are toasts, not state**: `type: "notice"` pops an element-plus message and never enters `ConversationChatState` — especially not `error`, which is the "this turn failed" banner that `done` clears.

## 8. Where data lives

Everything on disk belongs to the server (its `AI_ZEN_DIR`):

```
<AI_ZEN_DIR>/
├── config.json                  global config (endpoints / models / default model & Agent)
├── agents/                      entry Agent definitions
├── sub-agents/                  sub-agent definitions
├── workspaces/<workspaceId>/    workspace.json + sessions/<id>.json (with .meta.json listing)
└── run/server.json              service discovery: which port the resident server is on
```

Desktop reads exactly one thing here: `<AI_ZEN_DIR>/run/server.json`. Session lifetime is reclaimed by the server on an idle grace period (`DEFAULT_SESSION_IDLE_TIMEOUT_MS`); `session.close` releases a session immediately because the user stopped looking at it. Neither deletes the archive.

## 9. Model resolution has exactly one implementation

The three-level resolution ("conversation override > Agent definition > global default") lives on the server (SDK's `resolveModel`). Desktop neither caches nor recomputes it; it reads two fields:

- `SessionListEntry.modelId` — whether this conversation **has** its own override;
- `SessionListEntry.effectiveModelId` — which model it is **actually using** (omitted when it cannot be resolved).

The sidebar's model dropdown reads the latter; recomputing "override + definition + default" on the client would be a second copy of the precedence rule, and the two copies eventually diverge at some edge.

## 10. Test shape

The `server/` layer is verified directly by vitest: `packages/main/src/server/test-harness.ts` starts a **real daemon** (real port, real frames, real `SessionManager`) plus a **fake Agent** (the test decides when which delta is pushed). What is under test is the protocol mapping itself, so the Agent's streaming loop should be fake while the socket and discovery file must be real. Tests assert on the `ChatStreamEvent` sequence the facade pushes — that channel is the only acceptance surface the translation layer has.

## 11. Trade-offs

| Trade-off | Rationale |
|-----------|-----------|
| Splitting the connection from "how to send a request" (`ServerConnection` / `packages/main/src/server/call.ts`) | A client cached in an object dies permanently when the server restarts, and the only symptom is "nothing happens" |
| The state machine lives in the package, not in main | The "how to assemble a turn" rules can exist only once across this repo and the CLI; two copies diverge at edge cases |
| Wholesale event replacement (`message` / `agents`) | Consumers need no merge logic; incremental events spread that complexity across every consumer |
| Unknown notice codes still get text | Version skew is normal; silently dropping them shows the user "nothing happened" |
| The dictionary lives in main, not render | Text and "which event becomes which code" are the same concern, and all event translation already sits in main |
