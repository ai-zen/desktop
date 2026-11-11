/**
 * conversation store — 会话列表（按 workspace 缓存）+ 当前激活 + 运行中标记。
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
        await this.select(workspaceId, "");
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

    /**
     * 建一段会话并刷新列表。
     *
     * **不在这里顺手打开它**：「新建」与「打开」是两件事，失败也该分开说。建成了但打不开时
     * 说成「新建失败」，用户会再点一次「创建」—— 于是多出一段重复的会话（而第一段其实已经
     * 在盘上了）。所以这里只做「建 + 刷新列表」，打开哪一段由调用方接着 `select()`，那边
     * 也才知道该怎么把两件事分别说清。
     */
    async create(workspaceId: string, agentId: string) {
      const conv = await api.createConversation(workspaceId, agentId);
      await this.load(workspaceId);
      return conv;
    },

    /**
     * 选中会话，切换查看视角。
     *
     * 各会话的消息/流式状态由 chat store 按会话隔离（byConversation），
     * 首次打开才加载，已加载过的会话（含流式进行中）切回即恢复，互不覆盖。
     *
     * ## 为什么是 async、为什么调用方**必须** await
     *
     * `chatStore.activate()` 要跟服务端要一次快照（`attach` + `snapshot` 两个往返），它会抛
     * —— 会话在盘上已被删、连接断了、服务端报错。以前这里是个同步函数，`activate()` 的
     * promise 没人接：失败既不提示、也没人知道，界面上留下的是「左边选中了、消息区空白」，
     * 而那正是**最容易**被当成「这段会话本来就没有消息」的样子（甚至会被当成「消息丢了」）。
     *
     * 现在它是可等、可抛的：失败由调用方（视图）当场说清。选中态不因此回滚 —— 用户点的就是
     * 那一段，回滚等于自作主张把他挪到另一段上；「没读出来」这件事用一句话说比用一次跳转说更准。
     */
    async select(workspaceId: string, id: string): Promise<void> {
      this.activeConversationId = id;
      if (workspaceId && id) {
        this.currentWorkspaceId = workspaceId;
        await useChatStore().activate(workspaceId, id);
      } else {
        useChatStore().deactivate();
      }
    },

    async remove(workspaceId: string, id: string) {
      await api.removeConversation(workspaceId, id);
      useChatStore().remove(id);
      if (this.activeConversationId === id) await this.select(workspaceId, "");
      await this.load(workspaceId);
    },

    async rename(workspaceId: string, id: string, name: string) {
      await api.renameConversation(workspaceId, id, name);
      const c = (this.byWorkspace[workspaceId] ?? []).find((x) => x.id === id);
      if (c) c.name = name;
    },

    /** 自动命名（chat:push renamed 事件）更新缓存名称 —— 遍历所有 workspace 兜底 */
    applyRename(id: string, name: string) {
      for (const list of Object.values(this.byWorkspace)) {
        const c = list.find((x) => x.id === id);
        if (c) c.name = name;
      }
    },

    async setModel(workspaceId: string, id: string, modelId: string) {
      await api.setConversationModel(workspaceId, id, modelId);
      const c = (this.byWorkspace[workspaceId] ?? []).find((x) => x.id === id);
      if (c) c.modelId = modelId;
    },

    // ---------- 运行中标记 ----------

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
