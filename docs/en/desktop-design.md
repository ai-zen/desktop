---
title: Architecture Design
description: AI-Zen Desktop's layering, connection, protocol surface and state ownership
outline: deep
---

# Architecture Design

## 1. Positioning: desktop shell + a resident host

Desktop is the **desktop shell** of AI-Zen: windows, native dialogs and IPC belong to it; conversation execution (the Agent loop, model requests, tools, archiving) belongs entirely to the **resident `agents-host`**. Desktop is therefore a thin client — it runs no Agent and keeps no local database. It holds one connection to the host, translates every action into a protocol call, and translates events pushed by the host into the shapes render understands.

The payoff is concrete: a crashed client loses no conversation (the host still has it), a restarted host lets the client grow back by itself (section 4), and "what state is this conversation in" always has exactly one answer — the host's.

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
├── main.ts     entry: new DesktopApp().start() (with its own .catch: a stray startup failure leaves one log line)
├── app.ts      DesktopApp: window / IPC / native dialogs / events pushed to render
├── config.ts   the path constant AI_ZEN_DIR (the connection settings are not in this file)
├── preload.ts  contextBridge exposing window.electronAPI
├── connection/ local or remote (the only persistence Desktop owns)
│   ├── settings.ts    **only binds the path** (`<AI_ZEN_DIR>/desktop/connection.json`); read/write/validate/wording live in `connection-settings.ts` in `@ai-zen/agents-client` (shared with the CLI)
│   └── controller.ts  ConnectionController: which layer is live / saving means reconnecting / testing a connection / three states + bounded retries
└── host/     the host facade (directly verifiable by vitest + a real host)
    ├── index.ts            assembly root: createHostLayer (six services + event bridge + the one connection)
    ├── contract.ts         the **narrow seam** to the client library (declares only what this layer uses; no `Client` class in parameter types)
    ├── services.ts         the six services: render's shapes ↔ contract calls
    ├── ServicesManager.ts  invokeService dynamic dispatch
    ├── events.ts           host events → ChatStreamEvent
    ├── stream.ts           streaming deltas → one core `AgentNS.Message` (only concatenates, never judges)
    ├── attachments.ts      attachment choreography: bytes → `asset.begin` / binary chunks / `asset.end` → assetId
    ├── problem.ts          a failure / a hint → `LocalizedText` / `ProblemFact`
    └── launch.ts           starts the host shipped with the app (on Electron's Node)
```

Two hard boundaries:

- **`host/` never touches electron.** `createHostLayer` takes only four non-electron facts (config root, handshake identity, default working directory, event sink), so a test can start it directly; `app.getPath` / `dialog` / `webContents.send` appear only in `packages/main/src/app.ts`, passed in as arguments or callbacks.
- **`host/` never touches data files.** Conversation lists, messages, workspaces and config all come from the host over the protocol. The only exceptions are the two facts the connection itself needs, both read-only: the address (`run/host.json`, the default path) and the credential (`run/token`), read fresh on every use by `HostConnection`; plus `launch.ts` starting a **process**, which reads and writes no data files itself.

"Never touches data files" is about **data**: conversations, workspaces, Agent definitions and model config are still owned solely by the host. Desktop does write exactly one file of its own — `<AI_ZEN_DIR>/desktop/connection.json` (`connection/settings.ts`: `0600`, atomic write, credential inside; unreadable / broken JSON / invalid fields all fall back to `{ mode: "local" }` and the app still starts). It has to live on this machine rather than on the host because of the **chicken and egg**: the host holds all the business config about where to connect, but asking it requires knowing **which host** first; storing "which host" on the host would mean a user must connect to a host before choosing a host. So this is the **only** local write, and no other entry point for writing data locally gets added — a deliberate exception, not a loosening.

### Startup order: the window first, the connection after

```
await app.whenReady()
nativeTheme / Menu
registerIpc()                 ← before the window: render invokes the moment it mounts
createMainWindow()            ← the window comes first
void connection.start()       ← connects in the background, **not awaited**
```

This order is the one thing in this document that has to be read literally; each of the three reasons blocks a different failure:

- **IPC has to come before the window**: render calls `invokeService` the moment it mounts, so a `registerIpc()` that runs one step late leaves the UI with nothing on it.
- **The window does not depend on the connection**: when a remote host is unreachable the window still appears — "cannot connect" then becomes **something inside the window** (the `connecting` / `error` status screen with its "retry"), not "the app failed to start".
- **`connection.start()` is not awaited**: it is one attempt running in the background; a failure only writes one log line and is handed to the state machine (the retries in section 4). `main.ts` adds a `.catch` of its own too — any stray failure on the startup path becomes one log line rather than "double-click does nothing".

## 4. One connection (`HostConnection`)

"Which host, which key, and what if the connection dies" lives in exactly one implementation: `agents/packages/client/src/connection.ts` in `@ai-zen/agents-client` (private, unpublished, inlined at build time). `packages/main/src/host/index.ts` assembles it once:

- **Which host** is answered by the discovery file (`<AI_ZEN_DIR>/run/host.json`) **by default**. A restarted host switches ports and rewrites the file; this layer caches no port and remembers no pid. When the user picks **remote** in the settings page, the address comes from `hostUrl` in the connection settings (persisted by `connection/settings.ts`) instead, and this default path steps aside — this layer still caches nothing and interprets nothing (the shape of an address is defined once, in the client package's `address.ts`).
- **Which key gets you in**: the credential defaults to `<AI_ZEN_DIR>/run/token` (read or created by the host at startup, `0600`); an explicit `hostToken` from the connection settings wins. Desktop only **passes both values through** — parsing, precedence and the plain sentence printed on `unauthorized` all live in one place in the client package (`connection.ts` and `errors.ts`).
- **Launching one when none is running**: `startHostProcess` is injected as `host/launch.ts`, which starts the copy **shipped with the app** (`dist/host.mjs`, built as a self-contained file by the `host` entry in `rolldown.config.mjs`) on Electron's bundled Node (`ELECTRON_RUN_AS_NODE=1`). A customer machine may have neither Node.js nor npm, so this path cannot use `npx` — that is the CLI's route, and it assumes npm is there.

Note that "prefer one that is already running" is not this layer's doing: it is `ensureHost`'s order — read the discovery file, `ping` once, use it if it answers. Spawning only happens when no live host exists. With an explicit address it never happens at all: whatever would be started on this machine is not listening on that address, so `launch.ts` only leaves one log line carrying the address and no credential.
- **What if it dies**: `client()` checks `closed` on every use and rebuilds in place when shut; `watch()` makes that connection start receiving events; `onOpen()` tells the layer above to re-attach its listeners when the connection was replaced.

All of these matter, and re-attaching after a reconnect is the easiest to miss: listeners are attached to one **specific** `HostClient`, and the client clears its listener table the moment the socket drops. Without re-attaching, the new connection can send requests but receives no events at all — the UI just sits there silently (no error, no reconnect, no notice).

`packages/main/src/host/contract.ts` is the only seam between this layer and the connection: it declares just what this layer needs (`call` / `subscribe` / `track` / `setAnchor` / `resolveTarget` …) and holds no state, so there is no second place that could stash a stale client. The client library swaps the underlying socket when it reconnects while the `HostConnection` object stays the same, so subscriptions never need re-hanging.

### Local / remote: the section in the settings page

"Which host" is not an input fixed at construction time; the user can change it in the **settings page**. That page opens with a "**Host connection**" section: a radio for **local** / **remote**; when remote, an **address** (`ws://` / `wss://` / `http://` / `https://`, paths supported, e.g. `wss://example.com/ai-zen`) and a **credential** (left empty = use this machine's `<AI_ZEN_DIR>/run/token`).

- **That section carries its own buttons, separate from the "Save" at the bottom of the page.** "Test connection" and "Save and reconnect" belong to the connection; the bottom "Save" writes "default model / default Agent / API Key" to the **host** (the one already connected). Merging them has a very concrete consequence: a user who only wanted to change the default model clicks once and ends up on another machine.
- **"Test connection" only probes the candidate values**: nothing is written to disk, the current connection is untouched. Success shows the host's self-reported `protocol` / `version` / elapsed time; failure shows the plain sentence the client package already renders (`explainUnauthorized`'s wording, e.g. pointing at the credential). Address validity is asked of `parseHostUrl` only — Desktop writes no second validation.
- **"Save and reconnect" swaps the connection immediately**: `ConnectionController.save()` runs **write to disk → `dispose()` the old layer → build the new one → `start()`**, with no app restart. A failed write touches no part of the connection (otherwise the UI says remote while the app is still on local); answers in flight are interrupted, hence the confirmation dialog before saving.
- **After a successful save the UI returns to the main interface and refetches everything that comes from the host** (conversations / workspaces / Agents / model list): a different host is a different world, and keeping the previous machine's conversation cache only makes the user click into a fetch that can never succeed.
- **Remote never starts a host on this machine**: whatever would be started here is not listening on that address. Local is the mode that does "discovery file + start on demand".

