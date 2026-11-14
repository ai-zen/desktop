---
title: 架构设计
description: AI-Zen Desktop 的分层、连接、协议面与状态归属
outline: deep
---

# 架构设计

## 1. 定位：桌面壳 + 常驻宿主

Desktop 是 AI-Zen 的**桌面壳**：窗口、原生对话框、IPC 三项归它；会话执行（Agent 循环、模型请求、工具、存档）全部归**常驻的 `agents-host`**。桌面端因此是瘦客户端 —— 它不跑 Agent、不落任何本地库，只持有一条到宿主的连接，把每个动作翻译成一次协议调用，把宿主推来的事件翻译成 render 认识的形状。

这条边界的收益是具体的：进程崩了不丢会话（宿主还在），宿主重启桌面端能自己长回来（见第 4 节），而「这段会话现在是什么状态」永远只有宿主一个答案。

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
├── main.ts     入口：new DesktopApp().start()（自带 .catch：启动路径上漏网的失败只留一行日志）
├── app.ts      DesktopApp：窗口 / IPC / 原生对话框 / 事件推给 render
├── config.ts   路径常量 AI_ZEN_DIR（连接配置不在这个文件里）
├── preload.ts  contextBridge 暴露 window.electronAPI
├── connection/ 连本地还是远程（桌面端唯一一处自己的持久化）
│   ├── settings.ts    连接配置的**落点绑定**（读写/校验/措辞全在 `@ai-zen/agents-client` 的 `connection-settings.ts`；本文件只把路径钉成 `<AI_ZEN_DIR>/desktop/connection.json`）
│   └── controller.ts  ConnectionController：当前连着哪一层 / 保存即重连 / 测试连接 / 四态 + 有限重试
└── host/     宿主门面（可直接被 vitest + 真宿主验收）
    ├── index.ts            组装根：createHostLayer（六个 Service + 事件翻译器 + 那一条连接）
    ├── contract.ts         与客户端库之间的**窄接缝**（只声明这一层用到的那几件事，不拿 `Client` 类当参数类型）
    ├── services.ts         六个 Service：render 的形状 ↔ 契约调用
    ├── ServicesManager.ts  invokeService 动态分发
    ├── events.ts           宿主事件 → ChatStreamEvent
    ├── stream.ts           流式增量 → 一条 core 的 `AgentNS.Message`（只拼，不判断）
    ├── attachments.ts      附件编排：一批字节 → `asset.begin` / 二进制分片 / `asset.end` → assetId
    ├── problem.ts          一次失败 / 一句提示 → `LocalizedText` / `ProblemFact`
    └── launch.ts           拉起随包分发的宿主（Electron 自带的 Node）
