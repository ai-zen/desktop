/**
 * chat store — 按会话隔离的聊天状态（消息/流式/错误/重试 + 子 Agent 栏目）。
 *
 * 每个 conversation 拥有独立的 byConversation[id] 槽位，切换会话只是切换视角，
 * 各会话的流式状态互不干扰（全局单 messages/streaming 会在切换时互相覆盖，
 * 导致进行中消息断裂、streaming 卡死）。
 *
 * 槽位里除了主对话，还存了**当前这一轮**的子 Agent 栏目（`agents` + `activeAgentId`）：
 * 主对话那条 `message` / `done` 事件的语义一字未动，栏目是并行的另一份数据，只影响
 * 「消息列表读哪一份」（见 getter `viewMessages`）。
 *
 * 订阅 chat:push 事件，由 App.vue 在初始化时绑定到 applyEvent。
 */

import { defineStore } from "pinia";
// 通知用 toast 弹（与设置页同一种提示）：element-plus 已在 render 的 dependencies 里
import { ElMessage } from "element-plus";
import { AgentNS } from "@ai-zen/agents-core";
import type { ChatStreamEvent, SubAgentView } from "@ai-zen/desktop-shared";
import * as api from "../apis/index.js";
import { useWorkspaceStore } from "./workspace.js";
import { useConversationStore } from "./conversation.js";
import { MAIN_AGENT_VIEW_ID, resolveActiveAgentId } from "./agentView.js";

interface ConversationChatState {
  messages: AgentNS.Message[];
  streaming: boolean;
  error: string;
  /** 最近一次发送失败的内容（重试用） */
  lastFailedContent: string;
  /**
   * 当前这一轮的子 Agent 栏目（数组顺序 = 服务端给的 `index` 顺序 = 标签顺序）。
   *
   * 只活当前一轮：`agents: []` 意味着这一轮结束（或换了会话 id），栏目收回。
   */
  agents: SubAgentView[];
  /** 现在看的是谁：`""`（`MAIN_AGENT_VIEW_ID`）= 主对话，否则是某个子 Agent 的 id */
  activeAgentId: string;
}

function emptyState(): ConversationChatState {
  return {
    messages: [],
    streaming: false,
    error: "",
    lastFailedContent: "",
    agents: [],
    activeAgentId: MAIN_AGENT_VIEW_ID,
  };
}

/**
 * 弹一条通知（`type: "notice"` 的唯一出口）。
 *
 * 三档语气对应 element-plus 的三个入口：`info` 是「顺带说一句」（迁移被跳过、交接文档
 * 落在哪），`warn` 是「这次打了折扣，但事情做完了」（交接方式降级），`error` 是「事情没做成」
 * （存档没写成功、子 Agent 挂了）。**不是** `type: "error"` 那条红色错误条 —— 那个位置
 * 留给「这一轮失败了」。
 */
function showNotice(level: "info" | "warn" | "error", text: string): void {
  if (level === "warn") ElMessage.warning(text);
  else if (level === "error") ElMessage.error(text);
  else ElMessage.info(text);
}