The config lives in `<AI_ZEN_DIR>/desktop/connection.json` (`0600`, atomic write), carried by five **dedicated** IPC channels `connection:get` / `connection:save` / `connection:test` / `connection:state` / `connection:reconnect` (they do not go into the service table below).

### Never configured: `unset` (first-run screen)

"Never configured" is not a kind of "cannot connect" — it is a decision only the **user** can make. It needs its own state: falling back to `{ mode: "local" }` squashes "first launch" into "the user picked local", so the app starts a local host on its own and the onboarding screen can never appear (the same shape of bug as "two booleans cannot hold three credential sources" in `resolve-target.ts`). The first arm of `ConnectionState` is therefore `{ status: "unset" }`: `start()` builds **no layer** at all in that case, and render puts up `views/setup` (this machine / remote + address & token + test connection).

### When it cannot connect: four states + bounded retries

The window comes up first (section 3), so "what state is this connection in right now" has to be a value that can be **asked for and pushed** — otherwise the `invokeService` calls render makes while mounting hit a connection that is not up yet and the screen is blank with no hint. The states are maintained in exactly one place, `ConnectionController`, and render only gates the UI on them:

- `connecting` — **covers** both "first attempt in flight" and "waiting for a retry". The two are told apart by `attempt` (`0` = the first attempt) and `nextRetryInMs` (how long until the next one);
- `ready` — connected, carrying the host's **self-reported** `protocol` / `version` (from the handshake reply; when unavailable they are `0` / `""` — connected but unaware of which version it is, which is more honest than inventing a number);
- `error` — the terminal state **after the retries failed too** (not "this attempt failed"), carrying one plain sentence in `message`.

