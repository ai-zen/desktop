// ==================== 类型契约（shared）====================
// 实体 + IPC 事件 DTO。纯类型，零运行时。
// 消息模型直接沿用 Core 的 AgentNS.Message（三层统一，不做 adapter）。

import type { AgentNS } from "@ai-zen/agents-core";

// ==================== Workspace ====================

export interface Workspace {
  id: string;
  name: string;
  /** 工作目录 —— 会话在服务端跑在这个目录下（服务端规范化后的绝对路径） */
  cwd: string;
}

// ==================== Conversation ====================

export interface Conversation {
  id: string;
  workspaceId: string;
  agentId: string;
  /** 模型下拉框要显示的**当前模型**：桌面端往里放的是服务端三级解析后的生效值（不是「会话级覆盖」那一位，覆盖值为空时它仍有值） */
  modelId: string;
  name: string;
  /** 直接沿用 Core 消息模型（三层统一，无 adapter） */
  messages: AgentNS.Message[];
  createdAt: string;
  updatedAt: string;
}

export interface ConversationSummary {
  id: string;
  workspaceId: string;
  agentId: string;
  /** 同上：模型下拉框要显示的**当前模型**（桌面端填入服务端清单里的 `effectiveModelId`，解析不出来时空串） */
  modelId: string;
  name: string;
  messageCount: number;
  updatedAt: string;
  /** 会话运行中标记（侧栏显示） */
  running?: boolean;
}

/** chat.getState 返回：会话实时状态（服务端 `session.snapshot` 原样转回，含流式进行中的消息） */
export interface ConversationState {
  messages: AgentNS.Message[];
  streaming: boolean;
}

// ==================== Agent / Model 选项 ====================

export interface AgentOption {
  id: string;
  name: string;
  description?: string;
}

export interface ModelOption {
  id: string;
  name: string;
}

// ==================== 设置页（ConfigService） ====================

/** 端点设置（设置页可编辑 API Key / 地址 / 名称） */
export interface EndpointSettings {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  description?: string;
}

export interface ConfigSettings {
  /** 全部端点（含 API Key，桌面本地应用场景明文展示） */
  endpoints: EndpointSettings[];
  /** 默认模型（config.defaultModel） */
  defaultModel: string;
  /** 默认 Agent（config.defaultAgent） */
  defaultAgent: string;
  /** 数据目录（只读：服务端 `config.json` 所在目录，由服务端随配置一起回来） */
  dataDir: string;
}

// ==================== 连接设置（本地 / 远程） ====================

/**
 * 连哪台服务端：`local` = 老路（地址读 `<AI_ZEN_DIR>/run/server.json`，凭证读 `<AI_ZEN_DIR>/run/token`）；
 * `remote` = 用户显式填的那一台（可能在他自己机器上，也可能在隧道另一端）。
 *
 * ## 为什么只有两档，且 `local` 不叫 `loopback`
 *
 * 决策 D9 明文**不做静态的 loopback 判断**：隧道的入口恰恰是 `127.0.0.1:9999`（`ssh -L` /
 * `kubectl port-forward` / tailscale serve 都长这样），从地址上分不出「本机 daemon」与
 * 「隧道另一端」。所以 `local` 说的不是「地址在本机」，而是「按本机发现文件 + 本机凭证走」——
 * 连的到底是谁，由服务端的回答决定。
 */
export type ConnectionMode = "local" | "remote";

/**
 * 用户在设置面板里能改的全部连接配置。落盘在 `<AI_ZEN_DIR>/desktop/connection.json`（`0600`）。
 *
 * ## `local` 模式下那两个值必须是 `undefined`，不是空字符串
 *
 * 客户端把空串当成「显式给了一个空值」（于是它不会退回发现文件 / 本机 `run/token`），只有
 * `undefined` 才表示「按老路走」。这条口径在 main 侧由
 * `connection/settings.ts` 的 `connectionConfigOf()` 保证，类型这里只说明事实。
 */
