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
import type {
  AttachmentInput,
  AttachmentOutcome,
  ChatStreamEvent,
  StreamPhase,
  SubAgentView,
} from "@ai-zen/desktop-shared";
import * as api from "../apis/index.js";
import { useWorkspaceStore } from "./workspace.js";
import { useConversationStore } from "./conversation.js";
import { MAIN_AGENT_VIEW_ID, resolveActiveAgentId } from "./agentView.js";
import { visibleMessages } from "./messageVisibility.js";

interface ConversationChatState {
  messages: AgentNS.Message[];
  streaming: boolean;
  error: string;
  /** 最近一次发送失败的内容（重试用） */
  lastFailedContent: string;
  /**
   * 服务端给的生成六态（连上 / 等首字 / 在想 / 在输出 / 拼工具调用 / 等工具）。
   *
   * `null` = 这一轮不在跑。取值一字未改来自服务端，render 不自己推（「现在算哪一态」是服务端的
   * 事实，PRD L8）。
   */
  phase: StreamPhase | null;
  /** 「在等哪几个工具」：并行时只含还在跑的那几个，core 的 `ToolCall` 原样（要名字读 `function.name`） */
  toolCalls: AgentNS.ToolCall[];
  /**
   * 当前这一轮的子 Agent 栏目（数组顺序 = 服务端给的 `index` 顺序 = 标签顺序）。
   *
   * 只活当前一轮：`agents: []` 意味着这一轮结束（或换了会话 id），栏目收回。
   */
  agents: SubAgentView[];
  /** 现在看的是谁：`""`（`MAIN_AGENT_VIEW_ID`）= 主对话，否则是某个子 Agent 的 id */
  activeAgentId: string;
  /**
   * 用户消息 id → 那一轮各附件的结局（`attachments` 事件给的那份）。
   *
   * 按**消息 id** 存而不是按轮次序号：那个 id 在 `done` 的全量替换里是同一个（服务端受理时就定了，
   * L6），所以气泡在流式转完成之后还能找回自己的那几行字。键是服务端分配的值，客户端不数轮次
   * （切会话、重连补拉都数不出对的那一个）。
   */
  attachments: Record<string, AttachmentOutcome[]>;
}

function emptyState(): ConversationChatState {
  return {
    messages: [],
    streaming: false,
    error: "",
    lastFailedContent: "",
    phase: null,
    toolCalls: [],
    agents: [],
    activeAgentId: MAIN_AGENT_VIEW_ID,
    attachments: {},
  };
}

/**
 * 六态 → 正在生成那行字。
 *
 * 这一张表是**界面用词**（怎么说），六态本身是服务端的事实（是什么）—— 两者不混：服务端改了态，
 * 这里补一行；这里改了词，服务端一行不用动。
 */
const PHASE_TEXT: Record<StreamPhase, string> = {
  connected: "正在等待响应…",
  awaiting_first_token: "正在等待首个字…",
  thinking: "正在思考…",
  generating: "正在输出…",
  assembling_tool_calls: "正在准备工具调用…",
  awaiting_tools: "正在等待工具结果…",
};

/**
 * 弹一条通知（`type: "notice"` 的唯一出口）。
 *
 * 三档语气对应 element-plus 的三个入口：`info` 是「顺带说一句」（迁移被跳过、交接文档
 * 落在哪），`warning` 是「这次打了折扣，但事情做完了」（交接方式降级），`error` 是「事情没做成」
 * （存档没写成功、子 Agent 挂了）。**不是** `type: "error"` 那条红色错误条 —— 那个位置
 * 留给「这一轮失败了」。
 */
function showNotice(level: "info" | "warning" | "error", text: string): void {
  if (level === "warning") ElMessage.warning(text);
  else if (level === "error") ElMessage.error(text);
  else ElMessage.info(text);
}

/**
 * 按 id 就地 upsert：有则替换、无则追加末尾。
 *
 * `user` 与 `message` 两条事件共用这一条规则：它们给的都是「这条消息此刻完整的样子」
 * （core 的 `AgentNS.Message`），区别只在于一条是用户那句、一条是正在写的那条。两套合并
 * 规则各说各话，就会在「上一轮的消息回流晚了」这种时候多画一条。
 */
