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
  | { conversationId: string; type: "renamed"; name: string };

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