export interface ConnectionSettings {
  /** `local` = 老路：地址读 `<AI_ZEN_DIR>/run/server.json`，凭证读 `<AI_ZEN_DIR>/run/token` */
  mode: ConnectionMode;
  /** 仅 `remote` 有意义：显式地址（`ws:` / `wss:` / `http:` / `https:`） */
  serverUrl?: string;
  /** 仅 `remote` 有意义：显式凭证。留空 = 退回 `<AI_ZEN_DIR>/run/token`（D9 的本地兜底） */
  serverToken?: string;
}

/**
 * 「测试连接」的结果。
 *
 * 成功那一支只有三件可看的事实：服务端自报的协议版本、版本串、以及这一次试连花了多久
 * （用户判断「远端是不是慢得不能忍」的唯一依据）。失败那一支只有一句**人话** —— 它不是
 * 错误码的搬运工，`unauthorized` 的四种成因已经被客户端包的 `explainUnauthorized` 翻过
 * 一遍了（哪一种该去改什么，措辞只有那一份）。
 */
export type ConnectionProbe =
  | { ok: true; protocol: number; version: string; elapsedMs: number }
  | { ok: false; message: string };

/**
 * 「此刻这条连接是什么状态」（D23）—— render 靠它决定**该不该说话**。
 *
 * ## 为什么这个状态必须存在（而不是「连上了就是连上了」）
 *
 * 窗口现在**先出来**、连接放到后面（D25）。于是 render 挂载的那一刻，连接可能还没建立 ——
 * 它在 `onMounted` 里发的 `workspace.list` / `config.get` 会撞在一条还没连上的连接上，
 * 屏幕上就是一片空白且没有提示。三态是那次挂载唯一能问的东西：`connecting` 就等，
 * `ready` 就照常干活，`error` 就把 `message` 显示出来（含「去设置页改回来」的入口）。
 *
 * ## 四态各自的含义
 *
 *   · `unset` —— **没配过**（`connection.json` 不存在或不可用）。这不是「连不上」，而是一个
 *     该由**用户**做的选择：界面据此摆出首启引导屏（本机 / 远程），而不是去猜一个默认值。
 *     把「没配过」压进 `local` 是错的 —— 那样应用一启动就去拉起一个本地服务端，「引导」永远
 *     出不来；
 *   · `connecting` —— **包含**「首次尝试中」与「重试等待中」。两者的区别是最后两个字段：
 *     `attempt: 0` = 首次尝试（`nextRetryInMs` 为 `undefined`）；`attempt: N > 0` = 正在
 *     等待第 N 次重试，`nextRetryInMs` 是还要等多久（见 D24 的 1000 / 2000 / 5000）；
 *   · `ready` —— 连上了。`protocol` / `version` 是服务端**自报**的（`hello` 回执），
 *     拿不到时是 `0` / `""`（连上了但不知道自己连的是哪一版，比编一个数字诚实）；
 *   · `error` —— **重试也失败之后**的终态（不是「这一次失败了」）。它带一句人话 `message`；
 *     用户点「重连」（{@link ConnectionControls.reconnect}）才会离开这个状态。
 *
 * ## `label` 为什么由 main 产出
 *
 * render 不许自己拼地址、也不许猜模式（`local` / `remote` 是 main 的事实）：`label` 就是
 * 它该显示的那一行字 —— 本地模式是 `"本机服务端"`，远程模式是那个地址。
 * **它绝不包含凭证**（地址里的 userinfo 与任何 token 都不会进这里，见 main 的
 * `connection/controller.ts`）。
 */
export type ConnectionState =
  /** 没配过：连一个默认值都不该猜，界面该问用户（首启引导屏） */
  | { status: "unset" }
  | { status: "connecting"; label: string; attempt: number; nextRetryInMs?: number }
  | { status: "ready"; label: string; protocol: number; version: string }
  | { status: "error"; label: string; message: string };

