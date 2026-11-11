---
title: 架构设计
description: AI-Zen Desktop 的分层、连接、协议面与状态归属
outline: deep
---

# 架构设计

## 1. 定位：桌面壳 + 常驻服务端

Desktop 是 AI-Zen 的**桌面壳**：窗口、原生对话框、IPC 三项归它；会话执行（Agent 循环、模型请求、工具、存档）全部归**常驻的 `agents-server`**。桌面端因此是瘦客户端 —— 它不跑 Agent、不落任何本地库，只持有一条到服务端的连接，把每个动作翻译成一次协议调用，把服务端推来的事件翻译成 render 认识的形状。

这条边界的收益是具体的：进程崩了不丢会话（服务端还在），服务端重启桌面端能自己长回来（见第 4 节），而「这段会话现在是什么状态」永远只有服务端一个答案。

## 2. 三个包

```
packages/
├── main/     Electron 主进程（rolldown 打包，ESM）
├── render/   Vue 3 渲染进程（Vite；只调服务 + 订阅事件）
└── shared/   类型契约（纯类型，零运行时）
```

依赖方向：`render → shared`、`main → shared + @ai-zen/agents-client`。render 不 import main 的任何东西，两侧共享的只有 `packages/shared/src/types.ts` 里的实体与 IPC DTO。

## 3. main 的分层

```
packages/main/src/
├── main.ts     入口：new DesktopApp().start()
├── app.ts      DesktopApp：窗口 / IPC / 原生对话框 / 事件推给 render
├── config.ts   路径常量 AI_ZEN_DIR（连接配置不在这个文件里）
├── preload.ts  contextBridge 暴露 window.electronAPI
├── connection/ 连本地还是远程（桌面端唯一一处自己的持久化）
│   ├── settings.ts    连接配置读写：`<AI_ZEN_DIR>/desktop/connection.json`（0600 + 原子写；读不到回 `{ mode: "local" }`）
│   └── controller.ts  ConnectionController：当前连着哪一层 / 保存即重连 / 测试连接
└── server/     服务端门面（可直接被 vitest + 真 daemon 验收）
    ├── index.ts            组装根：createServerLayer
    ├── call.ts             一次协议调用（每次取一条活着的连接，不缓存 client）
    ├── services.ts         六个 Service：render 的形状 ↔ 协议调用
    ├── ServicesManager.ts  invokeService 动态分发
    ├── events.ts           服务端事件 → ChatStreamEvent
    ├── launch.ts           拉起随包分发的服务端（Electron 自带的 Node）
    └── notices.ts          通知 code → 中文文案
```

两条硬边界：

- **`server/` 不碰 electron**。`createServerLayer` 只收四样非 electron 的事实（配置根、握手身份、默认工作目录、事件出口），所以它能被用例直接起起来；`app.getPath` / `dialog` / `webContents.send` 只出现在 `packages/main/src/app.ts` 里，以参数或回调递进去。
- **`server/` 不碰数据文件**。会话清单、消息、工作区、配置全部经协议向服务端要。例外只有「连接本身」那两件，且都只读：地址（`run/server.json`，默认路径）与凭证（`run/token`），由 `ServerConnection` 在每次取用时现读；以及 `launch.ts` 把一个**进程**拉起来 —— 它自己不读不写任何数据文件。

「不碰数据文件」说的是**数据**：会话、工作区、Agent 定义、模型配置仍然只由服务端拥有。桌面端自己确实写一个文件 —— `<AI_ZEN_DIR>/desktop/connection.json`（`connection/settings.ts`：`0600`、原子写、内含凭证；读不到 / 坏 JSON / 字段不合法一律回退 `{ mode: "local" }` 且照常启动）。它必须落在本机而不是服务端，理由是**先有鸡先有蛋**：服务端手上有「该连哪儿」的全部业务配置，可要问它，得先知道**连哪台**；把「连哪台」也存到服务端，就等于要求用户先连上服务端才能选服务端。所以这是**唯一**一处本地写，除这一处不新增任何往本地写数据的入口 —— 有意的例外，不是松绑。

## 4. 一条连接（`ServerConnection`）

「连哪台、拿什么进门、断了怎么办」收在 `@ai-zen/agents-client` 的 `agents/packages/client/src/transport/connection.ts` 一份实现里，`packages/main/src/server/index.ts` 只组装它一次：

