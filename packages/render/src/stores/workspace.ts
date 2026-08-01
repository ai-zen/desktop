/**
 * workspace store — 工作空间列表 + 当前激活。
 */

import { defineStore } from "pinia";
import type { Workspace } from "@ai-zen/desktop-shared";
import * as api from "../apis/index.js";
import { useConversationStore } from "./conversation.js";

export const useWorkspaceStore = defineStore("workspace", {
  state: () => ({
    workspaces: [] as Workspace[],
    activeWorkspaceId: "",
    loaded: false,
  }),

  getters: {
    activeWorkspace: (state): Workspace | undefined =>
      state.workspaces.find((w) => w.id === state.activeWorkspaceId),
  },

  actions: {
    async load() {
      this.workspaces = await api.listWorkspaces();
      this.loaded = true;
      // 预载所有 workspace 的会话列表：树加载后即显示各 ws 是否有会话、能否展开、会话条数
      await useConversationStore().preloadAll(this.workspaces.map((w) => w.id));
      // 若当前激活的 workspace 已被删除，回退到第一个
      if (!this.workspaces.some((w) => w.id === this.activeWorkspaceId)) {
        this.setActive(this.workspaces[0]?.id ?? "");
      }
    },

    async create(input: { name: string; cwd: string }) {
      const ws = await api.createWorkspace(input);
      this.workspaces.push(ws);
      this.setActive(ws.id);
      return ws;
    },

    async rename(id: string, name: string) {
      await api.renameWorkspace(id, name);
      const ws = this.workspaces.find((w) => w.id === id);
      if (ws) ws.name = name;
    },

    async remove(id: string) {
      await api.removeWorkspace(id);
      this.workspaces = this.workspaces.filter((w) => w.id !== id);
      if (this.activeWorkspaceId === id) {
        this.setActive(this.workspaces[0]?.id ?? "");
      }
    },

    /** 切换激活 workspace，联动加载其会话列表 */
    async setActive(id: string) {
      this.activeWorkspaceId = id;
      const convStore = useConversationStore();
      if (id) {
        await convStore.load(id);
      } else {
        convStore.clear();
      }
    },

    /** D3：恢复上次活跃状态 */
    async restore(workspaceId: string, conversationId: string) {
      if (this.workspaces.length === 0) return;
      const target = this.workspaces.find((w) => w.id === workspaceId) ?? this.workspaces[0];
      this.activeWorkspaceId = target.id;
      await useConversationStore().load(target.id);
      useConversationStore().select(target.id, conversationId);
    },
  },
});