```

两条硬边界：

- **`host/` 不碰 electron**。`createHostLayer` 只收四样非 electron 的事实（配置根、握手身份、默认工作目录、事件出口），所以它能被用例直接起起来；`app.getPath` / `dialog` / `webContents.send` 只出现在 `packages/main/src/app.ts` 里，以参数或回调递进去。
- **`host/` 不碰数据文件**。会话清单、消息、工作区、配置全部经协议向宿主要。例外只有「连接本身」那两件，且都只读：地址（`run/host.json`，默认路径）与凭证（`run/token`），由 `HostConnection` 在每次取用时现读；以及 `launch.ts` 把一个**进程**拉起来 —— 它自己不读不写任何数据文件。

「不碰数据文件」说的是**数据**：会话、工作区、Agent 定义、模型配置仍然只由宿主拥有。桌面端自己确实写一个文件 —— `<AI_ZEN_DIR>/desktop/connection.json`（`connection/settings.ts` 只钉路径，规则在包里：`0600`、原子写、内含凭证；读不到 / 坏 JSON / 字段不合法一律返回 `null` = **没配过**）。它必须落在本机而不是宿主，理由是**先有鸡先有蛋**：宿主手上有「该连哪儿」的全部业务配置，可要问它，得先知道**连哪台**；把「连哪台」也存到宿主，就等于要求用户先连上宿主才能选宿主。所以这是**唯一**一处本地写，除这一处不新增任何往本地写数据的入口 —— 有意的例外，不是松绑。

### 启动顺序：窗口先出来，连接在后面

```
await app.whenReady()
nativeTheme / Menu
registerIpc()                 ← 早于窗口：render 一挂载就会 invoke
createMainWindow()            ← 窗口先出来
void connection.start()       ← 后台连，**不 await**
```

这个顺序是本文件里唯一必须按字面读的东西，三条理由各挡住一种失败：

- **IPC 必须早于窗口**：render 一挂载就会 `invokeService`，`registerIpc()` 晚一步，界面上就什么都没有。
- **窗口不依赖连接**：远程宿主不可达时，窗口照样出现 —— 「连不上」于是是**窗口里的一件事**（状态屏上的 `connecting` / `error` 加「重试」），而不是「应用没起来」。
- **`connection.start()` 不 await**：它是后台的一轮尝试，失败只记一行日志 + 交给状态机（第 4 节的重试），启动路径不等它。`main.ts` 的入口另带 `.catch` —— 启动路径上任何漏网的失败只变成一行日志，而不是「双击没反应」。

## 4. 一条连接（`HostConnection`）

「连哪台、拿什么进门、断了怎么办」收在 `@ai-zen/agents-client`（`agents/packages/client/src/connection.ts`，私有、不发版、构建时内联）一份实现里，`packages/main/src/host/index.ts` 只组装它一次：

- **连哪台**默认由服务发现文件回答（`<AI_ZEN_DIR>/run/host.json`）。宿主重启后换端口，文件跟着换，本层不缓存端口也不记 pid。用户在设置页选了**远程**时，地址就来自连接设置里的 `hostUrl`（落盘见 `connection/settings.ts`），这条默认路让位 —— 本层同样不缓存、也不解释它（地址的形状只在客户端包的 `address.ts` 里定义一次）。
- **拿什么进门**：凭证默认读 `<AI_ZEN_DIR>/run/token`（宿主启动时读或生成，`0600`），连接设置里的显式 `hostToken` 优先。这两份值桌面端只**透传**，解析、优先级、`unauthorized` 时那句人话全在客户端包的一处（`connection.ts` 与 `errors.ts`）。
- **没有宿主时怎么拉起来**：`startHostProcess` 注入成 `host/launch.ts` —— 拉起**随包分发**的那份（`dist/host.mjs`，由 `rolldown.config.mjs` 的 `host` 入口打成一个自包含文件），用 Electron 自带的 Node 跑（`ELECTRON_RUN_AS_NODE=1`）。客户机上可能连 Node.js / npm 都没有，所以这里不走 `npx`（那是 CLI 的做法 —— 它假设机器上有 npm）。

注意「优先用已经在跑的」不是本层的能力，而是 `ensureHost` 的顺序：先读发现文件、`ping` 一次，通了就直接连，拉进程只发生在没有活着的宿主时。给了显式地址则**一次都不拉**：本机拉起来的那一份一定不在那个地址上，`launch.ts` 只留一条只说地址、不含凭证的 log。
- **断了怎么办**：`client()` 每次取用都判 `closed`，关了就地重建；`watch()` 让这条连接开始收事件；`onOpen()` 在换了一条连接时通知上层重挂监听。

这几件事缺一不可，其中断线重连那一条最容易漏：监听挂在**具体那条** `HostClient` 上，而客户端在断开那一刻会清空监听表。少了重挂，新连接能发请求却一个事件也收不到，症状是界面安静地不动（不报错、不重连、也没有提示）。

`packages/main/src/host/contract.ts` 是这一层与连接之间的唯一接缝：它只声明这一层用得到的那几件事（`call` / `subscribe` / `track` / `setAnchor` / `resolveTarget` …），本身不持有任何状态 —— 没有第二个地方能偷偷存下一份会过期的 client；客户端库重连时换的是底层 socket，`HostConnection` 这个对象不变，所以订阅也不必重挂。

### 切本地 / 远程：设置页那一节

「连哪台」不是构造时一锤定音的入参，用户能在**设置页**里改：那一页开头是一节「**宿主连接**」，单选**本地** / **远程**；远程时填**地址**（`ws://` / `wss://` / `http://` / `https://`，支持 path，如 `wss://example.com/ai-zen`）与**凭证**（留空 = 用本机 `<AI_ZEN_DIR>/run/token`）。