- **连哪台**默认由服务发现文件回答（`<AI_ZEN_DIR>/run/server.json`）。服务端重启后换端口，文件跟着换，本层不缓存端口也不记 pid。用户在设置页选了**远程**时，地址就来自连接设置里的 `serverUrl`（落盘见 `connection/settings.ts`），这条默认路让位 —— 本层同样不缓存、也不解释它（地址的形状只在客户端包的 `wire/server-url.ts` 里定义一次）。
- **拿什么进门**：凭证默认读 `<AI_ZEN_DIR>/run/token`（服务端启动时读或生成，`0600`），连接设置里的显式 `serverToken` 优先。这两份值桌面端只**透传**，解析、优先级、`unauthorized` 时那句人话全在客户端包的 `resolve-target.ts` 一处。
- **没有服务端时怎么拉起来**：`startServerProcess` 注入成 `server/launch.ts` —— 拉起**随包分发**的那份（`dist/server.mjs`，由 `rolldown.config.mjs` 的 `server` 入口打成一个自包含文件），用 Electron 自带的 Node 跑（`ELECTRON_RUN_AS_NODE=1`）。客户机上可能连 Node.js / npm 都没有，所以这里不走 `npx`（那是 CLI 的做法 —— 它假设机器上有 npm）。

注意「优先用已经在跑的」不是本层的能力，而是 `ensureServer` 的顺序：先读发现文件、`ping` 一次，通了就直接连，拉进程只发生在没有活着的服务端时。给了显式地址则**一次都不拉**：本机拉起来的那一份一定不在那个地址上，`launch.ts` 只留一条只说地址、不含凭证的 log。
- **断了怎么办**：`client()` 每次取用都判 `closed`，关了就地重建；`watch()` 让这条连接开始收事件；`onOpen()` 在换了一条连接时通知上层重挂监听。

这几件事缺一不可，其中断线重连那一条最容易漏：监听挂在**具体那条** `ServerClient` 上，而客户端在断开那一刻会清空监听表。少了重挂，新连接能发请求却一个事件也收不到，症状是界面安静地不动（不报错、不重连、也没有提示）。

`packages/main/src/server/call.ts` 是这一层与连接之间的唯一接缝：`protocolCall(connection)` 每次 `await connection.client()` 再 `call(method, params)`，本身不持有任何状态 —— 没有第二个地方能偷偷存下一份会过期的 client。

### 切本地 / 远程：设置页那一节

「连哪台」不是构造时一锤定音的入参，用户能在**设置页**里改：那一页开头是一节「**服务端连接**」，单选**本地** / **远程**；远程时填**地址**（`ws://` / `wss://` / `http://` / `https://`，支持 path，如 `wss://example.com/ai-zen`）与**凭证**（留空 = 用本机 `<AI_ZEN_DIR>/run/token`）。

- **这一节自带按钮，与页面底部那个「保存」是两件事**。「测试连接」与「保存并重连」属于连接；底部那个「保存」把「默认模型 / 默认 Agent / API Key」写给**服务端**（连的还是同一台）。混成一个按钮的后果很具体：用户只想改默认模型，点一下却连到另一台机器上去了。
- **「测试连接」只探测候选值**：不落盘、不影响当前连接。成功显示服务端自报的 `protocol` / `version` / 耗时；失败显示客户端翻好的人话（`explainUnauthorized` 的措辞，例如引导去核对凭证）。地址合法性只问客户端包的 `parseServerUrl`，桌面端不写第二份校验。
- **「保存并重连」立刻换连接**：`ConnectionController.save()` 的顺序是 **先落盘 → `dispose()` 旧层 → 建新 → `start()`**，不需要重启 App。落盘失败就一个字段都不动连接（否则界面写着远程、实际还连着本地）；进行中的回答会中断，所以保存前有确认框。
- **保存成功后界面重拉一切来自服务端的数据**（会话 / 工作区 / Agent / 模型列表）：换了服务端就是换了一整个世界，上一台的会话缓存留着只会让人点进一次永远失败的拉取。
- **远程模式不在本机拉起服务端**：本机拉起来的一定不在那个地址上；本地模式才是「发现文件 + 按需拉起」。

配置落在 `<AI_ZEN_DIR>/desktop/connection.json`（`0600`、原子写），三条**专用** IPC `connection:get` / `connection:save` / `connection:test` 承载这条路径（不进下面那张 service 表）。

## 5. 协议面

业务面的入口只有一个：`electronAPI.invokeService(service, method, ...args)`，由 `ServicesManager` 查表分发到六个 Service。另有几条**不属这张表**的通道：连接设置 `connection:get` / `save` / `test`（第 4 节）、窗口控制 `window:xxx`、原生目录选择 `dialog:selectDirectory` —— 它们回答的不是服务端的方法，而是主进程自己的事。

