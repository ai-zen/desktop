/**
 * 宿主推送 → render 的 `ChatStreamEvent`（`packages/shared/src/types.ts`）。
 *
 * ## 这一层只做「分发」，不改形状
 *
 * 新契约的推送只有 6 条（`packages/host/src/wire/events.ts`），而且刻意只描述「发生了什么变化」：
 *
 * | 宿主事件 | 这里发成 | 说明 |
 * |---|---|---|
 * | `message.delta` | `message` | 增量按 core 的 `applyChunk` 拼进那条助手消息，整条 `AgentNS.Message` 原样递下去（见 `stream.ts`） |
 * | `run.state` | `stream` + `done` / `error` | 六态名与正在跑的工具（core 的 `ToolCall`）原样搬；`settled` 时按 `message.list` 收尾 |
 * | `usage` | `message` | 本轮用量（core 的 `Usage`）钉到那条助手消息上（render 按 id 整条替换） |
 * | `notice` | `notice` | 语气、时长、`LocalizedText`、归属会话全原样搬（PRD D8） |
 * | `question` | `question` | 整份 `QuestionView` 原样搬（见下） |
 * | `conversation.changed` | `renamed` | 名字要从 `conversation.get` 现拉，推送里只有「改名了」 |
 *
 * 承载消息/内容的地方一律是 core 的原始形状（`AgentNS.Message` / `MessageContentSection` /
 * `ToolCall` / `Usage`）或宿主那份结构（`LocalizedText` / `ProblemFact`）：任何「把结构揉成
 * 一句字」的转换都不在这一层做（R75）。
 *
 * ## 为什么收尾一定要回宿主拉一份
 *
 * `run.state` 只说「这一轮结束了、结局是什么」，**不带消息**。而客户端拼出来的那条只是「能让屏幕
 * 滚起来的近似」：工具调用参数、消息 `status`（`completed` / `aborted` / `error`）、宿主对历史的
 * 清洗都只有库里有。所以 `settled` 之后补一次 `message.list`，把整段消息推成 `done` ——
 * render 的 `done` 本来就是「全量替换」，一条不缺。
 *
 * 同理，用户消息上屏前也回宿主取一次：带图那句在库里是内容段数组，手上只有用户敲的那几个字。
 *
 * ## 问题对象原样递下去（不压成一句话）
 *
 * `question` 是宿主的产品对象（交接线、不可撤销的动作前确认，PRD D22）：`prompt` / `options[]`
 * / `blocking` / `state` / `kind` 每一样都是界面要用的事实。压成一句 `prompt.message` 之后，
 * 用户没法作答（候选没了）、输入区不知道要挡（`blocking` 没了）、也答不回去（`id` 没了）——
 * 而**没人答的题宿主不会超时**，于是那道题会把这段对话永久锁死（PRD D23：后续每次
 * `conversation.send` 都被 `question_pending` 拒）。
 *
 * 所以这里只搬运、不改形状：`QuestionView` 整份推给 render，怎么摆是 render 的事。
 *
 * ## 重连之后为什么还要再推一遍
 *
 * 推送不重放（PRD L5）。断了再连上时，render 不会重新打开对话（它只等补拉的结果），于是
 * **断线期间挂上的题**只能靠这条路回来：`onResume` 拿到的 `state.questions` 是宿主那一刻的
 * 完整清单（含已经被别的一端答掉的那些），逐条推成 `question`。render 按 id 并入本地那份，
 * 所以这里不必去重、也不必判「本端有没有见过」—— 同一份事实推两次的结果是一样的。
 *
 * 反方向（推送比快照早到）同样是安全的：快照只补它自己那些，render 那份是**并**不是**换**。
 *
 * ## 断线：重连 + 补拉都归客户端库
 *
 * 推送不重放、不需要 ack（PRD L5）。连上之后 `Client` 自己按 `track` 过的对话补拉
 * （`conversation.state` + `message.list({after})`），结果从 `onResume` 回到这里 —— 所以这个文件
 * 里没有任何「补发」或「对齐历史」的记账。
 */