- **这一节自带按钮，与页面底部那个「保存」是两件事**。「测试连接」与「保存并重连」属于连接；底部那个「保存」把「默认模型 / 默认 Agent / API Key」写给**宿主**（连的还是同一台）。混成一个按钮的后果很具体：用户只想改默认模型，点一下却连到另一台机器上去了。
- **「测试连接」只探测候选值**：不落盘、不影响当前连接。成功显示宿主自报的 `protocol` / `version` / 耗时；失败显示客户端翻好的人话（`explainUnauthorized` 的措辞，例如引导去核对凭证）。地址合法性只问客户端包的 `parseHostUrl`，桌面端不写第二份校验。
- **「保存并重连」立刻换连接**：`ConnectionController.save()` 的顺序是 **先落盘 → `dispose()` 旧层 → 建新 → `start()`**，不需要重启 App。落盘失败就一个字段都不动连接（否则界面写着远程、实际还连着本地）；进行中的回答会中断，所以保存前有确认框。
- **保存成功后回到主界面，并重拉一切来自宿主的数据**（会话 / 工作区 / Agent / 模型列表）：换了宿主就是换了一整个世界，上一台的会话缓存留着只会让人点进一次永远失败的拉取。
- **远程模式不在本机拉起宿主**：本机拉起来的一定不在那个地址上；本地模式才是「发现文件 + 按需拉起」。

配置落在 `<AI_ZEN_DIR>/desktop/connection.json`（`0600`、原子写），五条**专用** IPC `connection:get` / `connection:save` / `connection:test` / `connection:state` / `connection:reconnect` 承载这条路径（不进下面那张 service 表）。

### 没配过时：`unset`（首启引导屏）

「没配过」不是一种「连不上」，而是一个**该由用户做的选择**。它必须有独立的状态：用 `{ mode: "local" }` 兜底会把「第一次启动」压成「用户选过本地」，于是应用一启动就去拉起一个本地宿主，引导屏永远出不来（同 `resolve-target.ts` 里「两格布尔装不下三种凭证来源」那一型病）。所以 `ConnectionState` 的第一支是 `{ status: "unset" }`：`start()` 在这种情形下**一层都不建**，界面据此摆出 `views/setup`（本机 / 远程 + 地址凭证 + 测试连接）。

### 连不上时：四态 + 有限重试

窗口先出来（第 3 节），于是「这条连接此刻是什么状态」必须是一个**能被问、也能被推**的值 —— 否则 render 挂载时那几句 `invokeService` 撞在一条还没连上的连接上，屏幕上就是一片空白且没有提示。三态由 `ConnectionController` 一处维护，render 只按它放行界面：

- `connecting` —— **包含**「首次尝试中」与「重试等待中」。两者靠 `attempt`（`0` = 首次尝试）与 `nextRetryInMs`（还要等多久）分开；
- `ready` —— 连上了，带宿主**自报**的 `protocol` / `version`（握手回执；拿不到时是 `0` / `""` —— 连上了但不知道自己连的是哪一版，比编一个数字诚实）；
- `error` —— **重试也失败之后**的终态（不是「这一次失败了」），带一句人话 `message`。

除 `unset` 外每一态都带一个 `label`：本地是「本机宿主」，远程是那个地址。它由 main 产出（render 不许自己拼地址、也不许猜模式），并且**不含凭证** —— 地址里的 userinfo 会先被抹掉。

**有限重试**：首次失败后最多再试 **3 次**，退避 **1s / 2s / 5s**；三次仍失败 → `error`，此后只剩用户手动「重试」（`connection:reconnect`）。自动重试只跑一批，不跑一辈子：一个连不上的远端不该让主进程永远每 5 秒敲一次门，而那种「安静地一直在试」在界面上和「停住了」长得一模一样。