// ==================== 子 Agent 视图 ====================

/**
 * 子 Agent 的状态：`running` 是进行态，`done` / `failed` 是终态。
 *
 * 取值与服务端 `sub-agent-start` / `sub-agent-end` 那两条事件逐字一致（协议不另造词汇）：
 * 前者只会带来 `running`，后者带来 `done` / `failed`，快照也回这三个值之一。
 */
export type SubAgentStatus = "running" | "done" | "failed";

/**
 * 一个子 Agent 自己的对话（= 栏目标签 `子AGENT{n}` 点进去看到的那一屏）。
 *
 * 三处事实**都来自服务端**，客户端一个都不自己算：
 *   - `id`：`sub-agent-start` 的 `subAgentId`（跨轮稳定的标识，选中态与 v-for key 靠它；
 *     它不带展示含义，展示序号是 `index`）；
 *   - `index`：同一个事件里的 `index`（本轮内从 1 起，栏目标签直接印它）。客户端不数：
 *     它要在「切到某个子 Agent」「中途接上连接」时都对得上，而那时本地没数过；
 *   - `status`：`sub-agent-start` 给 `running`、`sub-agent-end` 与 `session.subAgent.snapshot` 给终态。
 */
export interface SubAgentView {
  id: string;
  index: number;
  status: SubAgentStatus;
  /** 它到目前为止的对话（流式期间由增量拼出来，之后以 `session.subAgent.snapshot` 为准） */
  messages: AgentNS.Message[];
}

// ==================== 推送事件 DTO ====================

/** chat:push 单通道推送（discriminated union）
 *  状态源是常驻服务端：send 只提交（快速返回），user/start/message/done 全由事件回流 */
