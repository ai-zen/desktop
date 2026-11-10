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
├── config.ts   唯一的路径常量 AI_ZEN_DIR
├── preload.ts  contextBridge 暴露 window.electronAPI
└── server/     服务端门面（可直接被 vitest + 真 daemon 验收）
    ├── index.ts            组装根：createServerLayer
    ├── call.ts             一次协议调用（每次取一条活着的连接，不缓存 client）
    ├── services.ts         六个 Service：render 的形状 ↔ 协议调用
    ├── ServicesManager.ts  invokeService 动态分发
    ├── events.ts           服务端事件 → ChatStreamEvent
    └── notices.ts          通知 code → 中文文案
```

两条硬边界：

- **`server/` 不碰 electron**。`createServerLayer` 只收四样非 electron 的事实（配置根、握手身份、默认工作目录、事件出口），所以它能被用例直接起起来；`app.getPath` / `dialog` / `webContents.send` 只出现在 `packages/main/src/app.ts` 里，以参数或回调递进去。
- **`server/` 不碰磁盘**。会话清单、消息、工作区、配置全部经协议向服务端要。

## 4. 一条连接（`ServerConnection`）

「连哪台、断了怎么办」收在 `@ai-zen/agents-client` 的 `agents/packages/client/src/transport/connection.ts` 一份实现里，`packages/main/src/server/index.ts` 只组装它一次：

- **连哪台**由服务发现文件回答（`<AI_ZEN_DIR>/run/server.json`）。服务端重启后换端口，文件跟着换，本层不缓存端口也不记 pid。
- **断了怎么办**：`client()` 每次取用都判 `closed`，关了就地重建；`watch()` 让这条连接开始收事件；`onOpen()` 在换了一条连接时通知上层重挂监听。

这三件事缺一不可，其中最后一条最容易漏：监听挂在**具体那条** `ServerClient` 上，而客户端在断开那一刻会清空监听表。少了重挂，新连接能发请求却一个事件也收不到，症状是界面安静地不动（不报错、不重连、也没有提示）。

`packages/main/src/server/call.ts` 是这一层与连接之间的唯一接缝：`protocolCall(connection)` 每次 `await connection.client()` 再 `call(method, params)`，本身不持有任何状态 —— 没有第二个地方能偷偷存下一份会过期的 client。

## 5. 协议面

对 render 只有一个入口：`electronAPI.invokeService(service, method, ...args)`，由 `ServicesManager` 查表分发到六个 Service。

| 分发键 | 实现 | 主要动作 |
|--------|------|----------|
| `workspace` | `ServerWorkspaceService` | `workspace.list` / `create`（= `workspace.resolve`，填了名字再补一次 `workspace.rename`）/ `rename` / `remove` |
| `conversation` | `ServerConversationService` | `session.list` / `create` / `attach` + `snapshot` / `rename` / `remove` / `model.set` |
| `agent` | `ServerAgentService` | `agent.list`（只列入口 Agent） |
| `model` | `ServerModelService` | `config.get` 里取 `models` |
| `chat` | `ServerChatService` | `session.send` / `cancel` / `close` / `attach` + `snapshot` |
| `config` | `ServerConfigService` | `config.get` / 窄方法写默认值 / `config.save` |

事件面是协议里的三张表（`agents/packages/protocol/src/sessions.ts`）：`AGENT_EVENTS` 9 条（core `Agent.events` 的原名）、`SESSION_EVENTS` 7 条（服务端派生或自己决定的事）、`SERVER_EVENTS` 1 条（不绑会话的服务端通知）。事件名一律 kebab-case —— `session-turn-end`、`session-title-changed`、`server-notice`。

方法名与事件名都从 `@ai-zen/agents-client` 的常量表引用，不写字面量：改协议时这里编译不过，而不是运行期 500。

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
├── stores/        ui / workspace / conversation / chat / agentView
└── apis/          base + workspace / conversation / chat / agent / model / config
```

- **apis 只做转发**：`invokeService` 收敛成方法，错误统一成 `InvokeServerError`；`subscribeServiceEvent("chat:push", …)` 是唯一的事件入口。
- **store 是唯一数据入口**：视图不调 `invokeService` 字符串。`chat` 按 `byConversation[id]` 分槽，切换会话只换视角，各会话的流式状态互不干扰。
- **子 Agent 栏目与主对话并行**：`agents` 是 `SubAgentView[]` 的整份替换（服务端一变化就推全量），render 不做 diff；选中态修正与 Tab 循环抽在 `packages/render/src/stores/agentView.ts`，纯函数、可测。
- **通知是 toast，不是状态**：`type: "notice"` 直接弹 element-plus，不进 `ConversationChatState` —— 尤其不碰 `error`（那是「本轮失败」的错误条，`done` 会把它清空）。

## 8. 数据归属

盘上的一切都归服务端（它的 `AI_ZEN_DIR`）：

```
<AI_ZEN_DIR>/
├── config.json                  全局配置（endpoints / models / 默认模型与 Agent）
├── agents/                      入口 Agent 定义
├── sub-agents/                  子 Agent 定义
├── workspaces/<workspaceId>/    workspace.json + sessions/<id>.json（含 .meta.json 清单）
└── run/server.json              服务发现：常驻服务端此刻在哪个端口
```

桌面端只读 `<AI_ZEN_DIR>/run/server.json` 一件事。会话存活由服务端按空闲宽限期（`DEFAULT_SESSION_IDLE_TIMEOUT_MS`）回收，`session.close` 是「我不看这段了」的当场释放，两者都不删存档。

## 9. 模型解析只有一份实现

「会话级覆盖 > Agent 定义 > 全局默认」的三级解析在服务端（SDK 的 `resolveModel`）。桌面端既不缓存也不重算，只读两个字段：

- `SessionListEntry.modelId` —— 这段会话**有没有**自己的覆盖；
- `SessionListEntry.effectiveModelId` —— 它**实际在用**哪个模型（解析不出来时省略）。

侧栏的模型下拉框读后者；客户端按「覆盖 + 定义 + 默认」再推一遍就是把优先级规则写第二遍，而两份迟早在某个边界上分叉。

## 10. 测试形态

`server/` 那一层可以被 vitest 直接验收：`packages/main/src/server/test-harness.ts` 起一个**真 daemon**（真端口、真帧、真 `SessionManager`）+ 一个**假 Agent**（用例自己决定什么时候推哪一片增量）。验的是协议映射本身，所以 Agent 的流式循环该是假件，socket 与发现文件必须是真的。用例读的是门面推出去的 `ChatStreamEvent` 序列 —— 翻译层唯一的验收口径就是这条通道。

## 11. 取舍

| 取舍 | 理由 |
|------|------|
| 连接与「怎么发请求」分成两个东西（`ServerConnection` / `packages/main/src/server/call.ts`） | 缓存在对象里的 client 会在服务端重启后永久失效，而症状只是「没反应」 |
| 状态机在包里，不在 main | 同一套「一轮之内怎么拼」的规则在本仓与 CLI 之间只能有一份，两份的边界情形迟早分叉 |
| 事件整份替换（`message` / `agents`） | 消费方不需要任何合并逻辑；增量事件把复杂度摊给每一个消费方 |
| 未知通知码也要出文案 | 版本偏斜是常态，静默丢弃让用户看到「什么都没发生」 |
| 词典在 main 而不是 render | 文案与「哪条事件变成哪个 code」是同一件事，而事件翻译已经全在 main |