export const useChatStore = defineStore("chat", {
  state: () => ({
    /** 每个会话独立的聊天状态 */
    byConversation: {} as Record<string, ConversationChatState>,
    /** 当前激活的会话 id（决定 getters 取哪个槽位） */
    activeConversationId: "",
  }),

  getters: {
    /** 当前激活会话的消息（兼容旧用法；子 Agent 视图请用 `viewMessages`） */
    messages: (state): AgentNS.Message[] =>
      state.byConversation[state.activeConversationId]?.messages ?? [],
    streaming: (state): boolean =>
      state.byConversation[state.activeConversationId]?.streaming ?? false,
    error: (state): string =>
      state.byConversation[state.activeConversationId]?.error ?? "",
    lastFailedContent: (state): string =>
      state.byConversation[state.activeConversationId]?.lastFailedContent ?? "",

    /** 当前会话本轮的子 Agent 栏目（空数组 = 没有栏目，视图层据此决定栏目是否渲染） */
    agents: (state): SubAgentView[] =>
      state.byConversation[state.activeConversationId]?.agents ?? [],
    /** 当前选中项：`""` = 主对话 */
    activeAgentId: (state): string =>
      state.byConversation[state.activeConversationId]?.activeAgentId ?? MAIN_AGENT_VIEW_ID,
    /**
     * 消息列表**当前该显示的那一份**：选中主对话 = 主对话消息，选中子 Agent = 它自己的消息。
     *
     * 抽成 getter 而不是让视图自己 if：视图里 `useMessageWindow` / `useAutoScroll` 的每一个
     * watch 都要读它，散在模板和脚本里两处判断迟早会有一处漏改。
     */
    viewMessages: (state): AgentNS.Message[] => {
      const st = state.byConversation[state.activeConversationId];
      if (!st) return [];
      if (st.activeAgentId === MAIN_AGENT_VIEW_ID) return st.messages;
      // 选中项失效由 applyEvent 的 `agents` 分支当场修正，这里只是取值安全
      return st.agents.find((agent) => agent.id === st.activeAgentId)?.messages ?? st.messages;
    },
  },

  actions: {
    /**
     * 切换激活会话：同步视角 id，并**总是从服务端读取实时状态**（chat.getState → `session.snapshot`）。
     * 返回的是服务端此刻的消息（含流式进行中的回复），
     * 使前端切回流式中的会话也能看到正确的进行中内容 —— 前端始终访问服务，
     * 不持有独立状态副本。
     */
    async activate(workspaceId: string, conversationId: string) {
      this.activeConversationId = conversationId;
      const st = this.ensure(conversationId);
      // 保留重试上下文（切走再切回，失败内容仍在）
      const lastFailedContent = st.lastFailedContent;
      const state = await api.getChatState(workspaceId, conversationId);
      this.byConversation[conversationId] = {
        messages: state.messages,
        streaming: state.streaming,
        error: "",
        lastFailedContent,
        // 栏目不随重载保留：`chat.getState` 只给主对话的实时消息，没有子 Agent 的快照
        // （栏目只活当前一轮，服务端那边由 `agents: []` 收尾）。沿用旧栏目等于把上一轮/上一次
        // 会话的标签挂回来 —— 点进去是永远不再更新的残影，还可能顶着一批早已失效的消息。
        agents: [],
        activeAgentId: MAIN_AGENT_VIEW_ID,
      };
    },

    /** 取消激活（不清空缓存：切回可秒开，保留各会话流式状态） */
    deactivate() {
      this.activeConversationId = "";
    },

    /** 全局清空（工作空间切换/退出时调用，释放全部会话状态） */
    clear() {
      this.byConversation = {};
      this.activeConversationId = "";
    },

    /** 移除某会话的本地状态（删除会话时调用） */
    remove(conversationId: string) {
      delete this.byConversation[conversationId];
    },

    /** 确保槽位存在并返回（applyEvent / send 用） */
    ensure(conversationId: string): ConversationChatState {
      if (!this.byConversation[conversationId]) {
        this.byConversation[conversationId] = emptyState();
      }
      return this.byConversation[conversationId];
    },

    /**
     * 发送一条消息。
     *
     * 返回 `true` = 这一条**确实提交给了服务端**；`false` = 没发出去（没有活动工作区/会话
     * 而早退，或 invoke 层抛错）。
     *
     * 为什么要这个布尔：调用方（`ChatPanel.vue` 的 `handleSend`）要用它决定**输入框里的字
     * 留不留**。返回 `void` 时调用方无法区分「发出去了」和「根本没发」，只能先清空输入框 ——
     * 一旦早退或失败，用户敲的那段字就凭空消失了（早退连 `lastFailedContent` 都没有，因为
     * 根本没进 try，界面上连重试入口都不存在）。
     *
     * 注意这个布尔**不改变任何既有语义**：不抛错（界面靠 `st.error` + 消息气泡上的重试
     * 按钮那套在工作），`st.error` / `st.lastFailedContent` / `st.streaming` 的含义一字未动。
     */
    async send(content: string): Promise<boolean> {
      const wsStore = useWorkspaceStore();
      const convStore = useConversationStore();
      const workspaceId = wsStore.activeWorkspaceId;
      const conversationId = convStore.activeConversationId;
      // 早退：什么都没提交，明确告诉调用方「没发出去」
      if (!workspaceId || !conversationId) return false;

      const st = this.ensure(conversationId);
      st.error = "";
      st.lastFailedContent = content;
      // 只提交：user 消息上屏 / streaming 均由事件驱动（user / start），
      // render 不本地乐观插入也不自行置位 —— 状态源是常驻服务端
      try {
        await api.sendChatMessage(workspaceId, conversationId, content);
      } catch (err) {
        // 仅兜底 invoke 层异常（业务错误都走 error 事件）
        st.error = err instanceof Error ? err.message : String(err);
        st.streaming = false;
        return false;
      }
      return true;
    },

    /**
     * 重试最近一次发送失败的内容。
     *
     * 布尔值原样透传（`true` = 这次重试真的提交了），口径与 `send` 完全一致。
     */
    retry(): Promise<boolean> {
      const st = this.byConversation[this.activeConversationId];
      if (st?.lastFailedContent) {
        return this.send(st.lastFailedContent);
      }
      return Promise.resolve(false);
    },

    /**
     * 切换当前会话要看哪个子 Agent（`""` = 主对话；栏目标签的点击与 Tab 都走这里）。
     *
     * 只改**看哪一份消息**，不改发送目标：消息永远发给主对话（与 TUI 同一取舍）。
     */
    selectAgent(conversationId: string, agentId: string) {
      if (!conversationId) return;
      this.ensure(conversationId).activeAgentId = agentId;
    },

    /** 中止当前会话的生成（停止按钮；main 保留已生成部分，done 事件负责收尾） */
    async abort() {
      const conversationId = this.activeConversationId;
      if (!conversationId) return;
      try {
        await api.abortChatMessage(conversationId);
      } catch (err) {
        // 兜底：invoke 层异常（正常收尾走 done 事件）
        const st = this.ensure(conversationId);
        st.error = err instanceof Error ? err.message : String(err);
      }
    },

    // ---------- 流式事件（chat:push 订阅入口） ----------

    applyEvent(evt: ChatStreamEvent) {
      const convStore = useConversationStore();

      // 自动生成标题：无论是否当前激活，都直接更新侧栏名称
      if (evt.type === "renamed") {
        convStore.applyRename(evt.conversationId, evt.name);
        return;
      }

      // 通知：弹一条瞬时提示，**不进**会话状态。
      //
      // 为什么先于下面的 `ensure` 返回（而不是写在 switch 里）：① `server-notice` 不绑会话，
      // `evt.conversationId` 是 undefined，走 `ensure` 会凭空开一个 key 为 "undefined" 的
      // 状态槽位（那个槽位谁也不会选中，只是内存里多一份垃圾）；② 通知不是状态，本来就不该
      // 落到 `ConversationChatState` 上 —— 尤其不能碰 `error`：那是「本轮失败」的红色错误条，
      // `done` 会把它清空。通知若塞进 `error`，下一轮 `done` 就会替它销账（真正该看的那句
      // 反而没了），而它本身又会让用户以为这轮失败了。
      //
      // 为什么用 toast 而不是通知栏：桌面端还没有通知栏（做它要改布局、要新增一块交互）；
      // toast 不占位置、不改布局，设置页已经在用它。将来真做了通知栏，这里换成「写状态」即可
      // —— 调用点只有一个，换的时候不用碰别处。
      if (evt.type === "notice") {
        showNotice(evt.level, evt.text);
        return;
      }

      // 按会话更新独立槽位（不区分是否激活 —— 后台会话的流式/完成各自维护）
      const st = this.ensure(evt.conversationId);

      switch (evt.type) {
        case "start":
          st.streaming = true;
          st.error = "";
          convStore.setRunning(evt.conversationId, true);
          break;

        // 本轮用户消息上屏（id 由 main 编，只为给 v-for 一个稳定的 key；收尾那次 done 会换成服务端的真 id）
        case "user":
          st.messages.push({
            id: evt.id,
            role: AgentNS.Role.User,
            content: evt.content,
          });
          break;

        case "message": {
          // 完整消息按 id 就地 upsert：有则替换、无则追加末尾。
          // 事件到达顺序即消息顺序（流式同步 → 工具结果补推 → 下一轮），
          // v-for key 从流式开始即稳定（收尾那次 done 用服务端的全量数组换掉）。
          const idx = st.messages.findIndex((m) => m.id === evt.id);
          if (idx >= 0) {
            st.messages[idx] = evt.message;
          } else {
            st.messages.push(evt.message);
          }
          break;
        }

        case "done":
          st.messages = evt.messages;
          st.streaming = false;
          st.error = "";
          convStore.setRunning(evt.conversationId, false);
          // 刷新会话列表（消息数/更新时间，保持选中）
          this.refreshList(evt.conversationId);
          break;

        // 任务迁移完成：全量替换消息。旧历史带 omit（已作废）标记，UI 展示但不进后续请求。
        // 独立事件（不复用 done）—— GUI 变化与流式完成语义分离。
        case "migrated":
          st.messages = evt.messages;
          st.streaming = false;
          st.error = "";
          convStore.setRunning(evt.conversationId, false);
          this.refreshList(evt.conversationId);
          break;

        case "error":
          st.error = evt.message;
          st.streaming = false;
          convStore.setRunning(evt.conversationId, false);
          this.refreshList(evt.conversationId);
          break;

        // 子 Agent 栏目：**整份替换**（每次变化推全量，render 不做 diff/upsert）。
        //
        // 替换后必须立刻修正选中项：`agents: []`（这一轮结束）与「换了一批新 id」都会让原来
        // 选中的子 Agent 消失，不修正的话会话就停在一段已经不存在的子对话上 —— 界面看不出异常
        // （没有标签高亮，消息列表却还是那一份旧数据），用户只能靠再点一次「主对话」自救。
        // 修正规则（选中项还在就保持）抽在 agentView.ts 里，纯函数、可测。
        //
        // 只碰栏目，不动 `messages` / `streaming` / `error`：主对话那条线不受子 Agent 影响。
        case "agents":
          st.agents = evt.agents;
          st.activeAgentId = resolveActiveAgentId(st.agents, st.activeAgentId);
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