| 分发键 | 实现 | 主要动作 |
|--------|------|----------|
| `workspace` | `ServerWorkspaceService` | `workspace.list` / `create`（= `workspace.resolve`，填了名字再补一次 `workspace.rename`）/ `rename` / `remove` |
| `conversation` | `ServerConversationService` | `session.list` / `create` / `attach` + `snapshot` / `rename` / `remove` / `model.set` |
| `agent` | `ServerAgentService` | `agent.list`（只列入口 Agent） |
| `model` | `ServerModelService` | `config.get` 里取 `models` |
| `chat` | `ServerChatService` | `session.send` / `cancel` / `close` / `attach` + `snapshot` |
| `config` | `ServerConfigService` | `config.get` / 窄方法写默认值 / `config.save` |

事件面是契约里的三个联合（`agents/packages/server/src/protocol/sessions.ts`）：`AgentEventName` 8 条（core `Agent.events` 的原名）、`SessionEventName` 6 条（服务端派生或自己决定的事）、`ServerEventName` 1 条（不绑会话的服务端通知）。事件名一律 kebab-case —— `session-turn-end`、`session-title-changed`、`server-notice`。

方法名与事件名都是 `@ai-zen/agents-server/protocol` 里的**字面量联合类型**，不写字面量：改契约时这里编译不过，而不是运行期 500。

## 6. 事件翻译（`packages/main/src/server/events.ts`）

`ChatEventBridge` 订阅其中 12 条，翻成 render 认的 9 种 `ChatStreamEvent`：`start` / `user` / `message` / `done` / `migrated` / `error` / `renamed` / `notice` / `agents`。

「一轮之内该记住什么」不在这里 —— 正文增量往哪条消息上拼、子 Agent 的增量与服务端快照怎么合并、失败算不算终态，归 `@ai-zen/agents-client` 的 `SessionStream`（纯状态机，零 I/O）。桌面端一条连接、多段会话并发，所以这里是**一段会话一台状态机**（`Map<conversationId, SessionStream>`），后台会话继续收事件。

翻译层只做四件事：

1. **`user` 的正文**。协议不推用户消息（`chunk-parsed` 只有模型增量），正文由 `chat.send` 那一侧登记（`noteSend`），派发 `start` 时消费掉。占位 id 用 `${会话}:user:${turnId}`，为的是给 render 一个稳定的 `v-for` key。
2. **占位 assistant 消息的 id**。状态机里那条正在流式的临时消息刻意不带 id（收尾快照会给真 id，编一个假的反而在收尾时打架），所以 key 在这一层编：一轮一个（`${会话}:assistant:${turnId}`），正文与工具调用都落在同一条上，谁先到都一样。
3. **收尾与迁移以服务端快照为准**。`session-turn-end` 只带 `ok` / `error`，补一次 `session.snapshot` 交给 `stream.settle()`，再把合并结果推成 `done`（消息 status 与服务端对历史的清洗都只有快照里有）。`session-id-changed` 要做**别名收敛**（新 id → render 认识的旧 key）并补推 `migrated`，否则一段正在跑的会话会在旧 id 上等一个永远不来的收尾。
4. **`session-question` 自动答「跳过」**。桌面端没有提问 UI，不答就等于让服务端干等到超时（`ASK_TIMEOUT_MS`，5 分钟），用户看到的是「界面像死了」。`choice: null` 与服务端这条退路的兜底取值是同一个答案，所以这不是替用户做决定，只是把超时提前表达出来。

## 7. render 的分层

```
packages/render/src/
├── main.ts        Vue 入口（Pinia / ElementPlus）
├── App.vue        根：TitleBar + Guide/Main/Settings 切换；订阅 chat:push
├── views/         guide/index.vue、main/{index,Sidebar,ChatPanel,MessageBubble,NewChatDialog}.vue、settings/index.vue
├── components/    TitleBar.vue、MarkdownContent.vue
├── composables/   useMessageWindow（分页窗口）、useAutoScroll（滚动策略）
├── stores/        ui / workspace / conversation / chat / agentView / connection
└── apis/          base + workspace / conversation / chat / agent / model / config + connection
```