import type {
  AgentNS,
  ClientError,
  ConversationState as WireConversationState,
  EventPayload,
  ResumedConversation,
  ResumeOutcome,
  RunState,
} from "@ai-zen/agents-client";
import { DEFAULT_RECONNECT_POLICY, mergeResumed, reconnectUntilConnected } from "@ai-zen/agents-client";
// 消息本体是 core 的形状：乐观回显那一条要现造一个 user 消息，`Role` 只有 core 这边的值
// （客户端库只转出类型，见它的 `index.ts`）
import { AgentNS as CoreNS } from "@ai-zen/agents-core";
import type { ChatStreamEvent, AttachmentOutcome, ProblemFact, StreamPhase } from "@ai-zen/desktop-shared";
import type { ContractCall, ContractConnection } from "./contract.js";
import { localText, problemOf } from "./problem.js";
import { StreamingMessage } from "./stream.js";

/** 断线之后最多再敲几次门（连不上就不假装还在连：留一条通知给人看） */
const RECONNECT_POLICY = { ...DEFAULT_RECONNECT_POLICY, maxAttempts: 5 };

/**
 * 「这一句排进了正在跑的那一轮」的提示（`echoQueuedSend` 里说的那句）。
 *
 * 是本进程自己的话，不是宿主给的：宿主对排队受理不发任何事件。桌面端的界面文案全是中文
 * （`packages/main/src/language.ts`：桌面端没有语言开关），所以这句也照旧写中文、只写一句。
 */
const QUEUED_SEND_NOTICE = "已排队，会在当前这一轮的工具轮结束后送出。";

export interface ChatEventBridgeOptions {
  /** 发一次契约方法（收尾要的 `message.list`、改名后要的 `conversation.get`） */
  call: ContractCall;
  /** 推给 render（桌面端 = `webContents.send("chat:push")`） */
  push: (event: ChatStreamEvent) => void;
  /** 日志出口（缺省 `console.info`）；只说事，不带凭证 */
  log?: (message: string) => void;
}

export class ChatEventBridge {
  /** 当前这条连接（`attach` 时装上；`dispose` 后为空） */
  private connection: ContractConnection | null = null;
  /** 挂在这条连接上的订阅（整组换 / 整组摘：连接换了就重订一遍） */
  private readonly unsubscribes: Array<() => void> = [];

  /** 对话 → 正在拼的那条助手消息 */
  private readonly streams = new Map<string, StreamingMessage>();
  /** 对话 → 本地已知的整段消息（补拉时按 `after` 做续传合并：`mergeResumed` 需要一个本地基线） */
  private readonly messages = new Map<string, AgentNS.Message[]>();
  /** 对话 → 最近一次 `run.state`（六态、结局、正在跑的工具都在里面） */
  private readonly runs = new Map<string, RunState>();
  /** 对话 → 已经推给 render 的那份六态签名（没变就不推，见 `pushPhase`） */
  private readonly pushedPhase = new Map<string, string>();
  /** 对话 → 这一轮是否已经推过 `start`（推过就不再推：`start` 是「进入流式态」，不是「每一片」） */
  private readonly started = new Set<string>();
  /** 对话 → 最近一次收尾用的标记（同一轮只收一次） */
  private readonly settled = new Map<string, string>();

  private readonly log: (message: string) => void;

  constructor(private readonly options: ChatEventBridgeOptions) {
    this.log = options.log ?? ((message: string) => console.info(message));
  }

  // ==================================================================
  // 装 / 卸
  // ==================================================================

  /**
   * 在新连接上挂好六条事件 + 断线 + 补拉。
   *
   * 订阅挂在**连接对象**上（不是某条 socket）：客户端库重连时换的是底层 socket，这个对象不变，
   * 所以订阅不必重挂 —— 这也是它比「每次重连重订一遍」更不容易漏的原因。
   */
  attach(connection: ContractConnection): void {
    this.dispose();
    this.connection = connection;
    this.unsubscribes.push(
      connection.subscribe("run.state", (payload) => this.onRunState(payload)),
      connection.subscribe("message.delta", (payload) => this.onDelta(payload)),
      connection.subscribe("usage", (payload) => this.onUsage(payload)),
      connection.subscribe("notice", (payload) => this.onNotice(payload)),
      connection.subscribe("question", (payload) => this.onQuestion(payload)),
      connection.subscribe("conversation.changed", (payload) => this.onChanged(payload)),
      connection.onClose((error) => this.onClose(error)),
      connection.onResume((outcome) => this.onResume(outcome)),
    );
  }

