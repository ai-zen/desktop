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
├── main.ts     entry: new DesktopApp().start() (with its own .catch: a stray startup failure leaves one log line)
├── app.ts      DesktopApp: window / IPC / native dialogs / events pushed to render
├── config.ts   the path constant AI_ZEN_DIR (the connection settings are not in this file)
├── preload.ts  contextBridge exposing window.electronAPI
├── connection/ local or remote (the only persistence Desktop owns)
│   ├── settings.ts    **only binds the path** (`<AI_ZEN_DIR>/desktop/connection.json`); read/write/validate/wording live in `connection-settings.ts` in `@ai-zen/agents-client` (shared with the CLI)
│   └── controller.ts  ConnectionController: which layer is live / saving means reconnecting / testing a connection / three states + bounded retries
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
- **`server/` never touches data files.** Conversation lists, messages, workspaces and config all come from the server over the protocol. The only exceptions are the two facts the connection itself needs, both read-only: the address (`run/server.json`, the default path) and the credential (`run/token`), read fresh on every use by `ServerConnection`; plus `launch.ts` starting a **process**, which reads and writes no data files itself.

"Never touches data files" is about **data**: conversations, workspaces, Agent definitions and model config are still owned solely by the server. Desktop does write exactly one file of its own — `<AI_ZEN_DIR>/desktop/connection.json` (`connection/settings.ts`: `0600`, atomic write, credential inside; unreadable / broken JSON / invalid fields all fall back to `{ mode: "local" }` and the app still starts). It has to live on this machine rather than on the server because of the **chicken and egg**: the server holds all the business config about where to connect, but asking it requires knowing **which server** first; storing "which server" on the server would mean a user must connect to a server before choosing a server. So this is the **only** local write, and no other entry point for writing data locally gets added — a deliberate exception, not a loosening.

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
- **The window does not depend on the connection**: when a remote server is unreachable the window still appears — "cannot connect" then becomes **something inside the window** (the `connecting` / `error` status screen with its "retry"), not "the app failed to start".
- **`connection.start()` is not awaited**: it is one attempt running in the background; a failure only writes one log line and is handed to the state machine (the retries in section 4). `main.ts` adds a `.catch` of its own too — any stray failure on the startup path becomes one log line rather than "double-click does nothing".

## 4. One connection (`ServerConnection`)

"Which server, which key, and what if the connection dies" lives in exactly one implementation: `agents/packages/client/src/transport/connection.ts` in `@ai-zen/agents-client`. `packages/main/src/server/index.ts` assembles it once:

- **Which server** is answered by the discovery file (`<AI_ZEN_DIR>/run/server.json`) **by default**. A restarted server switches ports and rewrites the file; this layer caches no port and remembers no pid. When the user picks **remote** in the settings page, the address comes from `serverUrl` in the connection settings (persisted by `connection/settings.ts`) instead, and this default path steps aside — this layer still caches nothing and interprets nothing (the shape of an address is defined once, in the client package's `wire/server-url.ts`).
- **Which key gets you in**: the credential defaults to `<AI_ZEN_DIR>/run/token` (read or created by the server at startup, `0600`); an explicit `serverToken` from the connection settings wins. Desktop only **passes both values through** — parsing, precedence and the plain sentence printed on `unauthorized` all live in one place, `resolve-target.ts` in the client package.
- **Launching one when none is running**: `startServerProcess` is injected as `server/launch.ts`, which starts the copy **shipped with the app** (`dist/server.mjs`, built as a self-contained file by the `server` entry in `rolldown.config.mjs`) on Electron's bundled Node (`ELECTRON_RUN_AS_NODE=1`). A customer machine may have neither Node.js nor npm, so this path cannot use `npx` — that is the CLI's route, and it assumes npm is there.

Note that "prefer one that is already running" is not this layer's doing: it is `ensureServer`'s order — read the discovery file, `ping` once, use it if it answers. Spawning only happens when no live server exists. With an explicit address it never happens at all: whatever would be started on this machine is not listening on that address, so `launch.ts` only leaves one log line carrying the address and no credential.
- **What if it dies**: `client()` checks `closed` on every use and rebuilds in place when shut; `watch()` makes that connection start receiving events; `onOpen()` tells the layer above to re-attach its listeners when the connection was replaced.

All of these matter, and re-attaching after a reconnect is the easiest to miss: listeners are attached to one **specific** `ServerClient`, and the client clears its listener table the moment the socket drops. Without re-attaching, the new connection can send requests but receives no events at all — the UI just sits there silently (no error, no reconnect, no notice).

`packages/main/src/server/call.ts` is the only seam between this layer and the connection: `protocolCall(connection)` awaits `connection.client()` and then `call(method, params)` on every invocation. It holds no state, so there is no second place that could stash a stale client.

### Local / remote: the section in the settings page

"Which server" is not an input fixed at construction time; the user can change it in the **settings page**. That page opens with a "**Server connection**" section: a radio for **local** / **remote**; when remote, an **address** (`ws://` / `wss://` / `http://` / `https://`, paths supported, e.g. `wss://example.com/ai-zen`) and a **credential** (left empty = use this machine's `<AI_ZEN_DIR>/run/token`).

- **That section carries its own buttons, separate from the "Save" at the bottom of the page.** "Test connection" and "Save and reconnect" belong to the connection; the bottom "Save" writes "default model / default Agent / API Key" to the **server** (the one already connected). Merging them has a very concrete consequence: a user who only wanted to change the default model clicks once and ends up on another machine.
- **"Test connection" only probes the candidate values**: nothing is written to disk, the current connection is untouched. Success shows the server's self-reported `protocol` / `version` / elapsed time; failure shows the plain sentence the client package already renders (`explainUnauthorized`'s wording, e.g. pointing at the credential). Address validity is asked of `parseServerUrl` only — Desktop writes no second validation.
- **"Save and reconnect" swaps the connection immediately**: `ConnectionController.save()` runs **write to disk → `dispose()` the old layer → build the new one → `start()`**, with no app restart. A failed write touches no part of the connection (otherwise the UI says remote while the app is still on local); answers in flight are interrupted, hence the confirmation dialog before saving.
- **After a successful save the UI returns to the main interface and refetches everything that comes from the server** (conversations / workspaces / Agents / model list): a different server is a different world, and keeping the previous machine's conversation cache only makes the user click into a fetch that can never succeed.
- **Remote never starts a server on this machine**: whatever would be started here is not listening on that address. Local is the mode that does "discovery file + start on demand".

The config lives in `<AI_ZEN_DIR>/desktop/connection.json` (`0600`, atomic write), carried by five **dedicated** IPC channels `connection:get` / `connection:save` / `connection:test` / `connection:state` / `connection:reconnect` (they do not go into the service table below).

### Never configured: `unset` (first-run screen)

"Never configured" is not a kind of "cannot connect" — it is a decision only the **user** can make. It needs its own state: falling back to `{ mode: "local" }` squashes "first launch" into "the user picked local", so the app starts a local server on its own and the onboarding screen can never appear (the same shape of bug as "two booleans cannot hold three credential sources" in `resolve-target.ts`). The first arm of `ConnectionState` is therefore `{ status: "unset" }`: `start()` builds **no layer** at all in that case, and render puts up `views/setup` (this machine / remote + address & token + test connection).

### When it cannot connect: four states + bounded retries

The window comes up first (section 3), so "what state is this connection in right now" has to be a value that can be **asked for and pushed** — otherwise the `invokeService` calls render makes while mounting hit a connection that is not up yet and the screen is blank with no hint. The states are maintained in exactly one place, `ConnectionController`, and render only gates the UI on them:

- `connecting` — **covers** both "first attempt in flight" and "waiting for a retry". The two are told apart by `attempt` (`0` = the first attempt) and `nextRetryInMs` (how long until the next one);
- `ready` — connected, carrying the server's **self-reported** `protocol` / `version` (from the handshake reply; when unavailable they are `0` / `""` — connected but unaware of which version it is, which is more honest than inventing a number);
- `error` — the terminal state **after the retries failed too** (not "this attempt failed"), carrying one plain sentence in `message`.

Every state except `unset` carries a `label`: `"本机服务端"` (the local server) for local, the address for remote. It is produced by main (render may neither compose an address nor guess the mode) and it **never contains the credential** — userinfo in an address is stripped first.

**Bounded retries**: after the first failure there are at most **3** more tries, backing off **1s / 2s / 5s**; if all three fail → `error`, and from then on only the user's manual "retry" (`connection:reconnect`) is left. Automatic retries run one batch, not forever: an unreachable remote should not make the main process knock every 5 seconds for the rest of the day, and "quietly retrying forever" looks exactly like "stuck" in the UI.

**A retry rebuilds the whole layer** (`dispose()` → `build()` → `start()`), it does not call `start()` again: `ChatEventBridge.start()` overwrites `unsubscribeOpen` without unsubscribing first, so calling `start()` twice on the same bridge loses the previous `onOpen` subscription — and that subscription is exactly what re-attaches listeners when the connection was replaced. Lose it and no event ever arrives again; the UI just sits there silently. Every attempt therefore gets a new bridge and a new connection, owing nothing to the previous one.

The four exits of one attempt (connected → `ready` / schedule the next retry / enter `error` / superseded by a new configuration, so state must not be touched at all) all live in that one object; `save()` and `reconnect()` only bump the generation (clearing the pending timer and making the in-flight attempt stale).

## 5. Protocol surface

The business surface has exactly one entry point: `electronAPI.invokeService(service, method, ...args)`, which `ServicesManager` looks up and dispatches to one of six Services. A few channels deliberately stay **off** that table: the connection settings and connection state `connection:get` / `save` / `test` / `state` / `reconnect` (section 4), window controls `window:xxx`, and the native directory picker `dialog:selectDirectory` — they answer questions that belong to the main process itself, not methods of the server.

The last two of those five are **the query** and **the manual retry**: `connection:state` asks "what state is it in right now", `connection:reconnect` lets the user start another round themselves (it clears the pending timer, resets `attempt` to zero and returns the moment it enters `connecting`; the whole round runs in the background). A **push** channel shares the same name `connection:state` (main → render), so "ask once" and "listen for changes" are one name to the caller. Neither of them goes into the service table either — those six keys are the server's method surface.

**The initial state is not pushed**: `connecting / attempt 0` is word-for-word what `state()` already reports before `start()` runs, so pushing it would be pure noise. That is why render must **query once first, then listen** when it mounts — listening alone misses the change that happened before the mount, querying alone never learns about the ones after it. `preload` exposes these as `electronAPI.connection = { get, save, test, state, reconnect }`.

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
├── App.vue        root: TitleBar + gating on connection state (settings → status → guide/main); subscribes to chat:push and connection:state
├── views/         setup/index.vue (first-run), guide/index.vue, main/{index,Sidebar,ChatPanel,MessageBubble,NewChatDialog}.vue, settings/index.vue, status/index.vue
├── components/    TitleBar.vue, MarkdownContent.vue
├── composables/   useMessageWindow (paged window), useAutoScroll (scroll policy)
├── stores/        ui / workspace / conversation / chat / agentView / connection
└── apis/          base + workspace / conversation / chat / agent / model / config + connection
```

- **The UI is gated on connection state** (this is a layer in `App.vue`, not something each view decides for itself): the priority is `settings page → first-run setup screen (unset) → status screen while not ready → guide / main`. **The settings page is reachable even while disconnected** — it is the user's only way to rescue themselves (back to local / another address); the main interface (sidebar and conversation list included) only mounts once `ready`, so the app never shows "the window is up but blank and silent". The status screen speaks each state: `connecting` is "connecting to …" (during a retry wait it adds "retry N, in about X seconds"), `error` is that `message` plus "retry" and "go to settings".
- **While disconnected the settings page only gives up half of itself**: "default model / default Agent / API Key / data directory" are all server facts, so they stay empty with a single note (no red banner, no log line — it is not a fault); the "server connection" section reads `connection:get` from main locally and stays fully usable.
- **Data is fetched on `ready`**: `init()` (Agents / models / workspaces, then guide or main depending on whether any workspace exists) runs exactly once per `false → true` transition. A successful "save and reconnect" (connected) returns to the main interface; and if the user happens to be sitting on the settings page, a background auto-retry that succeeds does **not** yank them out of it — data loads as usual, only the view is left alone.
- **apis only forwards**: `invokeService` is converged into methods and errors are normalized into `InvokeServerError`; `subscribeServiceEvent("chat:push", …)` is the single event entry point. `apis/connection.ts` is the same kind of forwarding for the five connection channels (it does not go through `invokeService`), and the `connection:state` push rides the same `on` / `off` pair.
- **stores are the only data entry**: views never call `invokeService` with a string. `chat` slots state by `byConversation[id]`, so switching conversations only switches the viewpoint and each conversation's streaming state stays independent.
- **The sub-agent strip runs parallel to the main conversation**: `agents` is a wholesale replacement of `SubAgentView[]` (the server pushes the whole list on every change) and render does no diffing; selection repair and Tab cycling live in `packages/render/src/stores/agentView.ts` as pure, testable functions.
- **Notices are toasts, not state**: `type: "notice"` pops an element-plus message and never enters `ConversationChatState` — especially not `error`, which is the "this turn failed" banner that `done` clears.

## 8. Where data lives

Everything on disk is **data**, and data belongs to the server (its `AI_ZEN_DIR`); the only exception is Desktop's own connection-settings file (the `desktop/` line below):

```
<AI_ZEN_DIR>/
├── config.json                  global config (endpoints / models / default model & Agent)
├── agents/                      entry Agent definitions
├── sub-agents/                  sub-agent definitions
├── workspaces/<workspaceId>/    workspace.json + sessions/<id>.json (with .meta.json listing)
├── desktop/                     written by Desktop itself (this one file only)
│   └── connection.json          connection settings (local / remote + address + credential, 0600; **deleting it returns to the first-run screen**)
└── run/                         written by the server: how to reach it
    ├── server.json              service discovery: which port the resident server is on
    └── token                    credential (read or created by the server, 0600)
```

Desktop reads two things from disk here: `server.json` (the **default** source of the address) and `token` (the credential), both under `<AI_ZEN_DIR>/run/`; in remote mode the address comes from the connection settings and `server.json` is not read at all. It **writes exactly one place**: `<AI_ZEN_DIR>/desktop/connection.json` (connection settings, see the chicken-and-egg note in section 3; deleting that file returns to the default "local"). Session lifetime is reclaimed by the server on an idle grace period (`DEFAULT_SESSION_IDLE_TIMEOUT_MS`); `session.close` releases a session immediately because the user stopped looking at it. Neither deletes the archive.

"Which server" and "which key" live in that file as `{ mode, serverUrl?, serverToken? }`: in `local` both values are `undefined` for the connection layer (= the old path), in `remote` they are what the user typed. The only way to change it is the settings-page section (section 4) — editing the file by hand is no longer needed.

## 9. Model resolution has exactly one implementation

The three-level resolution ("conversation override > Agent definition > global default") lives on the server (SDK's `resolveModel`). Desktop neither caches nor recomputes it; it reads two fields:

- `SessionListEntry.modelId` — whether this conversation **has** its own override;
- `SessionListEntry.effectiveModelId` — which model it is **actually using** (omitted when it cannot be resolved).

The sidebar's model dropdown reads the latter; recomputing "override + definition + default" on the client would be a second copy of the precedence rule, and the two copies eventually diverge at some edge.

## 10. Test shape

The `server/` layer is verified directly by vitest: `packages/main/src/server/test-harness.ts` starts a **real daemon** (real port, real frames, real `SessionManager`) plus a **fake Agent** (the test decides when which delta is pushed). What is under test is the protocol mapping itself, so the Agent's streaming loop should be fake while the socket and discovery file must be real. Tests assert on the `ChatStreamEvent` sequence the facade pushes — that channel is the only acceptance surface the translation layer has.

The `connection/` layer takes another road: every dependency of `ConnectionController` is injected (layer factory, settings I/O, log sink), so a test can pin the order "write to disk → dispose → build → start" with a **fake layer plus counters** (when the write fails, `dispose` must not be called even once) without starting a real daemon or opening a window; the `settings.ts` tests do touch a real disk (a temporary `AI_ZEN_DIR`) and verify `0600`, atomic writes and "never throws on a bad file". Current size: `packages/main` 9 test files / 128 cases (including the state machine's push sequence across the three states, the backoff retries and `reconnect` discarding a pending timer), `packages/render` 3 files / 38 cases (including the connection store's "testing refetches nothing, saving refetches everything" and "query once, then subscribe").

## 11. Trade-offs

| Trade-off | Rationale |
|-----------|-----------|
| Splitting the connection from "how to send a request" (`ServerConnection` / `packages/main/src/server/call.ts`) | A client cached in an object dies permanently when the server restarts, and the only symptom is "nothing happens" |
| The state machine lives in the package, not in main | The "how to assemble a turn" rules can exist only once across this repo and the CLI; two copies diverge at edge cases |
| Wholesale event replacement (`message` / `agents`) | Consumers need no merge logic; incremental events spread that complexity across every consumer |
| Unknown notice codes still get text | Version skew is normal; silently dropping them shows the user "nothing happened" |
| The dictionary lives in main, not render | Text and "which event becomes which code" are the same concern, and all event translation already sits in main |

## 12. Packaging and distribution

The server "shipped with the app" has to really ship with it: install the app and it works, with no Node.js / npm on the customer's machine.

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
│   ├── ai-zen-desktop             the Electron executable (also the server's Node interpreter)
│   └── resources/app.asar         3.2 MB, containing dist/ only
└── AI-Zen Desktop-0.1.0.AppImage  122 MB
```

The asar holds exactly these five entries; everything else is kept out by `files: [dist/**, !**/*.map]`:

```
/dist/main.mjs      main process entry (ESM)
/dist/server.mjs    the server shipped with the app (self-contained, 1.5 MB)
/dist/preload.js    contextBridge
/dist/static/…      renderer output (index.html + assets/)
/package.json       type: module + main: dist/main.mjs
```

**Why `server.mjs` must sit next to `main.mjs`**: `launch.ts` derives a sibling path from `import.meta.url` (`dirname(main.mjs) + server.mjs`) and knows nothing about being packed into an asar. Sibling-hood holds inside the asar too — the Electron binary run with `ELECTRON_RUN_AS_NODE=1` resolves asar paths as well, so it can read and execute that file, and no `asarUnpack` is needed.

**Why there is no `node_modules` in the output**: `main.mjs` inlines everything but `electron` (core / sdk / shared were removed from `external` in `rolldown.config.mjs`), and `server.mjs` was self-contained from the start. Every dependency of `packages/main` is therefore a **build-time input**, and they all live in `devDependencies`; electron-builder finds no production dependencies, so the asar carries no `node_modules` — and the cross-repo `link:` paths (`../../../agents/…`) never appear in the output at all.

**`type` / `main` in the asar-root `package.json` are not decoration**: those two fields are how Electron recognises an ESM main process (Electron 43 does support one, but the entry has to be resolvable as ESM). electron-builder strips `scripts` / `devDependencies` and keeps both fields as they are.

**How render is loaded**: `app.ts` branches on `NODE_ENV === "development"` — `loadURL("http://localhost:5173")` while developing, otherwise `loadFile(dist/static/index.html)`. After packaging `__dirname` becomes `<…>/app.asar/dist`, and `dist/static` does not move relative to it, so the file:// path is unchanged; asset references stay relative thanks to Vite's `base: "./"`.

**Not done yet**: an application icon (the Electron default is used), `author` / `desktopName` (only required once a deb is built), and the macOS / Windows targets.
