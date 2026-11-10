// ==================== 类型契约（shared）====================
// 实体 + IPC 事件 DTO。纯类型，零运行时。
// 消息模型直接沿用 Core 的 AgentNS.Message（见 desktop-design.md A7）。

import type { AgentNS } from "@ai-zen/agents-core";

// ==================== Workspace ====================

export interface Workspace {
  id: string;
  name: string;
  /** 工作目录 —— Provider.cwd 的注入基准 */
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
  /** 同上：模型下拉框要显示的**当前模型**（桌面端填入服务端清单里的 `effectiveModelId`，解析不出来时才退回会话级覆盖值 / 空串） */
  modelId: string;
  name: string;
  messageCount: number;
  updatedAt: string;
  /** D8：会话运行中标记（侧栏显示） */
  running?: boolean;
}

/** chat.getState 返回：会话实时状态（有常驻 agent 则取 agent.messages，含流式进行中的消息） */
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
  /** 数据目录（只读：AI_ZEN_DIR 路径） */
  dataDir: string;
}

// ==================== 子 Agent 视图 ====================

/**
 * 子 Agent 的状态：`running` 是进行态，`done` / `failed` 是终态。
 *
 * 取值与服务端 `session.subAgent.*` 那两条事件逐字一致（协议不另造词汇）：`started` 只会
 * 带来 `running`，`ended` 带来 `done` / `failed`，快照也回这三个值之一。
 */
export type SubAgentStatus = "running" | "done" | "failed";

/**
 * 一个子 Agent 自己的对话（= 栏目标签 `子AGENT{n}` 点进去看到的那一屏）。
 *
 * 三处事实**都来自服务端**，客户端一个都不自己算：
 *   - `id`：`session.subAgent.started` 的 `subAgentId`（稳定标识，选中态与 v-for key 靠它；
 *     每轮会重来，所以它不带展示含义）；
 *   - `index`：同一个事件里的 `index`（本轮内从 1 起，栏目标签直接印它）。客户端不数：
 *     它要在「切到某个子 Agent」「中途接上连接」时都对得上，而那时本地没数过；
 *   - `status`：`started` 给 `running`、`ended` 与 `session.subAgent.snapshot` 给终态。
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
 *  状态源在 main 的 agent：send 只提交（快速返回），user/delta/done 全由事件回流 */
export type ChatStreamEvent =
  | { conversationId: string; type: "start" }
  /** main 确认收到用户消息（render 据此上屏，不再本地乐观插入）
   *  id 为 agent 中真实 user 消息 id（send 同步部分创建后读取） */
  | { conversationId: string; type: "user"; id: string; content: string }
  /** 一条完整消息的实时同步（chunk-parsed 的 receiver 完整状态：正文/reasoning/tool_calls/status；
   *  以及每轮结束补推的工具结果消息）。id 为 agent 中真实消息 id（v-for key 从流式开始即稳定），
   *  render 按 id 就地 upsert：有则替换、无则追加末尾 —— 事件到达顺序即消息顺序 */
  | { conversationId: string; type: "message"; id: string; message: AgentNS.Message }
  | { conversationId: string; type: "done"; messages: AgentNS.Message[] }
  /** 任务迁移完成后推送：全量替换消息。旧历史带 omit（已作废）标记，UI 展示但不进 agent 请求 */
  | { conversationId: string; type: "migrated"; messages: AgentNS.Message[] }
  | { conversationId: string; type: "error"; message: string }
  /** 自动生成对话标题后推送（不阻塞 done，侧栏据此更新名称） */
  | { conversationId: string; type: "renamed"; name: string }
  /**
   * 服务端推来的一条**通知**（`session.notice` / `server.notice`）：给用户看的一句话，瞬时的。
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
   * `server.notice` **不属于任何会话**（存档目录不可用、MCP 连不上是服务本身的事）。
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
   * 子 Agent 只活在当前一轮（`session.turnEnd` 之后服务端把它们连同展示序号一起清掉，客户端同一
   * 口径）。所以 `agents: []` 的意思是「把栏目收回去」，不是「这段会话没有子 Agent 这个
   * 概念」。render 收到空数组就清空栏目、退回主对话 —— 不能让一个标签停在一段已经过去的
   * 对话上。换会话 id（迁移 / 另存为）同样清空。
   *
   * ## 顺序
   *
   * 数组顺序 = `session.subAgent.started` 的到达顺序 = 服务端给的 `index` 顺序（栏目标签
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
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