  /** 摘掉订阅（连接本身由建它的那一层负责关） */
  dispose(): void {
    for (const off of this.unsubscribes.splice(0)) off();
    this.connection = null;
  }

  // ==================================================================
  // 从其它方向喂进来的事实
  // ==================================================================

  /**
   * 一次发送被受理（`conversation.send` 回来了）：立刻把用户消息与「开始了」推给 render。
   *
   * `start` 当场推（这一轮已经在跑了），用户消息那条要回宿主取一次：**消息本体在库里**
   * （手上那句 `content` 只是文字，带图那一句在库里是 `image_url` 内容段数组）。把手上那句
   * 字符串当成消息上屏，就等于把「宿主拼出来的那几个内容段」换成了「用户敲的那几个字」。
   *
   * id 是宿主在受理时分配的（PRD L6 / F-I12），所以这里回显的 id 与 `done` 全量替换里
   * 那一条是同一个 —— 不会画成两条。
   */
  async beginTurn(conversationId: string, userMessageId: string): Promise<void> {
    this.markStarted(conversationId);
    const listed = await this.options.call("message.list", { conversationId });
    const message = listed.messages.find((item) => item.id === userMessageId);
    if (!message) throw new Error(`受理回执里的用户消息 ${userMessageId} 不在 message.list 里`);
    this.push({ conversationId, type: "user", message });
  }

  /**
   * 一句用户输入排进了**正在跑的那一轮**（`conversation.send` 回了 `queued: true`，PRD D3）。
   *
   * ## 为什么这一条不走 `beginTurn`
   *
   * 排队那句要等这一轮的**轮末**才落库，此刻 `message.list` 里根本没有它 —— 而 `beginTurn` 干的
   * 正是回宿主按 id 取那条消息，取不到就抛。于是宿主明明已经收下（会送出），界面上却弹一条
   * error 气泡。
   *
   * ## 回显用宿主给的 id，手上这句原样上屏
   *
   * id 是宿主在**入队那一刻**就定死的（D5），与轮末落库那条是同一个；render 按 id upsert
   * （有则替换、无则追加），所以几秒后库里那条到达时是**替换**（内容段数组、图片跟着补上），
   * 不会画成两条。这也是它敢用「手上这句正文」的原因：这条消息只活到轮末，之后以宿主那份为准。
   *
   * 内容只能用手上这句：宿主怎么把文字与 `assetIds` 拼成内容段（文件引用 / 内联 / 退化成文字）
   * 要等落库才算数，这里没有第二份、也不该猜一份。带图的那句在轮末那条到达之前只显示文字；
   * 附件各自的结局照常按 `userMessageId` 推（见 `pushAttachments`），所以「图到底发出去没有」
   * 当场就能看见。
   *
   * ## 为什么不推 `start`
   *
   * `start` 说的是「这一轮开始了」（render 拿它切流式态、清错误条）。排队的前提是这一轮**本来
   * 就在跑**，没有新的一轮 —— 再推一次等于替一段已经在跑的轮次重开现场。
   *
   * ## 那句提示只能由这里说
   *
   * 宿主对排队不发专门的事件 —— 它在 `run.state` 里给的是条目数组 `run.inbox`（每条含
   * `messageId` / `source` / `createdAt` / `preview` 一行摘要），排队条目落成消息时数组少一条、
   * 同时推一次 `run.state`。于是「这句会晚一步送出」没有别的来源。不说的话，界面看上去就是
   * 「点了发送、什么都没发生」。
   */
  echoQueuedSend(conversationId: string, userMessageId: string, content: string): void {
    this.push({
      conversationId,
      type: "user",
      message: { id: userMessageId, role: CoreNS.Role.User, content },
    });
    this.pushNotice("info", QUEUED_SEND_NOTICE, conversationId);
  }