**重试是整层重建**（`dispose()` → `build()` → `start()`），不是再调一次 `start()`：`ChatEventBridge.start()` 把 `unsubscribeOpen` 直接覆盖而不会先退订，同一个桥重复 `start()` 会漏掉上一条 `onOpen` 订阅 —— 那条订阅管的正是「连接换了一条要重挂监听」，掉了就再也收不到事件，界面安静地不动。所以每一次尝试都是一层新的桥、新的连接，一条都不欠。

一次尝试的四种出口（成功 `ready` / 排下一次重试 / 进 `error` / 已被新配置取代而不许再动状态）也都在那一处，`save()` 与 `reconnect()` 只负责换代（清掉挂起的计时器、让在飞的那次作废）。

## 5. 协议面

业务面的入口只有一个：`electronAPI.invokeService(service, method, ...args)`，由 `ServicesManager` 查表分发到六个 Service。另有几条**不属这张表**的通道：连接设置与连接状态 `connection:get` / `save` / `test` / `state` / `reconnect`（第 4 节）、窗口控制 `window:xxx`、原生目录选择 `dialog:selectDirectory` —— 它们回答的不是宿主的方法，而是主进程自己的事。

连接那五条里的后两条是**查询**与**手动重试**：`connection:state` 问「此刻什么状态」，`connection:reconnect` 让用户自己再点一轮（清掉挂起的计时器、`attempt` 归零，立刻返回进入 `connecting` 的那一瞬，整轮在后台跑）。同名的 `connection:state` 还是一条**推送**通道（main → render），于是「查一次」与「听变化」对调用方是同一个名字。这两条同样**不进** service 表 —— 那六个键是宿主的方法面。

**起始态不推送**：`connecting / attempt 0` 与 `start()` 之前 `state()` 给出的那一份逐字相同，推一遍只是噪声。所以 render 挂载时必须**先查询一次、再听推送** —— 只靠推送会漏掉挂载之前的那次变化，只靠查询又拿不到之后的变化。`preload` 把这几条暴露成 `electronAPI.connection = { get, save, test, state, reconnect }`。

宿主那一侧是 **JSON-RPC 2.0 over WebSocket**（`agents/packages/host/src/wire/`）：握手 `host.hello` 带凭证 + 客户端身份，之后每个方法都是 `{ jsonrpc, id, method, params }`，回包是同 `id` 的 `result` 或 `error`（`error.data` 里是 `code` + 已渲染好的 `message` + `detail`）。契约一共 **63 个方法**（`wire/methods.ts` 的 `METHOD_NAMES`），分十来个域：`host.*` / `workspace.*` / `conversation.*` / `message.*` / `search.*` / `question.*` / `notice.*` / `config.*` / `agent.*` / `model.*` / `asset.*`（这三条走二进制帧那一路）/ `completion.*` / `handoff.*`。

| 分发键 | 实现 | 今天真的调到的宿主方法 |
|--------|------|----------|
| `workspace` | `HostWorkspaceService` | `workspace.list` / `create` / `rename` / `remove` |
| `conversation` | `HostConversationService` | `conversation.list` / `create` / `get` / `rename` / `remove` / `setModel` / `state` |
| `agent` | `HostAgentService` | `agent.list` |
| `model` | `HostModelService` | `model.list` |
| `chat` | `HostChatService` | `conversation.send` / `abort` / `message.list` / `question.list` / `question.answer` |
| `config` | `HostConfigService` | `config.get` / `saveEndpoint` / `setDefaults` |