Every state except `unset` carries a `label`: `"本机宿主"` (the local host) for local, the address for remote. It is produced by main (render may neither compose an address nor guess the mode) and it **never contains the credential** — userinfo in an address is stripped first.

**Bounded retries**: after the first failure there are at most **3** more tries, backing off **1s / 2s / 5s**; if all three fail → `error`, and from then on only the user's manual "retry" (`connection:reconnect`) is left. Automatic retries run one batch, not forever: an unreachable remote should not make the main process knock every 5 seconds for the rest of the day, and "quietly retrying forever" looks exactly like "stuck" in the UI.

**A retry rebuilds the whole layer** (`dispose()` → `build()` → `start()`), it does not call `start()` again: `ChatEventBridge.start()` overwrites `unsubscribeOpen` without unsubscribing first, so calling `start()` twice on the same bridge loses the previous `onOpen` subscription — and that subscription is exactly what re-attaches listeners when the connection was replaced. Lose it and no event ever arrives again; the UI just sits there silently. Every attempt therefore gets a new bridge and a new connection, owing nothing to the previous one.

The four exits of one attempt (connected → `ready` / schedule the next retry / enter `error` / superseded by a new configuration, so state must not be touched at all) all live in that one object; `save()` and `reconnect()` only bump the generation (clearing the pending timer and making the in-flight attempt stale).

## 5. Protocol surface

There is exactly one business entry point: `electronAPI.invokeService(service, method, ...args)`, dispatched by `ServicesManager` to six services. A few channels sit **outside** that table: connection settings and state `connection:get` / `save` / `test` / `state` / `reconnect` (section 4), window control `window:xxx`, and the native directory picker `dialog:selectDirectory` — none of them answers a host method; they answer questions of the main process itself.

The last two of the five connection channels are **a query** and **a manual retry**: `connection:state` asks "what is the state right now", `connection:reconnect` lets the user kick another round (clearing the pending timer, resetting `attempt`, returning the moment `connecting` begins while the round runs in the background). The same name `connection:state` is also a **push** channel (main → render), so "ask once" and "listen for changes" are the same name to callers. Neither is in the service table — those six keys are the host's method surface.