function upsert(messages: AgentNS.Message[], message: AgentNS.Message): void {
  const index = messages.findIndex((item) => item.id === message.id);
  if (index >= 0) messages[index] = message;
  else messages.push(message);
}

export const useChatStore = defineStore("chat", {
  state: () => ({
    /** 每个会话独立的聊天状态 */
    byConversation: {} as Record<string, ConversationChatState>,
    /** 当前激活的会话 id（决定 getters 取哪个槽位） */
    activeConversationId: "",
  }),

  getters: {
    /**
     * 当前激活会话的消息 —— **服务端给的那一份原始数据**（`hidden` 的也在里面）。
     * 要拿去显示请读 `viewMessages`（它已经把 `hidden` 滤掉了）
     */
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
    /**
     * 正在生成那行字（六态 + 在等的工具名）。
     *
     * 没在跑时是空串（视图那边 v-show 不看它，看 `streaming`）；拿到了态就按 `PHASE_TEXT` 说，
     * 连态都没拿到时用一句中的「正在思考…」—— 服务端确实还没报态，界面不该停在一片空白上。
     *
     * 工具名是**界面层**从 core 的 `ToolCall` 里取 `function.name` 拼的句子：服务端给的是那几个
     * 调用本身（名字、参数、id 都在），怎么念是这一层的事。
     */
    streamingHint: (state): string => {
      const st = state.byConversation[state.activeConversationId];
      if (!st) return "";
      const base = st.phase ? PHASE_TEXT[st.phase] : "正在思考…";
      // 并行工具只念还在跑的那几个（PRD L8：已经跑完的不该还挂在「在等」里）
      const names = st.toolCalls
        .map((toolCall) => toolCall.function?.name)
        .filter((name): name is string => Boolean(name));
      return names.length > 0 ? `${base}（${names.join("、")}）` : base;
    },
    /** 当前选中项：`""` = 主对话 */
    activeAgentId: (state): string =>
      state.byConversation[state.activeConversationId]?.activeAgentId ?? MAIN_AGENT_VIEW_ID,
    /**
     * 用户消息 id → 附件结局（气泡按消息 id 取自己那几行字）。
     *
     * 只给当前会话这一份：`messages` 也是这么取的（切会话就是换个槽位）。
     */
    attachmentOutcomes: (state): Record<string, AttachmentOutcome[]> =>
      state.byConversation[state.activeConversationId]?.attachments ?? {},
    /**
     * 消息列表**当前该显示的那一份**：选中主对话 = 主对话消息，选中子 Agent = 它自己的消息。
     *
     * 抽成 getter 而不是让视图自己 if：视图里 `useMessageWindow` / `useAutoScroll` 的每一个
     * watch 都要读它，散在模板和脚本里两处判断迟早会有一处漏改。
     *
     * 这里同时是 `hidden` 的**唯一**过滤点：服务端建会话时写进去的那条（当前目录那类）
     * `hidden: true`，它不进任何一份要显示的列表（主对话、子 Agent 一视同仁）。过滤放在这里
     * 而不是放在气泡组件里，是因为「显示哪些」在下面那串 watch（渲染窗口起点、滚动跟随、
     * 打字机跟随）里也要用到同一个结果 —— 各自滤一遍，窗口的 index 就会指向两份长度不同的数组。
     * 存着的 `messages` 保持原样（服务端给什么就存什么），重连补拉与重试读的仍是那一份。
     */
    viewMessages: (state): AgentNS.Message[] => {
      const st = state.byConversation[state.activeConversationId];
      if (!st) return [];
      const picked =
        st.activeAgentId === MAIN_AGENT_VIEW_ID
          ? st.messages
          : // 选中项失效由 applyEvent 的 `agents` 分支当场修正，这里只是取值安全
            (st.agents.find((agent) => agent.id === st.activeAgentId)?.messages ?? st.messages);
      return visibleMessages(picked);
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
        // 六态不随重载保留：`chat.getState` 只回「在不在跑」，那一刻处在哪一态由服务端后续的
        // `run.state` 推来（推来之前就用一句中的「正在思考…」）
        phase: null,
        toolCalls: [],
        // 栏目不随重载保留：`chat.getState` 只给主对话的实时消息，没有子 Agent 的快照
        // （栏目只活当前一轮，服务端那边由 `agents: []` 收尾）。沿用旧栏目等于把上一轮/上一次
        // 会话的标签挂回来 —— 点进去是永远不再更新的残影，还可能顶着一批早已失效的消息。
        agents: [],
        activeAgentId: MAIN_AGENT_VIEW_ID,
        // 附件结局也不随重载保留：`chat.getState` 只说「现在有哪些消息」，服务端不重发某一轮的
        // 附件结局（那是一次性的受理回执）。留着旧的那份会跟上一批气泡错位。
        attachments: {},
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
     * 发送一条消息（可带图片附件）。
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
     *
     * ## 附件怎么走
     *
     * 这里只把字节交出去（`api.sendChatMessage` → main），**不本地乐观插入缩略图**：附件最后是
     * 文件引用、内联、还是退化成文字，只有服务端知道（F-H7），结局走 `attachments` 事件。重试（
     * `retry`）只重发文字：上传已经在 main 做过一次，带着同一批字节再传一遍会多出一份素材。
     */
    async send(content: string, attachments?: AttachmentInput[]): Promise<boolean> {
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
        await api.sendChatMessage(workspaceId, conversationId, content, attachments);
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
      // 为什么先于下面的 `ensure` 返回（而不是写在 switch 里）：① 全局通知不绑会话
      // （`conversationId` 是 `null`），走 `ensure` 会凭空开一个 key 为 "null" 的
      // 状态槽位（那个槽位谁也不会选中，只是内存里多一份垃圾）；② 通知不是状态，本来就不该
      // 落到 `ConversationChatState` 上 —— 尤其不能碰 `error`：那是「本轮失败」的红色错误条，
      // `done` 会把它清空。通知若塞进 `error`，下一轮 `done` 就会替它销账（真正该看的那句
      // 反而没了），而它本身又会让用户以为这轮失败了。
      //
      // 为什么用 toast 而不是通知栏：桌面端还没有通知栏（做它要改布局、要新增一块交互）；
      // toast 不占位置、不改布局，设置页已经在用它。将来真做了通知栏，这里换成「写状态」即可
      // —— 调用点只有一个，换的时候不用碰别处。
      //
      // 显示的是服务端已渲染好的那一句（`text.message`，按这条连接的语言）；三档语气与服务端的
      // `level` 逐字对应，不在这里另译一套词。
      if (evt.type === "notice") {
        showNotice(evt.level, evt.text.message);
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

        // 生成六态（服务端 `run.state` 翻过来的那一条）：只影响「正在生成」那行字，
        // 不动消息与流式态 —— 六态变化不是「一轮开始 / 结束」
        case "stream":
          st.phase = evt.phase;
          st.toolCalls = evt.toolCalls;
          break;

        // 这一轮各附件的结局：按用户消息 id 存着，气泡自己去取（文案是服务端/客户端库
        // 渲染好的原文，这里一个字都不改 —— 怎么摆是 `attachmentNotes` 的事）
        case "attachments":
          st.attachments[evt.userMessageId] = evt.attachments;
          break;

        // 本轮用户消息上屏（载荷是服务端落库的那条消息本体：带图那句在库里是内容段数组）
        case "user":
          upsert(st.messages, evt.message);
          break;

        case "message":
          // 完整消息按 id 就地 upsert：有则替换、无则追加末尾。
          // 事件到达顺序即消息顺序（流式同步 → 工具结果补推 → 下一轮），
          // v-for key 从流式开始即稳定（收尾那次 done 用服务端的全量数组换掉）。
          upsert(st.messages, evt.message);
          break;

        case "done":
          st.messages = evt.messages;
          st.streaming = false;
          st.error = "";
          st.phase = null;
          st.toolCalls = [];
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
          st.error = evt.problem.message;
          st.streaming = false;
          st.phase = null;
          st.toolCalls = [];
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