**这张表就是桌面端的欠账清单**：63 个方法里桌面上只用到 21 个。搜索（`search.*`）、撤回（`conversation.revert`）、置顶（`conversation.pin`）、思考强度（`conversation.setThinking`）、临时对话（`conversation.transient`）、通知栏（`notice.*`）、`@` 补全（`completion.files`）、MCP 与端点编辑（`config.saveMcp` / `deleteMcp` / `getDiscovery` / `deleteEndpoint`）、助手与模型的增删改（`agent.*` / `model.*`）、交接（`handoff.*`）、`host.reload` / `upgrade` / `shutdown` / `capabilities` / `setLanguage` 都还是零调用点 —— 该还的账写在 `agents/packages/host/docs/PLAN.md` §6。

方法名与事件名都是 `@ai-zen/agents-host` 的 `wire` 里的**字面量联合类型**（`MethodName` / `EventName`），不写字面量：改契约时这里编译不过，而不是运行期 500。

## 6. 事件翻译（`packages/main/src/host/events.ts`）

宿主只推 **6 条**事件（`wire/events.ts` 的 `EVENT_NAMES`）：`run.state` / `message.delta` / `conversation.changed` / `notice` / `question` / `usage`。`ChatEventBridge` 把它们翻成 render 认的 **12 种 `ChatStreamEvent`**（`packages/shared/src/types.ts`）：

| 宿主事件 | 这里发成 | 说明 |
|---|---|---|
| `message.delta` | `message` | 增量按 core 的 `applyChunk` 拼进那条助手消息（`stream.ts`），整条 `AgentNS.Message` 原样递下去 |
| `run.state` | `stream` + `done` / `error` | 六态名与正在跑的工具原样搬；`settled` 时回宿主拉一次 `message.list` 再推 `done` |
| `usage` | `message` | 本轮用量钉到那条助手消息上（render 按 id 整条替换） |
| `notice` | `notice` | 语气、时长、`LocalizedText`、归属会话全原样搬（PRD D8） |
| `question` | `question` | 整份 `QuestionView` 原样搬（见下） |
| `conversation.changed` | `renamed` | 名字要从 `conversation.get` 现拉，推送里只有「改名了」 |

另外三种不是宿主推来的：`start`（一轮开始，由 `conversation.send` 受理驱动）、`user`（用户消息，回宿主取库里的那条）、`attachments`（本轮附件结局）、还有 `migrated`（交接把任务搬到新对话之后的全量替换）。

「把结构揉成一句字」的转换这一层**不做**（R75）：承载消息/内容的地方一律是 core 的原始形状（`AgentNS.Message` / `MessageContentSection` / `ToolCall` / `Usage`）或宿主那份结构（`LocalizedText` / `ProblemFact` / `QuestionView`）。

**收尾为什么一定要回宿主拉一份**：`run.state` 只说「这一轮结束了、结局是什么」，不带消息。客户端拼出来的那条只是「能让屏幕滚起来的近似」—— 工具调用参数、消息 `status`、宿主对历史的清洗都只有库里有，所以 `settled` 之后补一次 `message.list`，把整段消息推成 `done`（render 的 `done` 本来就是全量替换）。用户消息同理：带图那句在库里是 `image_url` 内容段数组，手上只有用户敲的那几个字。

**问题对象整份搬，不自动作答**：`prompt` / `options[]` / `blocking` / `state` / `kind` 原样推给 render，界面怎么摆是 render 的事。**没有**「自动答 / 超时跳过」这回事 —— 替用户选一个等于替他决定「要不要交接、交接去哪」，而宿主不会超时取消这道题（PRD D23），题会一直挂着等人答。

## 7. render 的分层

