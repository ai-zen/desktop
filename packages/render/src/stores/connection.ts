/**
 * connection store — 「连本地 / 连远程」这块面板的状态。
 *
 * 分工：render 侧的一切服务端数据（Agent / 模型 / 工作区 / 会话）都来自**当前那条连接**，
 * 而「连接本身」是 main 的事（`connection:get` / `save` / `test` 三条专用通道，见 D20）。
 * 这个 store 只做三件事：把 main 上的配置读上来、把用户改的值交回去、把「试连」的结果按住给人看。
 *
 * ## `test` 与 `save` 是两件完全不同的事（这块最容易被写错的一点）
 *
 * - `test(candidate)` **只探测**：不落盘、不碰当前连接、不动界面上的任何数据。它回答的是
 *   「这个地址此刻能不能连上」，回答完就完了 —— 用户在面板里填了个地址点「测试连接」，
 *   服务端那边什么都不会变，当前会话、Agent 列表、工作区树一个都不该动。
 * - `save(next)` **换连接**：main 先落盘、再 dispose 旧层、再按新配置新建并 start（D18）。
 *   于是 render 手上的一切服务端数据都成了**上一台机器**的，保存成功后必须在这里重拉、
 *   把当前会话切回「无」（见 `refreshServerData`）。
 *
 * 两者混起来的后果很具体：测试按钮顺手把界面刷了（数据没变却闪一下，还白丢一次当前选中），
 * 或者保存按钮只落了盘（侧栏还挂着上一台的会话，点进去是一次永远失败的拉取）。
 */

import { defineStore } from "pinia";
import type { ConnectionProbe, ConnectionSettings } from "@ai-zen/desktop-shared";
import * as api from "../apis/index.js";
import { useUiStore } from "./ui.js";
import { useWorkspaceStore } from "./workspace.js";
import { useConversationStore } from "./conversation.js";

export const useConnectionStore = defineStore("connection", {
  state: () => ({
    /** main 上当前生效的配置（`connection:get` 读到的那一份）—— 面板打开时以它为准 */
    settings: { mode: "local" } as ConnectionSettings,
    /** 最近一次「测试连接」的结果；`null` = 还没测过（或已 `resetProbe`） */
    probe: null as ConnectionProbe | null,
    /** 「保存并重连」进行中 */
    saving: false,
    /** 「测试连接」进行中 */
    testing: false,
  }),

  actions: {
    /**
     * 读 main 上的当前配置。
     *
     * main 那边**每次现读盘**（不用内存里的那份）：这份文件在排障时会被手改，而「面板里显示的」
     * 必须是盘上那一份，否则用户改完文件、重新打开面板，看到的还是个旧值。
     */
    async load() {
      this.settings = await api.getConnectionSettings();
    },

    /**
     * 保存并**立即重建连接**（D18）。
     *
     * 成功返回后 `settings` 就是 main 真正生效的那份配置，界面上的服务端数据也已经换成新机器
     * 的了（`refreshServerData`）。
     *
     * 失败**照原样抛**，不在这里吞：界面必须能显示「没保存成功」。main 那边落盘失败时一个字段
     * 都不会动连接（否则就成了「面板显示远程、实际还连着本地」那种最难查的状态），所以这里也
     * 一个字段都不改 —— `finally` 只负责放下 `saving`。
     */
    async save(next: ConnectionSettings) {
      this.saving = true;
      try {
        const saved = await api.saveConnectionSettings(next);
        this.settings = saved.settings;
        // 上一次的探测结果说的是「换之前那条链路」，换完就不再代表当前状态了
        this.probe = null;
        await this.refreshServerData();
      } finally {
        this.saving = false;
      }
    },

    /**
     * 用**候选值**试连一次（D19）：不落盘、不影响当前连接、不动任何服务端数据。
     *
     * 先清掉上一次的结果再测：否则「正在测新地址」的那几秒里，界面上还挂着上一个地址的成功 /
     * 失败结论，用户会以为新地址也是那个结论。
     */
    async test(candidate: { serverUrl: string; serverToken?: string }) {
      this.testing = true;
      this.probe = null;
      try {
        this.probe = await api.testConnection(candidate);
      } finally {
        this.testing = false;
      }
    },

    /** 清掉探测结果（切回「本地」时调用：那句话说的是某个远程地址，与本地已经无关了） */
    resetProbe() {
      this.probe = null;
    },

    /**
     * 换连接之后，把「来自服务端的一切」重新拉一遍。
     *
     * 全部用各 store **已有的**方法拼出来，没有为这件事新增任何语义：
     *   ① `conversation.clear()` —— 丢掉上一台的会话缓存（`byWorkspace`）与当前激活会话，
     *      它内部还会调 `chat.clear()`，把按会话隔离的消息槽位一起清掉。这一步不能省：
     *      不清的话侧栏还挂着上一台的会话，点进去是一次永远失败的拉取，而 chat 那边还留着
     *      另一台机器的消息；
     *   ② `ui.loadOptions()` —— Agent / 模型列表（新建对话的下拉、模型选择都靠它）；
     *   ③ `workspace.load()` —— 工作区列表重拉，内部还会 `preloadAll` 各工作区的会话列表
     *      （侧栏那棵树），激活的工作区在新服务端上不存在时它会自己回退到第一个；
     *   ④ `workspace.setActive(当前激活项)` —— 重拉**当前工作区**的会话列表并把当前会话切回
     *      「无」（`load` 在列表里找不到 `""` 这个 id，会走 `select(ws, "")` 复位）。
     *      ③ 只在「激活的工作区失效」时才调 `setActive`，正常情况它不重设 `currentWorkspaceId`，
     *      而 ① 已经把它清成 `""` 了 —— 不补这一句，界面就会「工作区选中了、会话列表却是空」。
     */
    async refreshServerData() {
      const uiStore = useUiStore();
      const workspaceStore = useWorkspaceStore();
      const conversationStore = useConversationStore();

      conversationStore.clear();
      await uiStore.loadOptions();
      await workspaceStore.load();
      await workspaceStore.setActive(workspaceStore.activeWorkspaceId);
    },
  },
});
