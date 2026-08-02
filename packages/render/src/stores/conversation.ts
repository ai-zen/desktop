/**
 * conversation store — 会话列表（按 workspace 缓存）+ 当前激活 + 运行中标记（D8）。
 *
 * 按 workspace 分别缓存（byWorkspace），切换工作空间不丢失已加载的会话列表；
 * getter conversations 返回「当前 workspace」的列表，向后兼容单列表用法。
 */

import { defineStore } from "pinia";
import type { ConversationSummary } from "@ai-zen/desktop-shared";
import * as api from "../apis/index.js";
import { useChatStore } from "./chat.js";

export const useConversationStore = defineStore("conversation", {
  state: () => ({
    /** 每个 workspace 的会话列表缓存 */
    byWorkspace: {} as Record<string, ConversationSummary[]>,
    /** 当前激活的 workspace（load 时更新） */
    currentWorkspaceId: "",
    activeConversationId: "",
  }),

  getters: {
    /** 当前 workspace 的会话列表（向后兼容） */
    conversations: (state): ConversationSummary[] =>
      state.byWorkspace[state.currentWorkspaceId] ?? [],

    /** 任意 workspace 的会话列表（树渲染用） */
    listOf: (state) => (workspaceId: string): ConversationSummary[] =>
      state.byWorkspace[workspaceId] ?? [],

    activeConversation: (state): ConversationSummary | undefined =>
      (state.byWorkspace[state.currentWorkspaceId] ?? []).find(
        (c) => c.id === state.activeConversationId,
      ),
  },

  actions: {
    async load(workspaceId: string) {
      const list = await api.listConversations(workspaceId);
      this.byWorkspace[workspaceId] = list;
      this.currentWorkspaceId = workspaceId;
      // 激活的会话若不在当前 workspace 列表，清空
      if (!list.some((c) => c.id === this.activeConversationId)) {
        this.select(workspaceId, "");
      }
    },

    /** 并行预载多个 workspace 的会话列表（页面加载后树即显示各 ws 的会话/可展开性/条数，不改动当前激活状态） */
    async preloadAll(workspaceIds: string[]) {
      await Promise.all(
        workspaceIds.map(async (wid) => {
          this.byWorkspace[wid] = await api.listConversations(wid);
        }),
      );
    },

    clear() {
      this.byWorkspace = {};
      this.currentWorkspaceId = "";
      this.activeConversationId = "";
      useChatStore().clear();
    },

    async create(workspaceId: string, agentId: string) {
      const conv = await api.createConversation(workspaceId, agentId);
      await this.load(workspaceId);
      this.select(workspaceId, conv.id);
      return conv;
    },

    /**
     * 选中会话，联动加载其消息。
     * workspaceId 由调用方显式传入（点击会话时上下文明确），
     * 避免跨 workspace 直接点会话时因 currentWorkspaceId 未更新而加载失败。
     */
    select(workspaceId: string, id: string) {
      this.activeConversationId = id;
      if (workspaceId && id) {
        this.currentWorkspaceId = workspaceId;
        useChatStore().load(workspaceId, id);
      } else {
        useChatStore().clear();
      }
    },

    async remove(workspaceId: string, id: string) {
      await api.removeConversation(workspaceId, id);
      if (this.activeConversationId === id) this.select(workspaceId, "");
      await this.load(workspaceId);
    },

    async rename(workspaceId: string, id: string, name: string) {
      await api.renameConversation(workspaceId, id, name);
      const c = (this.byWorkspace[workspaceId] ?? []).find((x) => x.id === id);
      if (c) c.name = name;
    },

    async setModel(workspaceId: string, id: string, modelId: string) {
      await api.setConversationModel(workspaceId, id, modelId);
      const c = (this.byWorkspace[workspaceId] ?? []).find((x) => x.id === id);
      if (c) c.modelId = modelId;
    },

    // ---------- D8：运行中标记 ----------

    setRunning(id: string, running: boolean) {
      const c = (this.byWorkspace[this.currentWorkspaceId] ?? []).find(
        (x) => x.id === id,
      );
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
