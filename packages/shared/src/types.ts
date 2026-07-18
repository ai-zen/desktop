// ==================== Workspace ====================

export interface Workspace {
  id: string;
  name: string;
  path: string; // CWD
}

// ==================== Conversation ====================

export interface ConversationSummary {
  id: string;
  workspaceId: string;
  agentId: string;
  name: string;
  messageCount: number;
  updatedAt: string;
}

export interface Conversation {
  id: string;
  workspaceId: string;
  agentId: string;
  modelId: string;
  name: string;
  messages: Message[];
  createdAt: string;
  updatedAt: string;
}

// ==================== Message ====================

export interface Message {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
}

// ==================== IPC 协议 ====================

export interface ElectronAPI {
  /** 通用服务调用：invoke(service, method, ...args) */
  invoke: (service: string, method: string, ...args: unknown[]) => Promise<unknown>;
  /** 监听主进程推送事件 */
  on: (channel: string, callback: (...args: unknown[]) => void) => void;
  /** 取消监听 */
  off: (channel: string, callback: (...args: unknown[]) => void) => void;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