  /** `chat.getState` 拿到的基线消息（补拉合并要有它） */
  noteMessages(conversationId: string, messages: AgentNS.Message[]): void {
    this.messages.set(conversationId, [...messages]);
  }

  /**
   * `chat.getState` 拿到的现场状态（六态跟着它走，界面切回来就不再是「什么都没在跑」）。
   *
   * 这一份里的 `questions` **不在这里推**：`chat.getState` 的返回值本来就带着它（render 打开
   * 对话时拿到的就是那份），再推一遍等于同一份事实说两次。补拉那条路不一样 —— 那里没有返回值，
   * 所以 `onResume` 会把问题逐条推出去。
   */
  noteState(state: WireConversationState): void {
    this.runs.set(state.conversationId, state.run);
    this.pushPhase(state.conversationId, state.run);
  }

  /** 直接推一条 `error`（`chat.send` 自己的失败出口：不让 IPC 抛错，错误条由事件驱动） */
  pushError(conversationId: string, problem: ProblemFact): void {
    this.push({ conversationId, type: "error", problem });
  }

  /**
   * 推一条「这一轮各附件的结局」（`conversation.send` 回来的逐张账，已与宿主给的合并）。
   *
   * 空数组不发：没带附件的那一轮根本没有这件事，推一个空列表只会让界面多一次无意义的写入。
   * 跟着 `userMessageId` 走，是因为气泡按消息 id 找自己的结局（那个 id 在 `done` 的全量替换里
   * 不变，L6）。
   */
  pushAttachments(
    conversationId: string,
    userMessageId: string,
    attachments: AttachmentOutcome[],
  ): void {
    if (attachments.length === 0) return;
    this.push({ conversationId, type: "attachments", userMessageId, attachments });
  }

  /** 推进度用的一句话（连接层拿它报「断线重连中」这类事，不算某一轮的错误） */
  pushNotice(level: "info" | "warning" | "error", text: string, conversationId?: string): void {
    this.push({
      type: "notice",
      level,
      // 本进程自己的提示没有「到点自动消失」这个设定：留到界面自己收
      duration: null,
      text: localText(text),
      conversationId: conversationId ?? null,
    });
  }

  // ==================================================================
  // 事件翻译
  // ==================================================================

  /** 一片增量 → 拼进那条助手消息，整条推给 render（按 id 就地替换） */
  private onDelta(payload: EventPayload<"message.delta">): void {
    const { conversationId, messageId, delta } = payload;
    const message = this.streamFor(conversationId).applyDelta(messageId, delta);
    this.markStarted(conversationId);
    this.push({ conversationId, type: "message", message });
  }

  /**
   * 运行状态变化 → 六态 + 收尾。
   *
   * `run.state` 是**全量快照**（发的是「现在是什么样」，不是「变成第几态」），所以任何一条到手都
   * 能直接替换本地那份，不必先对齐历史 —— 重连之后宿主回的第一份就是它。
   */
  private onRunState(payload: EventPayload<"run.state">): void {
    const { conversationId, run } = payload;
    this.runs.set(conversationId, run);
    if (run.status === "running") {
      // 别的客户端发起的这一轮：本端也要进流式态，否则界面上一片安静（正文在长、却没有「正在生成」）
      this.markStarted(conversationId);
    }
    this.pushPhase(conversationId, run);
    if (run.status === "settled") void this.settle(conversationId, run);
  }

  /** 本轮用量 → 钉到那条助手消息上（`done` 那次替换里宿主给的是同一份） */
  private onUsage(payload: EventPayload<"usage">): void {
    const stream = this.streams.get(payload.conversationId);
    const message = stream?.attachUsage(payload.usage.turn);
    if (!message) return;
    this.push({ conversationId: payload.conversationId, type: "message", message });
  }

  /** 一条通知 → `notice`（语气三档与宿主同一个词，内容四件原样搬） */
  private onNotice(payload: EventPayload<"notice">): void {
    const { notice } = payload;
    this.push({
      type: "notice",
      level: notice.level,
      duration: notice.duration,
      text: notice.text,
      conversationId: notice.conversationId,
    });
  }

