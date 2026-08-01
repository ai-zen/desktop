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
  /** 对话级局部模型参数，覆盖 Agent 定义（优先级：对话 > Agent 定义 > 全局默认） */
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
  /** 对话级局部模型参数 */
  modelId: string;
  name: string;
  messageCount: number;
  updatedAt: string;
  /** D8：会话运行中标记（侧栏显示） */
  running?: boolean;
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

// ==================== 推送事件 DTO ====================

/** chat:push 单通道推送（discriminated union） */
export type ChatStreamEvent =
  | { conversationId: string; type: "start" }
  | { conversationId: string; type: "delta"; content: string }
  | { conversationId: string; type: "done"; messages: AgentNS.Message[] }
  | { conversationId: string; type: "error"; message: string };

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
  /** 窗口控制 */
  window: WindowControls;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
