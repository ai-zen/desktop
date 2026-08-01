/**
 * chat store — 当前会话消息 + 流式状态 + 错误/重试。
 *
 * 订阅 chat:push 事件，由 App.vue 在初始化时绑定到 applyEvent。
 */

import { defineStore } from "pinia";
import { AgentNS } from "@ai-zen/agents-core";
import type { ChatStreamEvent } from "@ai-zen/desktop-shared";
import * as api from "../apis/index.js";
import { useWorkspaceStore } from "./workspace.js";
import { useConversationStore } from "./conversation.js";

export const useChatStore = defineStore("chat", {
  state: () => ({
    messages: [] as AgentNS.Message[],
    streaming: false,
    error: "",
    /** 最近一次发送失败的内容（D7 重试用） */
    lastFailedContent: "",
  }),

  actions: {
    async load(workspaceId: string, conversationId: string) {
      const conv = await api.getConversation(workspaceId, conversationId);
      this.messages = conv?.messages ?? [];
      this.error = "";
    },

    clear() {
      this.messages = [];
      this.streaming = false;
      this.error = "";
      this.lastFailedContent = "";
    },

    async send(content: string) {
      const wsStore = useWorkspaceStore();
      const convStore = useConversationStore();
      const workspaceId = wsStore.activeWorkspaceId;
      const conversationId = convStore.activeConversationId;
      if (!workspaceId || !conversationId) return;

      this.error = "";
      this.lastFailedContent = content;
      // 用户消息立即上屏（main 的 agent.send 内部也会写入，done 全量替换时保留这份）
      this.messages.push({ role: AgentNS.Role.User, content });
      this.streaming = true;

      try {
        await api.sendChatMessage(workspaceId, conversationId, content);
      } catch (err) {
        this.error = err instanceof Error ? err.message : String(err);
        this.streaming = false;
      }
    },

    /** D7：重试最近一次失败的内容 */
    retry() {
      if (this.lastFailedContent) {
        return this.send(this.lastFailedContent);
      }
    },

    // ---------- 流式事件（chat:push 订阅入口） ----------

    applyEvent(evt: ChatStreamEvent) {
      const convStore = useConversationStore();
      const isActive = evt.conversationId === convStore.activeConversationId;

      if (!isActive) {
        // 非当前会话：仅维护运行中标记（D8），不渲染
        if (evt.type === "start") {
          convStore.setRunning(evt.conversationId, true);
        } else if (evt.type === "done" || evt.type === "error") {
          convStore.setRunning(evt.conversationId, false);
          const wsId = useWorkspaceStore().activeWorkspaceId;
          if (wsId) void convStore.refreshConversation(wsId, evt.conversationId);
        }
        return;
      }

      switch (evt.type) {
        case "start":
          this.streaming = true;
          this.error = "";
          break;

        case "delta": {
          const last = this.messages.at(-1);
          if (last && last.role === AgentNS.Role.Assistant && last.status !== AgentNS.MessageStatus.Error) {
            // 累积到当前 assistant 消息（思考 + 正文都作为 delta 流入）
            last.content = (typeof last.content === "string" ? last.content : "") + evt.content;
          } else {
            this.messages.push({ role: AgentNS.Role.Assistant, content: evt.content });
          }
          break;
        }

        case "done":
          this.messages = evt.messages;
          this.streaming = false;
          this.error = "";
          // 刷新会话列表（消息数/更新时间，保持选中）
          this.refreshList(evt.conversationId);
          break;

        case "error":
          this.error = evt.message;
          this.streaming = false;
          this.refreshList(evt.conversationId);
          break;
      }
    },

    /** 刷新当前 workspace 的会话列表（消息数/排序），保持选中 */
    refreshList(conversationId: string) {
      const wsId = useWorkspaceStore().activeWorkspaceId;
      if (wsId) void useConversationStore().refreshConversation(wsId, conversationId);
    },
  },
});
