/**
 * 聊天服务 — 对应 render 的 apis/chat.ts。
 *
 * 发送消息 → 创建 Agent → 恢复历史 + 对话级模型覆盖 → 流式推送 → 全量快照落盘。
 *
 * 流式协议（chat:push 单通道，见 shared ChatStreamEvent）：
 *   start  →  delta（正文增量） →  done（全量 messages）/ error
 */

import type { AgentNS } from "@ai-zen/agents-core";
import { createAgent, createModel } from "@ai-zen/agents-sdk";
import type { ChatStreamEvent } from "@ai-zen/desktop-shared";
import type { ConversationRepository } from "../storage/ConversationRepository.js";
import type { WorkspaceRepository } from "../storage/WorkspaceRepository.js";
import type { ProviderPool } from "./ProviderPool.js";

export class ChatService {
  constructor(
    private workspaceRepo: WorkspaceRepository,
    private conversationRepo: ConversationRepository,
    private providers: ProviderPool,
    private sendEvent: (evt: ChatStreamEvent) => void,
  ) {}

  async send(
    workspaceId: string,
    conversationId: string,
    content: string,
  ): Promise<void> {
    try {
      const conversation = await this.conversationRepo.read(workspaceId, conversationId);
      if (!conversation) throw new Error(`会话不存在: ${conversationId}`);

      const workspace = await this.workspaceRepo.read(workspaceId);
      if (!workspace) throw new Error(`工作空间不存在: ${workspaceId}`);

      const provider = await this.providers.get(workspace);
      const agent = await createAgent(provider, conversation.agentId);

      // 恢复历史（消息零转换） + 对话级模型覆盖（优先级：对话 > Agent 定义 > 默认模型）
      if (conversation.messages.length > 0) {
        agent.messages = conversation.messages;
      }
      agent.model = createModel(provider, conversation.modelId);

      this.sendEvent({ conversationId, type: "start" });

      // 流式增量（正文）→ chat:push delta
      const onChunk = (chunk: AgentNS.StreamResponseData) => {
        const delta = chunk?.choices?.[0]?.delta;
        const text = delta?.content;
        if (typeof text === "string" && text.length > 0) {
          this.sendEvent({ conversationId, type: "delta", content: text });
        }
      };
      agent.events.on("chunk", onChunk);

      try {
        const messages = await agent.send(content);
        // 全量快照落盘（含 system + user + assistant + 工具消息）
        conversation.messages = messages;
        conversation.updatedAt = new Date().toISOString();
        await this.conversationRepo.write(workspaceId, conversation);
        this.sendEvent({ conversationId, type: "done", messages });
      } finally {
        agent.events.off("chunk", onChunk);
      }
    } catch (error) {
      // 错误通过事件通道通知 UI（invoke 正常返回，UI 靠 applyEvent 处理）
      this.sendEvent({
        conversationId,
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