export type ChatStreamEvent =
  | { conversationId: string; type: "start" }
  /** 本轮的用户消息上屏（render 据此上屏，不本地乐观插入）
   *  id 由 main 编（`${会话}:user:${turnId}`）：协议不推用户消息，id 只为给 render 一个稳定的 v-for key */
  | { conversationId: string; type: "user"; id: string; content: string }
  /** 一条完整消息的实时同步（流式中的 assistant 消息：正文/reasoning/tool_calls/status；
   *  以及每轮结束补推的工具结果消息）。id 是服务端消息 id，流式那条由 main 编并随后被 `done` 里的真 id 取代；
   *  render 按 id 就地 upsert：有则替换、无则追加末尾 —— 事件到达顺序即消息顺序 */
  | { conversationId: string; type: "message"; id: string; message: AgentNS.Message }
  | { conversationId: string; type: "done"; messages: AgentNS.Message[] }
  /** 任务迁移完成后推送：全量替换消息。旧历史带 omit（已作废）标记，UI 展示但不进 agent 请求 */
  | { conversationId: string; type: "migrated"; messages: AgentNS.Message[] }
  | { conversationId: string; type: "error"; message: string }
  /** 自动生成对话标题后推送（不阻塞 done，侧栏据此更新名称） */
  | { conversationId: string; type: "renamed"; name: string }
  /**
   * 服务端推来的一条**通知**（`session-notice` / `server-notice`）：给用户看的一句话，瞬时的。
   *
   * ## 为什么不是 `type: "error"`
   *
   * `error` 的语义是「这一轮失败了」：render 把它写进会话状态里的错误条，占着位置，直到
   * 下一轮 `done` 才被清掉。通知说的不是失败，而是「顺带告诉你一句」——存档没写成功、
   * 本次迁移被跳过、子 Agent 挂了、交接文档落在哪。走 `error` 通道有两个后果：用户要在
   * 下一轮开始前一直看着一条红字（其实这轮没事），而 `done` 会替它提前销账（真该看的那句
   * 反而被抹掉）。两条通道各说各的：`error` 是状态，`notice` 是提示。
   *
   * ## 为什么 `text` 到了这一层已经是人话
   *
   * 服务端刻意不产文案（协议只给 `level + code + params`，见 `SessionNoticeEvent`），
   * 翻译发生在 main 的词典里（`packages/main/src/server/notices.ts`）—— 那里是唯一一份，
   * render 只管把拿到的这句话弹出来，不再查第二份词典。
   *
   * ## 为什么 `conversationId` 是可选的
   *
   * `server-notice` **不属于任何会话**（存档目录不可用、MCP 连不上是服务本身的事）。
   * 空串不是它的替身：空串的意思是「有一个会话，它的 key 是空字符串」，与「没有会话」是
   * 两件事 —— render 按 key 取状态槽位，空串会凭空开出一个谁都不认识的假槽位。
   */
  | { type: "notice"; level: "info" | "warn" | "error"; text: string; conversationId?: string }
  /**
   * 这段会话**当前这一轮**的子 Agent 栏目，一有变化就推**整份**。
   *
   * ## 为什么是整份替换，而不是「新增 / 更新 / 删除」三条增量事件
   *
   * 子 Agent 的对话很短（一次委派的完整上下文通常就几条消息），而 render 那边要对的是
   * 「用户切到某一栏看到的那一屏」。整份替换让 render **不需要任何合并逻辑**：收到就把手上
   * 那份换掉，字段就是 `SubAgentView`（id / index / status / messages），没有 id 对应的
   * upsert、没有「这条是新的还是改的」的判断。增量事件的复杂度会摊到每一个消费方（桌面端
   * 今天一个，将来还会有别的），而省下来的带宽在一屏几条消息的量级上毫无意义。
   *
   * 这与主对话那条 `message` 事件的取舍完全同源：那条也是「推这条消息此刻的完整内容」，
   * 让 render 按 id 整条替换 —— 一处只有一个合并口径，就不会出现「两套合并规则各说各话」。
   *
   * ## 空数组 = 这一轮的子 Agent 都没了
   *
   * 子 Agent 只活在当前一轮（`session-turn-end` 之后服务端把它们连同展示序号一起清掉，客户端同一
   * 口径）。所以 `agents: []` 的意思是「把栏目收回去」，不是「这段会话没有子 Agent 这个
   * 概念」。render 收到空数组就清空栏目、退回主对话 —— 不能让一个标签停在一段已经过去的
   * 对话上。换会话 id（迁移 / 另存为）同样清空。
   *
   * ## 顺序
   *
   * 数组顺序 = `sub-agent-start` 的到达顺序 = 服务端给的 `index` 顺序（栏目标签
   * 从左到右）。render 直接照数组渲染，不重排 —— 重排就得知道「序号是谁给的」，而那是
   * 服务端的展示序号，不是客户端可以推的东西。
   */
  | { conversationId: string; type: "agents"; agents: SubAgentView[] };

/** 窗口最大化状态变更 */
export interface WindowStateEvent {
  maximized: boolean;
}

// ==================== IPC 协议 ====================

export interface WindowControls {
  minimize: () => Promise<void>;
  maximize: () => Promise<void>;
  close: () => Promise<void>;
  isMaximized: () => Promise<boolean>;
}

export interface ElectronAPI {
  /** 通用服务调用：invokeService(service, method, ...args) —— 对应 main ServicesManager 动态分发，极薄，零业务定义 */
  invokeService: <T = unknown>(
    service: string,
    method: string,
    ...args: unknown[]
  ) => Promise<T>;
  /** 监听主进程推送事件 */
  on: (channel: string, callback: (...args: unknown[]) => void) => void;
  /** 取消监听 */
  off: (channel: string, callback: (...args: unknown[]) => void) => void;
  /** 打开原生目录选择器，返回选中路径（取消则 null） */
  selectDirectory: () => Promise<string | null>;
  /** 窗口控制 */
  window: WindowControls;
  /** 连接设置（本地 / 远程） */
  connection: ConnectionControls;
}

