/**
 * 会话服务 — 对应 render 的 apis/conversation.ts。
 *
 * 模型优先级：对话（Conversation.modelId）> Agent 定义（modelId）> 全局默认模型。
 */

import { randomUUID } from "node:crypto";
import { AgentRepository, ConfigManager } from "@ai-zen/agents-sdk";
import type {
  Conversation,
  ConversationSummary,
} from "@ai-zen/desktop-shared";
import type { ConversationRepository } from "../storage/ConversationRepository.js";

function formatTime(iso: string): string {
  const d = new Date(iso);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

export class ConversationService {
  constructor(
    private repo: ConversationRepository,
    private agentRepo: AgentRepository,
    private configManager: ConfigManager,
  ) {}

  async list(workspaceId: string): Promise<ConversationSummary[]> {
    const list = await this.repo.list(workspaceId);
    return list
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((c) => ({
        id: c.id,
        workspaceId: c.workspaceId,
        agentId: c.agentId,
        modelId: c.modelId,
        name: c.name,
        messageCount: c.messages.length,
        updatedAt: c.updatedAt,
      }));
  }

  async create(
    workspaceId: string,
    agentId: string,
  ): Promise<Conversation> {
    const agent = await this.agentRepo.read(agentId);
    const config = await this.configManager.read();
    const modelId =
      agent?.modelId ??
      config.defaultModel ??
      config.models[0]?.id ??
      "";

    const now = new Date().toISOString();
    const conversation: Conversation = {
      id: randomUUID(),
      workspaceId,
      agentId,
      modelId,
      name: `对话_${formatTime(now)}`,
      // 初始消息 = Agent 定义的预设（system + few-shot），发送后由 ChatService 全量快照更新
      messages: agent?.messages ? agent.messages.map((m) => ({ ...m })) : [],
      createdAt: now,
      updatedAt: now,
    };

    await this.repo.write(workspaceId, conversation);
    return conversation;
  }

  async read(
    workspaceId: string,
    id: string,
  ): Promise<Conversation | null> {
    return this.repo.read(workspaceId, id);
  }

  async remove(workspaceId: string, id: string): Promise<void> {
    await this.repo.delete(workspaceId, id);
  }

  async setModel(
    workspaceId: string,
    id: string,
    modelId: string,
  ): Promise<void> {
    const conversation = await this.repo.read(workspaceId, id);
    if (!conversation) throw new Error(`会话不存在: ${id}`);
    conversation.modelId = modelId;
    conversation.updatedAt = new Date().toISOString();
    await this.repo.write(workspaceId, conversation);
  }
}
