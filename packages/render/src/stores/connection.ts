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
 *
 * ## 还有一件事：**此刻这条连接是什么状态**（`state` / `startWatching` / `reconnect`）
 *
 * 窗口现在**先出来**、连接放到后面（D25），于是 render 挂载的那一刻连接可能还没建立。三态
 * （`ConnectionState`，D23）是那次挂载唯一能问的东西：`connecting` 就等、`ready` 就照常干活、
 * `error` 就把 `message` 显示出来并给一个「重试」。
 *
 * 重试策略本身（首次失败后 1s / 2s / 5s 三次退避）全在 main，这个 store **一行重试逻辑都没有**：
 * 它只负责「此刻是什么状态」与「用户点了重连」这两件事。
 */

import { defineStore } from "pinia";
import type { ConnectionProbe, ConnectionSettings, ConnectionState } from "@ai-zen/desktop-shared";
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
    /**
     * 此刻的连接状态（`connection:state`）；`null` = **还没查到**。
     *
     * `null` 不是一种状态，而是「还不知道」：界面在它上面显示「正在读取连接配置…」，
     * **不许**把 `null` 当成失败（否则窗口一出来就闪一下错误，而实际只是查询还没回来）。
     */
    state: null as ConnectionState | null,
    /** 用户点「重试」（`connection:reconnect`）进行中 */
    reconnecting: false,
  }),

  getters: {
    /**
     * 连接是不是**已经连上**（`ready`）。
     *
     * 界面靠它决定该不该说话：`false` → 整屏交给连接状态屏；`true` → 照常拉服务端数据。
     * `null`（还没查到）同样是 `false`：不知道的时候什么都还没开始拉。
     */
    isReady: (state): boolean => state.state?.status === "ready",

    /**
     * 「还没配过」（`unset`）—— 首启引导屏的唯一判据。
     *
     * 它与 `isReady === false` 是**两件不同的事**：那边是「正在连 / 连不上」（已经有一个目标），
     * 这边是「连一个目标都还没有」。混用会让首启落在「连接状态屏」上，而那里只有一个「重试」
     * 按钮 —— 重试的对象根本不存在。
     */
    isUnset: (state): boolean => state.state?.status === "unset",
  },

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

    /** 查一次当前连接状态（`connection:state`）：挂载时先问一遍，之后再听推送 */
    async loadState() {
      this.state = await api.getConnectionState();
    },

    /**
     * 开始盯连接状态：**先查一次，再订阅推送**，返回取消订阅函数。
     *
     * ## 顺序不能反
     *
     * main 的起始态（`connecting` / `attempt 0`）**不推送** —— 它与 `state()` 在 `start()` 之前
     * 给出的那一份逐字相同，推一遍只是噪声（见 `ConnectionController` 的 `seed()`）。于是如果
     * 先订阅、再查询，两次动作之间正好发生的那次变化就两头都漏：推送还没听上，查询拿到的是
     * 旧的。**先查、后听**反过来就安全 —— 中间的变化顶多让查询结果立刻被推送覆盖一次，
     * 不会停在旧值上。
     *
     * 只靠查询也不行：查询只回答「那一刻」，之后的变化（重试计数、连上、失败）全靠推送。
     */
    async startWatching(): Promise<() => void> {
      await this.loadState();
      return api.onConnectionState((state) => {
        this.state = state;
      });
    },

    /**
     * 手动重试一次（`connection:reconnect`）。
     *
     * 只把**返回的那一刻**（进入 `connecting`）放进 state：整轮在 main 后台跑，之后的变化靠推送
     * 继续来（`startWatching` 那条订阅一直在听）。这里**不做任何重试/退避**：那是 main 的事。
     */
    async reconnect() {
      this.reconnecting = true;
      try {
        this.state = await api.reconnectConnection();
      } finally {
        this.reconnecting = false;
      }
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