  /** 一个问题对象 → 结构化的 `question` 推送（整份 `QuestionView`，不拍平、不挑字段） */
  private onQuestion(payload: EventPayload<"question">): void {
    const { question } = payload;
    this.push({ conversationId: question.conversationId, type: "question", question });
  }

  /** 结构变化 → 该拉什么就拉什么（推送里只有「变了」，没有变之后的对象） */
  private onChanged(payload: EventPayload<"conversation.changed">): void {
    const { conversationId, change } = payload;
    switch (change) {
      case "renamed":
        void this.refreshName(conversationId);
        return;
      case "deleted":
        // 本端自己删的（render 会自己收拾）；别的端删的，这里把本地那几份账清掉就够了 ——
        // 侧栏下一次 `conversation.list` 自然不包含它
        this.forget(conversationId);
        return;
      default:
        // `messages_persisted` 的收尾走 `run.state`（那边带结局，且一定在落库之后）；
        // `pinned` / `settings_changed` / `message_removed` 这一波没有对应界面
        return;
    }
  }

  // ==================================================================
  // 断线与补拉
  // ==================================================================

  /**
   * 连接断了：让客户端库重连（它连上之后会自己补拉 `track` 过的对话）。
   *
   * 「要不要一直重试」是这里定的（库里刻意不预设，见它的 `reconnect.ts`）：给 5 次、退避封顶 10 秒；
   * 还没连上就推一条通知说清，而不是让界面永远停在「看起来在连」。
   */
  private onClose(error: ClientError): void {
    const connection = this.connection;
    if (!connection) return;
    this.log(`与宿主的连接断了：${error.message}；开始重连`);
    void reconnectUntilConnected(connection, { policy: RECONNECT_POLICY }).catch((failure: unknown) => {
      const message = failure instanceof Error ? failure.message : String(failure);
      this.log(`重连失败，已放弃：${message}`);
      this.pushNotice("error", `与宿主的连接断了，重连 ${RECONNECT_POLICY.maxAttempts} 次仍未成功：${message}`);
    });
  }

  /**
   * 补拉回来了（重连之后客户端库自己拉的，或 `chat.getState` 那次）。
   *
   * 「续传」与「全量」怎么拼只有一份实现（库里的 `mergeResumed`）：宿主回的 `anchor` 命中时，
   * 第一条就是那条消息的**最新内容**（流式中那条可能已经变了），所以是替换而不是再追加一条。
   *
   * 问题清单也跟着这一份回来：`state.questions` 是宿主此刻的完整清单，逐条推成 `question`
   * （断线期间挂上的题没有别的路能到 render，见文件头）。
   */
  private onResume(outcome: ResumeOutcome): void {
    if (!outcome.ok) {
      const { conversationId, error } = outcome;
      this.log(`补拉对话 ${conversationId} 失败：${error.message}`);
      this.pushNotice("warning", `补拉这段对话的最新内容失败：${error.message}`, conversationId);
      return;
    }
    const resumed: ResumedConversation = outcome.resumed;
    const local = this.messages.get(resumed.conversationId) ?? [];
    const merged = mergeResumed(local, resumed);
    this.messages.set(resumed.conversationId, merged);
    this.streams.get(resumed.conversationId)?.reset();
    this.push({ conversationId: resumed.conversationId, type: "done", messages: merged });
    this.runs.set(resumed.conversationId, resumed.state.run);
    // 补拉的时刻这一轮可能还在跑：把六态与「进入流式态」一起补回去，接着收后面的增量
    if (resumed.state.run.status === "running") this.markStarted(resumed.conversationId);
    this.pushPhase(resumed.conversationId, resumed.state.run);
    // 断线期间挂上的题只能这样回来（推送不重放）：快照里那份是完整清单，逐条推成 `question`，
    // render 按 id 并入本地那份（见文件头）
    for (const question of resumed.state.questions) {
      this.push({ conversationId: resumed.conversationId, type: "question", question });
    }
  }

  // ==================================================================
  // 内部
  // ==================================================================