/**
 * 连接设置的**五条专用通道**（`connection:get` / `connection:save` / `connection:test` /
 * `connection:state` / `connection:reconnect`）。
 *
 * ## 为什么不走 `invokeService`
 *
 * `invokeService` 的六个分发键（workspace / conversation / agent / model / chat / config）
 * 就是**服务端的方法表** —— render 的调用面与协议一一对应。而「连哪台服务端」在服务端还不
 * 存在的时候就要回答（先有鸡先有蛋），它是**主进程自己**的事。混进那张表，第一个后果是
 * 「六个键 = 服务端调用面」这条边界失效（下一个人会以为 `connection.get` 也是协议方法），
 * 第二个是它根本没法被转发 —— 转发要一条连着的服务端，而它正是决定连哪条的那一个。
 */
export interface ConnectionControls {
  /** 读当前配置：文件不存在 / 坏 JSON / 字段不合法都回 `{ mode: "local" }`，**绝不抛错** */
  get: () => Promise<ConnectionSettings>;
  /**
   * 保存并**立即重建连接**（不要求重启 App）：先落盘、再换层。
   *
   * ## 两条失败路径说的不是一件事，界面不许混着显示
   *
   *   · **落盘失败**（或校验不过）→ 抛原错误，连接**一个字段都不动**。界面该说「没保存
   *     成功」，盘上那一份还是旧的；
   *   · **落盘成功但连不上**（D27）→ 也抛，但措辞明说「已保存」（例如
   *     「连接配置已保存，但连不上 …：…」），并且状态机已经落到 `connecting`（后台按 D24
   *     重试）。这种情况下**绝不能**显示成「保存失败」：盘上确实已经改了，用户再点一次
   *     「保存」也只是又存一遍同一份配置。
   *
   * 换层期间进行中的回答会中断（那是换连接的固有代价，界面上要提示）。
   */
  save: (settings: ConnectionSettings) => Promise<{ settings: ConnectionSettings }>;
  /**
   * 用**候选值**试连一次：不落盘、不影响当前连接（面板上「测试连接」那个按钮）。
   *
   * 地址非法 / 连不上 / 凭证被拒都**不抛错**，一律折成 `{ ok: false, message }`：这条通道的
   * 返回值就是给人看的一句话，抛错只会让界面多一条没头没尾的红字。
   */
  test: (candidate: { serverUrl: string; serverToken?: string }) => Promise<ConnectionProbe>;
  /**
   * **查询**当前连接状态（D26）。
   *
   * 为什么查询与推送（主进程 → render 的推送通道同名，也叫 `connection:state`）必须**都存在**：
   * 窗口现在先出来（D25），它挂载的那一刻可能已经错过了一次状态变化 —— 只靠推送会漏，
   * 只靠查询又拿不到之后的变化。两个合起来才完整：查一次当前值，之后听推送。
   *
   * 永不抛错：还没 `start()` 时它答 `{ status: "connecting", attempt: 0 }`（那正是事实 ——
   * 连接还没来得及开始），`label` 由盘上那份配置算出。
   */
  state: () => Promise<ConnectionState>;
  /**
   * 手动重试一次（D24）：清掉挂起的重试计时器、`attempt` 归零、立刻再试一轮（含它自己的
   * 3 次退避）。用户点「重连」与 `error` 态下那个按钮都走这里。
   *
   * **返回进入 `connecting` 之后的那一刻状态**（不是整轮的结果）：这一轮在后台跑，最多
   * 8 秒（1000 + 2000 + 5000），把它 await 住会让界面在那 8 秒里既没有回执也没有反馈。
   * 后续（`ready` / `connecting(N)` / `error`）全走推送。
   */
  reconnect: () => Promise<ConnectionState>;
}

// 与连接相关的纯函数（render 也能用：包里那份是 Node 包，进不了浏览器产物）
export * from "./address.js";

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