- **apis 只做转发**：`invokeService` 收敛成方法，错误统一成 `InvokeServerError`；`subscribeServiceEvent("chat:push", …)` 是唯一的事件入口。`apis/connection.ts` 是三条连接通道的同一套转发（它不经过 `invokeService`）。
- **store 是唯一数据入口**：视图不调 `invokeService` 字符串。`chat` 按 `byConversation[id]` 分槽，切换会话只换视角，各会话的流式状态互不干扰。
- **子 Agent 栏目与主对话并行**：`agents` 是 `SubAgentView[]` 的整份替换（服务端一变化就推全量），render 不做 diff；选中态修正与 Tab 循环抽在 `packages/render/src/stores/agentView.ts`，纯函数、可测。
- **通知是 toast，不是状态**：`type: "notice"` 直接弹 element-plus，不进 `ConversationChatState` —— 尤其不碰 `error`（那是「本轮失败」的错误条，`done` 会把它清空）。

## 8. 数据归属

盘上的**数据**都归服务端（它的 `AI_ZEN_DIR`）；唯一的例外是桌面端自己那个连接配置文件（下面 `desktop/` 那一行）：

```
<AI_ZEN_DIR>/
├── config.json                  全局配置（endpoints / models / 默认模型与 Agent）
├── agents/                      入口 Agent 定义
├── sub-agents/                  子 Agent 定义
├── workspaces/<workspaceId>/    workspace.json + sessions/<id>.json（含 .meta.json 清单）
├── desktop/                     桌面端自己写（就这一个文件）
│   └── connection.json          连接设置（本地 / 远程 + 地址 + 凭证，0600；删掉即回到「本地」）
└── run/                         服务端自己写：怎么找到它
    ├── server.json              服务发现：常驻服务端此刻在哪个端口
    └── token                    凭证（服务端启动时读或生成，0600）
```

桌面端在盘上只读 `<AI_ZEN_DIR>/run/` 下的两件事：`server.json`（**默认**的地址来源）与 `token`（凭证）；远程模式下地址来自连接设置，连 `server.json` 都不读。它**只写一处**：`<AI_ZEN_DIR>/desktop/connection.json`（连接设置，理由见第 3 节的「先有鸡先有蛋」；删掉这个文件就回到默认的「本地」）。会话存活由服务端按空闲宽限期（`DEFAULT_SESSION_IDLE_TIMEOUT_MS`）回收，`session.close` 是「我不看这段了」的当场释放，两者都不删存档。

「连哪台」与「拿什么进门」就存在这个文件里（`{ mode, serverUrl?, serverToken? }`）：`local` 时两个值对连接层一律是 `undefined`（= 老路），`remote` 时才是用户填的那两个。改它的入口只有设置页那一节（第 4 节），不需要手改文件。

## 9. 模型解析只有一份实现

「会话级覆盖 > Agent 定义 > 全局默认」的三级解析在服务端（SDK 的 `resolveModel`）。桌面端既不缓存也不重算，只读两个字段：

- `SessionListEntry.modelId` —— 这段会话**有没有**自己的覆盖；
- `SessionListEntry.effectiveModelId` —— 它**实际在用**哪个模型（解析不出来时省略）。

侧栏的模型下拉框读后者；客户端按「覆盖 + 定义 + 默认」再推一遍就是把优先级规则写第二遍，而两份迟早在某个边界上分叉。

## 10. 测试形态

`server/` 那一层可以被 vitest 直接验收：`packages/main/src/server/test-harness.ts` 起一个**真 daemon**（真端口、真帧、真 `SessionManager`）+ 一个**假 Agent**（用例自己决定什么时候推哪一片增量）。验的是协议映射本身，所以 Agent 的流式循环该是假件，socket 与发现文件必须是真的。用例读的是门面推出去的 `ChatStreamEvent` 序列 —— 翻译层唯一的验收口径就是这条通道。

`connection/` 那一层走另一条路：`ConnectionController` 的依赖全部注入（建层工厂、配置读写、日志出口），用例拿**假层 + 计数器**就能把「先落盘 → dispose → 建新 → start」这条顺序咬死（落盘失败时 `dispose` 一次都不许被调），不必起真 daemon、也不必开窗口；`settings.ts` 的用例碰真磁盘（临时 `AI_ZEN_DIR`），验的是 `0600`、原子写与「读不炸」。当前两侧的规模：`packages/main` 9 个用例文件 / 111 条用例，`packages/render` 3 个文件 / 25 条（含 connection store 的「测试不刷数据、保存才刷」）。

## 11. 取舍