**The initial state is never pushed**: `connecting / attempt 0` is byte-identical to what `state()` returns before `start()`, so pushing it is noise. That is why render must **query once, then subscribe** on mount — pushing alone misses the change before mount, querying alone misses everything after it. `preload` exposes them as `electronAPI.connection = { get, save, test, state, reconnect }`.

On the host side it is **JSON-RPC 2.0 over WebSocket** (`agents/packages/host/src/wire/`): `host.hello` carries the credential plus client identity, every later call is `{ jsonrpc, id, method, params }` and the reply is a `result` or an `error` under the same `id` (`error.data` holds `code` + an already-rendered `message` + `detail`). The contract has **63 methods** (`METHOD_NAMES` in `wire/methods.ts`) across a dozen domains: `host.*` / `workspace.*` / `conversation.*` / `message.*` / `search.*` / `question.*` / `notice.*` / `config.*` / `agent.*` / `model.*` / `asset.*` (these three also use binary frames) / `completion.*` / `handoff.*`.

| Dispatch key | Implementation | Host methods actually called today |
|--------|------|----------|
| `workspace` | `HostWorkspaceService` | `workspace.list` / `create` / `rename` / `remove` |
| `conversation` | `HostConversationService` | `conversation.list` / `create` / `get` / `rename` / `remove` / `setModel` / `state` |
| `agent` | `HostAgentService` | `agent.list` |
| `model` | `HostModelService` | `model.list` |
| `chat` | `HostChatService` | `conversation.send` / `abort` / `message.list` / `question.list` / `question.answer` |
| `config` | `HostConfigService` | `config.get` / `saveEndpoint` / `setDefaults` |

**This table doubles as the desktop's outstanding-debt list**: of 63 methods the desktop uses 21. Search (`search.*`), revert (`conversation.revert`), pinning (`conversation.pin`), thinking effort (`conversation.setThinking`), transient conversations (`conversation.transient`), the notice bar (`notice.*`), `@` completion (`completion.files`), MCP and endpoint editing (`config.saveMcp` / `deleteMcp` / `getDiscovery` / `deleteEndpoint`), agent and model CRUD (`agent.*` / `model.*`), handoff (`handoff.*`), and `host.reload` / `upgrade` / `shutdown` / `capabilities` / `setLanguage` still have zero call sites — the debt is tracked in `agents/packages/host/docs/PLAN.md` §6.

Method and event names are **literal union types** in `@ai-zen/agents-host`'s `wire` (`MethodName` / `EventName`), never written as string literals: a contract change breaks the build here instead of failing at runtime.

## 6. Event translation (`packages/main/src/host/events.ts`)

The host pushes exactly **6 events** (`EVENT_NAMES` in `wire/events.ts`): `run.state` / `message.delta` / `conversation.changed` / `notice` / `question` / `usage`. `ChatEventBridge` turns them into the **12 `ChatStreamEvent` variants** render knows (`packages/shared/src/types.ts`):

| Host event | Emitted as | Notes |
|---|---|---|
| `message.delta` | `message` | The delta is folded into that assistant message with core's `applyChunk` (`stream.ts`); the whole `AgentNS.Message` is passed through |
| `run.state` | `stream` + `done` / `error` | Phase names and running tools pass through; on `settled` the bridge fetches `message.list` once and pushes `done` |
| `usage` | `message` | This turn's usage is pinned onto that assistant message (render replaces the whole message by id) |
| `notice` | `notice` | Level, duration, `LocalizedText` and owning conversation pass through (PRD D8) |
| `question` | `question` | The whole `QuestionView` passes through (see below) |
| `conversation.changed` | `renamed` | The new name is fetched with `conversation.get`; the push only says "it was renamed" |

Three more are not host pushes: `start` (a turn began, driven by `conversation.send` being accepted), `user` (the stored copy of the user message is fetched from the host), `attachments` (this turn's attachment outcomes) — plus `migrated` (full replacement after a handoff moved the task into a new conversation).

Folding a structure into one string is **not** done here (R75): everything carrying messages or content uses core's original shapes (`AgentNS.Message` / `MessageContentSection` / `ToolCall` / `Usage`) or the host's structures (`LocalizedText` / `ProblemFact` / `QuestionView`).

**Why settling always refetches from the host**: `run.state` only says "this turn ended and how". The message the client folded is merely an approximation good enough to scroll — tool-call arguments, message `status` and the host's cleanup of history exist only in the database. So after `settled` the bridge fetches `message.list` once and pushes the whole array as `done` (render's `done` is a full replacement). The same holds for the user message: the stored form of a message with images is an array of `image_url` content sections, while the client only has the characters the user typed.

