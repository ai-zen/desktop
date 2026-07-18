import type { Provider } from "@ai-zen/agents-sdk";
import { WorkspaceService } from "./workspace/workspace.service.js";
import { ConversationService } from "./conversation/conversation.service.js";
import { ChatService } from "./chat/chat.service.js";

/**
 * ServiceContext — 服务上下文，持有所有 service 实例。
 * 各 service 通过 this.context.xxxService 互相调用。
 */
export class ServiceContext {
  readonly workspaceService: WorkspaceService;
  readonly conversationService: ConversationService;
  readonly chatService: ChatService;
  readonly provider: Provider;

  constructor(provider: Provider) {
    this.provider = provider;
    this.workspaceService = new WorkspaceService(this);
    this.conversationService = new ConversationService(this);
    this.chatService = new ChatService(this);
  }
}

/**
 * ServicesManager — 通用服务调用管理器。
 *
 * 渲染进程通过 preload.invoke(service, method, ...args) 调用，
 * 主进程统一路由到对应的 service 实例。
 */
export class ServicesManager {
  private context: ServiceContext | null = null;

  async init(provider: Provider) {
    this.context = new ServiceContext(provider);
  }

  invoke(service: string, method: string, ...args: unknown[]): unknown {
    if (!this.context) throw new Error("ServicesManager not initialized");

    const key = `${service}Service` as keyof ServiceContext;
    const svc = this.context[key] as any;
    if (!svc) throw new Error(`Service '${service}' not found`);

    const fn = svc[method] as Function;
    if (!fn) throw new Error(`Method '${service}.${method}' not found`);

    return fn.call(svc, ...args);
  }
}

export const servicesManager = new ServicesManager();