| 取舍 | 理由 |
|------|------|
| 连接与「怎么发请求」分成两个东西（`ServerConnection` / `packages/main/src/server/call.ts`） | 缓存在对象里的 client 会在服务端重启后永久失效，而症状只是「没反应」 |
| 状态机在包里，不在 main | 同一套「一轮之内怎么拼」的规则在本仓与 CLI 之间只能有一份，两份的边界情形迟早分叉 |
| 事件整份替换（`message` / `agents`） | 消费方不需要任何合并逻辑；增量事件把复杂度摊给每一个消费方 |
| 未知通知码也要出文案 | 版本偏斜是常态，静默丢弃让用户看到「什么都没发生」 |
| 词典在 main 而不是 render | 文案与「哪条事件变成哪个 code」是同一件事，而事件翻译已经全在 main |

## 12. 打包与分发

「随包分发的服务端」得要真的随包走：应用装好就能用，客户机上不需要 Node.js / npm。

**工具**：electron-builder 26.18.0（仓库根 `package.json` 的 devDependency）。构建的项目目录是 `packages/main` —— 打包的对象是**应用**，而 asar 根部那份 `package.json` 就是它。

**命令**（在仓库根执行）：

```bash
pnpm run pack   # 只出 unpacked 目录：release/linux-unpacked/
pnpm dist       # 出可分发安装包：release/AI-Zen Desktop-<version>.AppImage
```

`pack` 与 pnpm 自带的 `pnpm pack`（打 npm tarball）撞名，所以必须写成 `pnpm run pack`；`pnpm dist` 不撞。

**元数据分两处，各管一件事**：

- `packages/main/package.json`：`version`（electron-builder 只认这里）、`description`、`type: module`、`main: dist/main.mjs`；
- `packages/main/electron-builder.yml`：`appId` / `productName` / `executableName`、`files`、`directories.output`、`electronDist`、`linux.target`。

`executableName` 必须显式写死：Linux 的可执行文件名默认取的是 **npm 包名**（`@ai-zen/desktop-main` → `@ai-zendesktop-main`），不是 `productName`。

**产物**：

```
release/
├── linux-unpacked/
│   ├── ai-zen-desktop             Electron 可执行（同时也是服务端的 Node 解释器）
│   └── resources/app.asar         3.2 MB，只有 dist/
└── AI-Zen Desktop-0.1.0.AppImage  122 MB
```

asar 里就这五条，其余被 `files: [dist/**, !**/*.map]` 挡在门外：

```
/dist/main.mjs      主进程入口（ESM）
/dist/server.mjs    随包分发的服务端（自包含，1.5 MB）
/dist/preload.js    contextBridge
/dist/static/…      render 产物（index.html + assets/）
/package.json       type: module + main: dist/main.mjs
```

**`server.mjs` 为什么必须在 `main.mjs` 同目录**：`launch.ts` 用 `import.meta.url` 推同级路径（`dirname(main.mjs) + server.mjs`），它并不知道自己被打进了 asar。同目录这条约束在 asar 里同样成立 —— `ELECTRON_RUN_AS_NODE=1` 的 Electron 二进制也认 asar 路径，读得到、跑得起来，所以不需要 `asarUnpack`。

**产物里为什么没有 `node_modules`**：`main.mjs` 除 `electron` 外全内联（`rolldown.config.mjs` 里 core / sdk / shared 都从 `external` 拿掉了），`server.mjs` 本来就是全内联。于是 `packages/main` 的依赖全是**构建期输入**，全在 `devDependencies`；electron-builder 收不到任何生产依赖，asar 里也就没有 `node_modules` —— 那几条跨仓的 `link:` 路径（`../../../agents/…`）因此完全不出现在产物里。

**asar 根 `package.json` 的 `type` / `main` 不是装饰**：这两个字段是 Electron 认出 ESM 主进程的依据（Electron 43 支持 ESM 主进程，但入口得能被解析成 ESM）。electron-builder 会剥掉 `scripts` / `devDependencies`，这两个字段原样留下。

**render 怎么被加载**：`app.ts` 按 `NODE_ENV === "development"` 二选一 —— 开发期 `loadURL("http://localhost:5173")`，否则 `loadFile(dist/static/index.html)`。打包后 `__dirname` 变成 `<…>/app.asar/dist`，`dist/static` 相对它没有位移，file:// 这条路照旧；资源引用靠 Vite 的 `base: "./"` 保持相对。

**目前没有做的**：应用图标（用的 Electron 默认图标）、`author` / `desktopName`（只在出 deb 前才必须）、macOS 与 Windows 目标。
