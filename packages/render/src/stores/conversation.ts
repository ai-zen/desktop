/**
 * conversation store — 会话列表 + 当前激活 + 运行中标记（D8）。
 */

import { defineStore } from "pinia";
import type { ConversationSummary } from "@ai-zen/desktop-shared";
import * as api from "../apis/index.js";
import { useChatStore } from "./chat.js";

export const useConversationStore = defineStore("conversation", {
  state: () => ({
    conversations: [] as ConversationSummary[],
    activeConversationId: "",
  }),

  getters: {
    activeConversation: (state): ConversationSummary | undefined =>
      state.conversations.find((c) => c.id === state.activeConversationId),
  },

  actions: {
    async load(workspaceId: string) {
      this.conversations = await api.listConversations(workspaceId);
      // 激活的会话若不在当前 workspace 列表，清空
      if (!this.conversations.some((c) => c.id === this.activeConversationId)) {
        this.select("");
      }
    },

    clear() {
      this.conversations = [];
      this.activeConversationId = "";
      useChatStore().clear();
    },

    async create(workspaceId: string, agentId: string) {
      const conv = await api.createConversation(workspaceId, agentId);
      await this.load(workspaceId);
      this.select(conv.id);
      return conv;
    },

    /** 选中会话，联动加载其消息 */
    select(id: string) {
      this.activeConversationId = id;
      if (id) {
        useChatStore().load(this.conversations.find((c) => c.id === id)?.workspaceId ?? "", id);
      } else {
        useChatStore().clear();
      }
    },

    async remove(workspaceId: string, id: string) {
      await api.removeConversation(workspaceId, id);
      if (this.activeConversationId === id) this.select("");
      await this.load(workspaceId);
    },

    async setModel(workspaceId: string, id: string, modelId: string) {
      await api.setConversationModel(workspaceId, id, modelId);
      const c = this.conversations.find((x) => x.id === id);
      if (c) c.modelId = modelId;
    },

    // ---------- D8：运行中标记 ----------

    setRunning(id: string, running: boolean) {
      const c = this.conversations.find((x) => x.id === id);
      if (c) c.running = running;
    },

    /** 某会话结束运行后，刷新其列表状态（消息数/时间） */
    async refreshConversation(workspaceId: string, id: string) {
      await this.load(workspaceId);
      // 保持选中
      this.activeConversationId = id;
    },
  },
});