  /**
   * 一轮收尾：回宿主拿整段消息，推 `done`（失败再推一句 `error`）。
   *
   * 同一轮只收一次：`run.state` 的 `settled` 快照在重连补拉时会再给一份，收两次就会把已经
   * 结束的一轮又画一遍。标记用 `settledAt`（同一轮同一时刻，宿主只写一次）。
   */
  private async settle(conversationId: string, run: RunState): Promise<void> {
    const marker = run.settledAt ?? "";
    if (this.settled.get(conversationId) === marker) return;
    this.settled.set(conversationId, marker);

    try {
      const listed = await this.options.call("message.list", { conversationId });
      this.messages.set(conversationId, listed.messages);
      this.streams.get(conversationId)?.reset();
      this.started.delete(conversationId);
      this.push({ conversationId, type: "done", messages: listed.messages });
      // 失败原因放在 `done` **之后**：render 的 `done` 分支会清空错误条，先 error 后 done
      // 等于把原因白白扔掉
      if (run.outcome === "error" && run.problem) {
        this.push({ conversationId, type: "error", problem: run.problem });
      }
    } catch (error) {
      // 拿不到消息也不能让界面停在「生成中」：走它认识的错误通道把流式态收掉
      this.started.delete(conversationId);
      this.push({ conversationId, type: "error", problem: problemOf(error) });
    }
  }

  /** 改名之后拉一次会话（推送里只有「改名了」，名字要现读） */
  private async refreshName(conversationId: string): Promise<void> {
    try {
      const { conversation } = await this.options.call("conversation.get", { conversationId });
      this.push({ conversationId, type: "renamed", name: conversation.name });
    } catch (error) {
      // 名字没拉到不值得打扰用户（侧栏下一次 `conversation.list` 会带回新名字）
      this.log(`拉对话 ${conversationId} 的名字失败：${messageOf(error)}`);
    }
  }

  /** 六态变化 → `stream`（只在真的变了时推：`run.state` 会为别的字段重复到达） */
  private pushPhase(conversationId: string, run: RunState): void {
    const generation = run.generation;
    const phase: StreamPhase | null = generation?.phase ?? null;
    // 只有「在等工具」那一态带列表，并行时有几个还在跑就列几个（PRD L8）
    const toolCalls: AgentNS.ToolCall[] =
      generation?.phase === "awaiting_tools"
        ? generation.runningTools.map((running) => running.toolCall)
        : [];
    const signature = `${phase ?? ""}|${toolCalls
      .map((toolCall) => `${toolCall.id ?? ""}:${toolCall.function?.name ?? ""}`)
      .join(",")}`;
    if (this.pushedPhase.get(conversationId) === signature) return;
    this.pushedPhase.set(conversationId, signature);
    this.push({ conversationId, type: "stream", phase, toolCalls });
  }

  /** 推一次 `start`（这一轮进入流式态）；已经推过就什么都不做 */
  private markStarted(conversationId: string): void {
    if (this.started.has(conversationId)) return;
    this.started.add(conversationId);
    this.push({ conversationId, type: "start" });
  }

  /** 清掉一段对话在本地的那几份账（对话被删时） */
  private forget(conversationId: string): void {
    this.streams.delete(conversationId);
    this.messages.delete(conversationId);
    this.runs.delete(conversationId);
    this.pushedPhase.delete(conversationId);
    this.started.delete(conversationId);
    this.settled.delete(conversationId);
    void this.connection?.untrack(conversationId);
  }

  private streamFor(conversationId: string): StreamingMessage {
    const existing = this.streams.get(conversationId);
    if (existing) return existing;
    const stream = new StreamingMessage();
    this.streams.set(conversationId, stream);
    return stream;
  }

  private push(event: ChatStreamEvent): void {
    try {
      this.options.push(event);
    } catch (error) {
      // 推给一个已经销毁的窗口会抛：不该因此把一条连接弄坏，也不该连累后面的订阅者
      this.log(`推送事件失败（${event.type}）：${messageOf(error)}`);
    }
  }
}

/** 日志里只需要一句话（`ProblemFact` 那份结构化的事不往日志里搬） */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