```
packages/render/src/
├── main.ts        Vue 入口（Pinia / ElementPlus）
├── App.vue        根：TitleBar + 按连接状态放行（settings → status → guide/main）；订阅 chat:push 与 connection:state
├── deps.ts        可替换的依赖入口（`deps.api` = `apis/*` 的整份导出、`deps.notify` = toast 三档；用例 stub 它，不用 `vi.mock`）
├── views/         setup/index.vue（首启引导）、guide/index.vue、main/{index,Sidebar,ChatPanel,MessageBubble,NewChatDialog,QuestionPanel}.vue、settings/index.vue、status/index.vue
├── components/    TitleBar.vue、MarkdownContent.vue
├── composables/   useMessageWindow（分页窗口）、useAutoScroll（滚动策略）
├── stores/        ui / workspace / conversation / chat / agentView / assetImages / connection / messageVisibility
└── apis/          base + workspace / conversation / chat / agent / model / config + connection + dialog
```

- **界面按状态放行**（这是 `App.vue` 的一层，不是各视图各自判断）：优先级 `设置页 → 首启引导屏（unset）→ 未就绪时的状态屏 → guide / main`。**设置页在未连接时也进得去** —— 那是用户唯一的自救路径（改回本地 / 换一个地址）；主界面（含侧栏、会话列表）只在 `ready` 之后才挂载，避免「窗口出来了但一片空白、也没有提示」。状态屏按状态说话：`connecting` 是「正在连接 …」（重试等待中多一句「第 N 次重试，约 X 秒后」），`error` 是那句 `message` 加「重试」与「去设置」。
- **未连接时设置页只让出一半**：「默认模型 / 默认 Agent / API Key / 数据目录」全是宿主的事实，读不到就留空并挂一条说明（不弹红条、不打日志 —— 那不是故障）；「宿主连接」那一节读的是 main 本地的 `connection:get`，照常可用。
- **进入 `ready` 才拉数据**：`init()`（Agent / 模型 / 工作区，再按有没有 workspace 落到 guide 或 main）只在 `false → true` 那一刻跑一次。「保存并重连」成功（已连上）后回到主界面；而如果用户此刻正停在设置页，后台自动重试成功**不会**把他从设置页拽走 —— 数据照常加载，只是不切视图。
- **apis 只做转发**：`invokeService` 收敛成方法，错误统一成 `InvokeHostError`；`subscribeServiceEvent("chat:push", …)` 是唯一的事件入口。`apis/connection.ts` 是五条连接通道的同一套转发（它不经过 `invokeService`），`connection:state` 那条推送走同一对 `on` / `off`。`apis/dialog.ts` 是同一件事的另一半，只是走 main 的 `dialog:selectDirectory`（原生目录选择）—— 失败在那个函数里就收口（用户取消与选择框打不开都回 `null`，但后一种说一句），两个调用点（侧栏与引导页）因此不再各写一份无 `try/catch` 的同形代码。
- **store 之外的两层**：`deps.ts` 是 store 与外面世界（IPC、toast）之间**唯一可替换的接缝**，产品里没人替换它；视图组件（`App.vue`、设置面板）直接用真 `apis/*`。理由是 render 的用例故意关掉了 vitest 隔离（见第 10 节），`vi.mock` 会按模块说明符串到下一个文件。
- **`config.update` 回报 `ConfigUpdateReport`**：main 有两处**故意不写**（宿主配置里已经不存在的端点、空的默认值），它自己把「写了哪些 / 哪些没写 / 为什么」报回来。设置页据此说真话 —— 「发出去了」不等于「写进去了」。
- **store 是唯一数据入口**：视图不调 `invokeService` 字符串。`chat` 按 `byConversation[id]` 分槽，切换会话只换视角，各会话的流式状态互不干扰。`conversation.select()` 是**可等**的：它内部要向宿主要一次现场（`chat.getState` → 宿主的 `conversation.state` + `message.list`，再补一次 `question.list`），失败会抛给调用方，由视图当场说清 —— 同步发射的后果是界面上留下「左边选中了、右边空白」，那和「这段会话本来就没消息」长得一模一样。
- **子 Agent 栏目与主对话并行**：`agents` 是 `SubAgentView[]` 的整份替换（宿主一变化就推全量），render 不做 diff；选中态修正与 Tab 循环抽在 `packages/render/src/stores/agentView.ts`，纯函数、可测。
- **通知是 toast，不是状态**：`type: "notice"` 直接弹 element-plus，不进 `ConversationChatState` —— 尤其不碰 `error`（那是「本轮失败」的错误条，`done` 会把它清空）。

## 8. 数据归属

盘上的**数据**都归宿主（它的 `AI_ZEN_DIR`）；唯一的例外是桌面前端自己那个连接配置文件（下面 `desktop/` 那一行）：

```
<AI_ZEN_DIR>/
├── config.json                 全局配置（endpoints / models / 默认模型与 Agent / 语言）
├── mcp.json                    MCP 服务器清单（含各作用域与 OAuth 掩码）
├── mcp-oauth/                  OAuth 令牌（宿主自己管，客户端只看到掩码）
├── agents/                     入口助手定义（一人一个文件）
├── sub-agents/                 子 Agent 定义
├── tools/ · skills/            能力目录（按 Workspace 的 cwd 与数据根两级）
├── ai-zen.db                   SQLite：工作区 / 会话 / 消息 / 素材 / 通知 / 问题 / 凭证（-wal / -shm 随行）
├── assets/                     素材字节（按摘要落盘，库里只存相对路径）
├── logs/                       宿主日志
├── desktop/
│   └── connection.json         连接设置（本地 / 远程 + 地址 + 凭证，0600；**删掉即回到首启引导屏**）
└── run/                        宿主自己写：怎么找到它
    ├── host.json               服务发现：宿主的 pid / 地址 / 端口 / 版本
    └── token                   本地凭证（宿主启动时读或生成，0600）
```

桌面端在盘上只读 `<AI_ZEN_DIR>/run/` 下的两件事：`host.json`（**默认**的地址来源）与 `token`（凭证）；远程模式下地址来自连接设置，连 `host.json` 都不读。它**只写一处**：`<AI_ZEN_DIR>/desktop/connection.json`（连接设置，理由见第 3 节的「先有鸡先有蛋」；删掉这个文件就回到首启引导屏 —— 不是「回到本地」，那会把一次删除解释成一次选择）。

「连哪台」与「拿什么进门」就存在这个文件里（`{ mode, hostUrl?, hostToken? }`）：`local` 时两个值对连接层一律是 `undefined`（= 老路），`remote` 时才是用户填的那两个。改它的入口只有设置页那一节（第 4 节），不需要手改文件。

## 9. 模型解析只有一份实现

「会话级覆盖 > 助手定义 > 全局默认」的三级解析在宿主（SDK 的 `resolveModel`）。桌面端既不缓存也不重算，只读宿主给的 `ModelState`（`wire/states.ts`）：

```ts
{ modelId: string; name: string; vision: boolean; source: "conversation" | "agent" | "default" }
```

`conversation.list` 的每一行给 `modelId`（侧栏下拉框显示的就是它），`conversation.get` / `conversation.state` 给整份 `ModelState`（含 `source` —— 换模型之后界面要说清「现在是跟随助手」还是「这段会话自己指定的」）。客户端按「覆盖 + 定义 + 默认」再推一遍就是把优先级规则写第二遍，而两份迟早在某个边界上分叉。

## 10. 测试形态

两层各有各的验收手段，都不开窗口：

- **`host/` 那一层**用**假连接 + 计数器**：`ContractConnection` 是注入进来的窄接缝（`host/contract.ts`），用例照契约形状回包、随手推事件，断言读的是门面推出去的 `ChatStreamEvent` 序列 —— 翻译层唯一的验收口径就是这条通道。验的是「协议 → render 形状」的映射本身，所以 Agent 与 socket 都该是假件。
- **`connection/` 那一层**：`ConnectionController` 的依赖全部注入（建层工厂、配置读写、日志出口），用例拿**假层 + 计数器**就能把「先落盘 → `dispose` 旧层 → 建新 → `start`」这条顺序咬死（落盘失败时 `dispose` 一次都不许被调），不必起真宿主、也不必开窗口；`settings.ts` 的用例碰真磁盘（临时 `AI_ZEN_DIR`），验的是 `0600`、原子写与「读不炸」。

**规模**（`pnpm --filter @ai-zen/desktop-main test` / `… desktop-render test`）：`packages/main` 10 个文件 / 131 条（128 通过 + 3 跳过），`packages/render` 9 个文件 / 81 条。

两个包都写 **`isolate: false`**（同进程内复用模块图，与 `agents` 仓的 sdk / host / client、`cli` 同口径）。代价由用例自己承担：不用 `vi.mock`（它按模块说明符**进程级**注册替身，共享模块图时会串到下一个文件），要换的东西走 `src/deps.ts` 的 `stubDeps()` / `resetDeps()`。这条不是风格问题 —— 在 render 上实测过：关掉隔离后原来靠 `vi.mock` 的 5 个文件互相串味，单跑绿、两条合跑就红。

## 11. 取舍

| 取舍 | 理由 |
|------|------|
| 连接与「怎么发请求」分成两个东西（`HostConnection` / `packages/main/src/host/contract.ts`） | 缓存在对象里的 client 会在宿主重启后永久失效，而症状只是「没反应」 |
| 增量拼消息的规则在库里（core 的 `applyChunk`），不在 main | 同一套「一轮之内怎么拼」的规则在本仓与 CLI 之间只能有一份，两份的边界情形迟早分叉 |
| 事件整份替换（`message` / `agents`） | 消费方不需要任何合并逻辑；增量事件把复杂度摊给每一个消费方 |
| 未知通知码也要出文案 | 版本偏斜是常态，静默丢弃让用户看到「什么都没发生」 |
| 文案在宿主（`LocalizedText` 带着码与参数），main 只按连接语言重渲染 | 版本偏斜是常态，「哪条事件说什么话」跟着契约走，客户端只负责换语言 |

## 12. 打包与分发

「随包分发的宿主」得要真的随包走：应用装好就能用，客户机上不需要 Node.js / npm。

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
│   ├── ai-zen-desktop             Electron 可执行（同时也是宿主的 Node 解释器）
│   └── resources/app.asar         3.2 MB，只有 dist/
└── AI-Zen Desktop-0.1.0.AppImage  122 MB
```

asar 里就这五条，其余被 `files: [dist/**, !**/*.map]` 挡在门外：

```
/dist/main.mjs      主进程入口（ESM）
/dist/host.mjs    随包分发的宿主（自包含，1.5 MB）
/dist/preload.js    contextBridge
/dist/static/…      render 产物（index.html + assets/）
/package.json       type: module + main: dist/main.mjs
```

**`host.mjs` 为什么必须在 `main.mjs` 同目录**：`launch.ts` 用 `import.meta.url` 推同级路径（`dirname(main.mjs) + host.mjs`），它并不知道自己被打进了 asar。同目录这条约束在 asar 里同样成立 —— `ELECTRON_RUN_AS_NODE=1` 的 Electron 二进制也认 asar 路径，读得到、跑得起来，所以不需要 `asarUnpack`。

**产物里为什么没有 `node_modules`**：`main.mjs` 除 `electron` 外全内联（`rolldown.config.mjs` 里 core / sdk / shared 都从 `external` 拿掉了），`host.mjs` 本来就是全内联。于是 `packages/main` 的依赖全是**构建期输入**，全在 `devDependencies`；electron-builder 收不到任何生产依赖，asar 里也就没有 `node_modules` —— 那几条跨仓的 `link:` 路径（`../../../agents/…`）因此完全不出现在产物里。

**asar 根 `package.json` 的 `type` / `main` 不是装饰**：这两个字段是 Electron 认出 ESM 主进程的依据（Electron 43 支持 ESM 主进程，但入口得能被解析成 ESM）。electron-builder 会剥掉 `scripts` / `devDependencies`，这两个字段原样留下。

**render 怎么被加载**：`app.ts` 按 `NODE_ENV === "development"` 二选一 —— 开发期 `loadURL("http://localhost:5173")`，否则 `loadFile(dist/static/index.html)`。打包后 `__dirname` 变成 `<…>/app.asar/dist`，`dist/static` 相对它没有位移，file:// 这条路照旧；资源引用靠 Vite 的 `base: "./"` 保持相对。

**目前没有做的**：应用图标（用的 Electron 默认图标）、`author` / `desktopName`（只在出 deb 前才必须）、macOS 与 Windows 目标。