**Question objects pass through whole, never auto-answered**: `prompt` / `options[]` / `blocking` / `state` / `kind` go to render unchanged and how to lay them out is render's business. There is **no** "auto-answer / skip on timeout" — picking an option for the user means deciding "whether to hand off, and where to", and the host never expires a question (PRD D23), so it stays pending until someone answers.

## 7. render's layering

```
packages/render/src/
├── main.ts        Vue entry (Pinia / ElementPlus)
├── App.vue        root: TitleBar + gating on connection state (settings → status → guide/main); subscribes to chat:push and connection:state
├── deps.ts        the replaceable dependency entry (`deps.api` = the whole `apis/*` export, `deps.notify` = the three toast levels; tests stub it instead of using `vi.mock`)
├── views/         setup/index.vue (first-run), guide/index.vue, main/{index,Sidebar,ChatPanel,MessageBubble,NewChatDialog,QuestionPanel}.vue, settings/index.vue, status/index.vue
├── components/    TitleBar.vue, MarkdownContent.vue
├── composables/   useMessageWindow (paged window), useAutoScroll (scroll policy)
├── stores/        ui / workspace / conversation / chat / agentView / assetImages / connection / messageVisibility
└── apis/          base + workspace / conversation / chat / agent / model / config + connection + dialog
```

- **The UI is gated on connection state** (this is a layer in `App.vue`, not something each view decides for itself): the priority is `settings page → first-run setup screen (unset) → status screen while not ready → guide / main`. **The settings page is reachable even while disconnected** — it is the user's only way to rescue themselves (back to local / another address); the main interface (sidebar and conversation list included) only mounts once `ready`, so the app never shows "the window is up but blank and silent". The status screen speaks each state: `connecting` is "connecting to …" (during a retry wait it adds "retry N, in about X seconds"), `error` is that `message` plus "retry" and "go to settings".
- **While disconnected the settings page only gives up half of itself**: "default model / default Agent / API Key / data directory" are all host facts, so they stay empty with a single note (no red banner, no log line — it is not a fault); the "host connection" section reads `connection:get` from main locally and stays fully usable.
- **Data is fetched on `ready`**: `init()` (Agents / models / workspaces, then guide or main depending on whether any workspace exists) runs exactly once per `false → true` transition. A successful "save and reconnect" (connected) returns to the main interface; and if the user happens to be sitting on the settings page, a background auto-retry that succeeds does **not** yank them out of it — data loads as usual, only the view is left alone.
- **apis only forwards**: `invokeService` is converged into methods and errors are normalized into `InvokeHostError`; `subscribeServiceEvent("chat:push", …)` is the single event entry point. `apis/connection.ts` is the same kind of forwarding for the five connection channels (it does not go through `invokeService`), and the `connection:state` push rides the same `on` / `off` pair. `apis/dialog.ts` is the other half of the same job, except it rides main's `dialog:selectDirectory` channel (the native directory picker) — the failure is settled inside that function (a cancel and a picker that will not open both return `null`, but the latter also says one sentence), so the two call sites (sidebar and guide page) no longer keep identical copies with no `try/catch`.
- **`config.update` reports a `ConfigUpdateReport`**: main has two places that **deliberately do not write** (endpoints that no longer exist in the host's config, empty default values), and it reports back what was written, what was not, and why. The settings page uses that to tell the truth — "sent" is not the same as "written".
- **stores are the only data entry**: views never call `invokeService` with a string. `chat` slots state by `byConversation[id]`, so switching conversations only switches the viewpoint and each conversation's streaming state stays independent. `conversation.select()` is **awaitable**: internally it asks the host for a snapshot (`attach` + `snapshot`) and rethrows on failure, so the view can say it out loud — firing it synchronously leaves "selected on the left, blank on the right", which is indistinguishable from "this conversation genuinely has no messages".
- **The sub-agent strip runs parallel to the main conversation**: `agents` is a wholesale replacement of `SubAgentView[]` (the host pushes the whole list on every change) and render does no diffing; selection repair and Tab cycling live in `packages/render/src/stores/agentView.ts` as pure, testable functions.
- **Notices are toasts, not state**: `type: "notice"` pops an element-plus message and never enters `ConversationChatState` — especially not `error`, which is the "this turn failed" banner that `done` clears.

## 8. Where data lives

All **data** on disk belongs to the host (under its `AI_ZEN_DIR`); the only exception is Desktop's own connection-settings file (the `desktop/` line below):

```
<AI_ZEN_DIR>/
├── config.json                  global config (endpoints / models / default model & agent / language)
├── mcp.json                     MCP server list (scopes and OAuth masks included)
├── mcp-oauth/                   OAuth tokens (the host owns them; clients only see masks)
├── agents/                      entry agent definitions (one file each)
├── sub-agents/                  sub-agent definitions
├── tools/ · skills/             capability directories (per-workspace cwd and per data root)
├── ai-zen.db                    SQLite: workspaces / conversations / messages / assets / notices / questions / credentials (with -wal / -shm)
├── assets/                      asset bytes (named by digest; the database only holds relative paths)
├── logs/                        host logs
├── desktop/
│   └── connection.json          connection settings (local / remote + address + credential, 0600; **deleting it returns to the first-run screen**)
└── run/                         written by the host: how to reach it
    ├── host.json                service discovery: the host's pid / address / port / version
    └── token                    credential (read or created by the host, 0600)
```

Desktop reads exactly two things under `<AI_ZEN_DIR>/run/`: `host.json` (**the default** source of the address) and `token` (the credential); in remote mode the address comes from the connection settings and `host.json` is not read at all. It **writes exactly one place**: `<AI_ZEN_DIR>/desktop/connection.json` (connection settings, see the chicken-and-egg note in section 3; deleting that file returns to first-run — not "returns to local", which would read a deletion as a choice).

"Which host" and "which key" live in that file as `{ mode, hostUrl?, hostToken? }`: in `local` both values are `undefined` for the connection layer (= the old path), in `remote` they are what the user typed. The only way to change it is the settings-page section (section 4) — editing the file by hand is no longer needed.

The host retires itself on the "no connections, no turn running" criterion (PRD L4), and retiring deletes no archive — the next launch finds everything again.

## 9. Model resolution has exactly one implementation

The three-level resolution ("conversation override > agent definition > global default") lives in the host (the SDK's `resolveModel`). Desktop neither caches nor recomputes it; it only reads the `ModelState` the host hands over (`wire/states.ts`):

```ts
{ modelId: string; name: string; vision: boolean; source: "conversation" | "agent" | "default" }
```

Each row of `conversation.list` carries `modelId` (that is what the sidebar dropdown shows), while `conversation.get` / `conversation.state` carry the whole `ModelState` (including `source` — after a model switch the UI has to say whether it now follows the agent or is this conversation's own choice). Re-deriving "override + definition + default" on the client would write the precedence rules a second time, and the two copies inevitably diverge at some edge.

## 10. Test shape

Each of the two layers has its own acceptance method, and neither opens a window:

- **`host/`** uses a **fake connection plus counters**: `ContractConnection` is the injected narrow seam (`host/contract.ts`), so tests answer in contract shapes and push events at will, and read back the `ChatStreamEvent` sequence the facade emits — the only acceptance surface for the translation layer. What is under test is the "protocol → render shapes" mapping itself, so the agent and the socket should both be fakes.
- **`connection/`** injects everything into `ConnectionController` (layer factory, settings I/O, log sink): a **fake layer plus counters** pins down the order "write to disk → `dispose` the old layer → build → `start`" (when the write fails, `dispose` must not be called even once), with no real host and no window; the `settings.ts` tests do touch a real disk (a temporary `AI_ZEN_DIR`) and verify `0600`, atomic writes and "never throws on a bad file".

**Size** (`pnpm --filter @ai-zen/desktop-main test` / `… desktop-render test`): `packages/main` 10 files / 131 cases (128 passing + 3 skipped), `packages/render` 9 files / 81 cases.

Both packages set **`isolate: false`** (reusing the module graph in one process, matching sdk / host / client in the `agents` repo and `cli`). The cost is carried by the tests themselves: no `vi.mock` (it registers stand-ins **process-wide** by module specifier, so they bleed into the next file once the module graph is shared); what needs replacing goes through `stubDeps()` / `resetDeps()` in `src/deps.ts`. This is not a matter of taste — it was measured here: with isolation off, the five files that used `vi.mock` bled into each other (green alone, red when two ran together).

## 11. Trade-offs

| Trade-off | Rationale |
|-----------|-----------|
| Splitting the connection from "how to send a request" (`HostConnection` / `packages/main/src/host/contract.ts`) | A client cached in an object dies permanently when the host restarts, and the only symptom is "nothing happens" |
| The rule for folding streaming deltas lives in the library (core's `applyChunk`), not in main | The "how to assemble a turn" rules can exist only once across this repo and the CLI; two copies diverge at edge cases |
| Wholesale event replacement (`message` / `agents`) | Consumers need no merge logic; incremental events spread that complexity across every consumer |
| Unknown notice codes still get text | Version skew is normal; silently dropping them shows the user "nothing happened" |
| Copy lives in the host (`LocalizedText` carries code + params); main only re-renders it per connection language | Version skew is the normal case: "which event says what" follows the contract, and the client only swaps languages |

## 12. Packaging and distribution

The host "shipped with the app" has to really ship with it: install the app and it works, with no Node.js / npm on the customer's machine.

**Tool**: electron-builder 26.18.0 (a devDependency of the repo root `package.json`). The project directory being packaged is `packages/main` — what is packaged is the **app**, and the `package.json` at the asar root is exactly that one.

**Commands** (run from the repo root):

```bash
pnpm run pack   # unpacked directory only: release/linux-unpacked/
pnpm dist       # distributable installer: release/AI-Zen Desktop-<version>.AppImage
```

`pack` collides with pnpm's built-in `pnpm pack` (an npm tarball), so it must be typed as `pnpm run pack`; `pnpm dist` does not collide.

**Metadata in two places, one concern each**:

- `packages/main/package.json`: `version` (the only place electron-builder reads it from), `description`, `type: module`, `main: dist/main.mjs`;
- `packages/main/electron-builder.yml`: `appId` / `productName` / `executableName`, `files`, `directories.output`, `electronDist`, `linux.target`.

`executableName` must be pinned explicitly: on Linux the executable name defaults to the **npm package name** (`@ai-zen/desktop-main` → `@ai-zendesktop-main`), not to `productName`.

**Output**:

```
release/
├── linux-unpacked/
│   ├── ai-zen-desktop             the Electron executable (also the host's Node interpreter)
│   └── resources/app.asar         3.2 MB, containing dist/ only
└── AI-Zen Desktop-0.1.0.AppImage  122 MB
```

The asar holds exactly these five entries; everything else is kept out by `files: [dist/**, !**/*.map]`:

```
/dist/main.mjs      main process entry (ESM)
/dist/host.mjs    the host shipped with the app (self-contained, 1.5 MB)
/dist/preload.js    contextBridge
/dist/static/…      renderer output (index.html + assets/)
/package.json       type: module + main: dist/main.mjs
```

**Why `host.mjs` must sit next to `main.mjs`**: `launch.ts` derives a sibling path from `import.meta.url` (`dirname(main.mjs) + host.mjs`) and knows nothing about being packed into an asar. Sibling-hood holds inside the asar too — the Electron binary run with `ELECTRON_RUN_AS_NODE=1` resolves asar paths as well, so it can read and execute that file, and no `asarUnpack` is needed.

**Why there is no `node_modules` in the output**: `main.mjs` inlines everything but `electron` (core / sdk / shared were removed from `external` in `rolldown.config.mjs`), and `host.mjs` was self-contained from the start. Every dependency of `packages/main` is therefore a **build-time input**, and they all live in `devDependencies`; electron-builder finds no production dependencies, so the asar carries no `node_modules` — and the cross-repo `link:` paths (`../../../agents/…`) never appear in the output at all.

**`type` / `main` in the asar-root `package.json` are not decoration**: those two fields are how Electron recognises an ESM main process (Electron 43 does support one, but the entry has to be resolvable as ESM). electron-builder strips `scripts` / `devDependencies` and keeps both fields as they are.

**How render is loaded**: `app.ts` branches on `NODE_ENV === "development"` — `loadURL("http://localhost:5173")` while developing, otherwise `loadFile(dist/static/index.html)`. After packaging `__dirname` becomes `<…>/app.asar/dist`, and `dist/static` does not move relative to it, so the file:// path is unchanged; asset references stay relative thanks to Vite's `base: "./"`.

**Not done yet**: an application icon (the Electron default is used), `author` / `desktopName` (only required once a deb is built), and the macOS / Windows targets.
