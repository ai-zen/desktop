/**
 * 服务端事件 → render 的 `ChatStreamEvent`（`packages/shared/src/types.ts`，一字未改）。
 *
 * ## 这一层为什么必须存在
 *
 * 服务端推的是**事实**（阶段 kind、增量文本、轮次收尾、id/标题变化），render 吃的是
 * **对话流**（start / user / message / done / migrated / error / renamed）。两套词表之间
 * 的翻译只该有一处实现，否则「谁负责把增量拼成消息」「谁负责在收尾时补快照」会散在
 * 调用点各写一遍，漂起来就是"有的会话能滚、有的会话空白"。
 *
 * ## 必须在这里做掉的翻译（对应协议缺口的降级）
 *
 * 1. **没有「开始」事件** —— 从 `session.phase` 出现非 `null` 推出「这一轮开始了」，
 *    每个 `turnId` 只派发一次 `user` + `start`；
 * 2. **`message.delta` 只有 `text` / `reasoning`** —— 拼进一条**占位** assistant 消息，
 *    消息 id 是客户端生成的（服务端不给 id），`turn.end` 之后由快照全量替换成真实 id；
 *    工具调用的**组装态**走另一条事件 `session.toolCalls`（见 {@link ChatEventBridge.onToolCalls}），
 *    它那份扁平载荷要在这里回收成 SDK 的嵌套形（见 {@link toSdkToolCalls}）；
 * 3. **`session.messageAppended` 的 `message` 是 `unknown`** —— 它是服务端手里那条**已经
 *    定型**的完整消息（今天是工具结果），客户端只把它回收成 `AgentNS.Message` 再原样搬给
 *    render，**不拼装、不补字段、不编 id**（见 {@link ChatEventBridge.onMessageAppended}）；
 * 4. **`turn.end` 只带 `ok` / `error` 不带消息** —— 收尾补一次 `session.snapshot`，
 *    用全量替换（`done`）把消息 status（`completed` / `aborted` / `error`）与服务端对历史的
 *    清洗一次补齐。第 3 条已经把工具结果提前送到屏幕上，但**收尾仍以快照为准**：一条被取消
 *    的轮次里没定型的工具结果，只有快照里才有；
 * 5. **`session.phase` 的文案没处放** —— `ChatStreamEvent` 里没有 stage 字段，所以阶段
 *    只用来判「有没有在跑」（派发 `start`、给侧栏的 `running` 提供口径），文案不进 render。
 *
 * ## 通知（`session.notice` / `global.notice`）：翻成人话再推
 *
 * 这两条原来在这里被丢掉，理由是「render 没有通知栏」。后果不是「少一条提示」，而是
 * **用户看不到为什么什么都没发生**：自动迁移被跳过、存档没写成功（他以为存了）、子 Agent
 * 挂着、交接文档落在哪 —— 全都静默。现在它们有了落点 `type: "notice"`（render 弹一条
 * 瞬时提示）——只差翻译：服务端只给 `code + params`，文案由本端出（词典在 `notices.ts`，
 * 全桌面端就这一份）。
 *
 * ## 子 Agent 的视图：另开一条 `agents` 通道（整份替换）
 *
 * 子 Agent 的增量（`message.delta` 带 `subAgentId`）**不进主对话**：那是另一层对话，拼进
 * 主回答等于凭空多出一段文字。但它也不能被丢掉 —— 用户要能切到某个子 Agent 看它自己的
 * 完整对话（TUI 已经这么做：消息列表下方一条「主对话 / 子AGENT1 / 子AGENT2」栏目）。所以
 * 这里给每条会话维护一份「本轮子 Agent 视图」，每次变化推一条 `type: "agents"`，载荷是
 * **整份**列表（为什么不做增量事件，见 `ChatStreamEvent` 的那个成员）。
 *
 * 三件事只在这一层做，而且各只有一处：
 *   - **分流**：带 `subAgentId` 的增量送进那个子 Agent 自己的拼接状态，主会话那一份一个字
 *     都不碰（主会话此刻该停在「等待 xxx 返回」，不该被别人的正文推着长）；
 *   - **对齐**：`started` 一到就拉一次 `session.subAgent.snapshot`（它可能已经跑了一会儿、
 *     已经有内容了），合并只能走共享包的 `mergeStreamedSnapshot` —— 快照的往返可能比第一
 *     批增量还慢，直接赋值会让屏幕上已经流出来的正文凭空短一截；
 *   - **回收**：`turn.end` / `session.idChanged` 清空（子 Agent 只活当前这一轮，与 TUI 同
 *     一口径），清空本身也推一条 `agents: []`，render 据此把栏目收回去。
 *
 * ## `session.question`：不问用户也必须有人答
 *
 * 它不是「推给用户看的信息」，而是「服务端在等一个回答」。没人答，服务端就白等到 5 分钟
 * 超时 —— 所以桌面端收到就立刻按「跳过」答回去（见 {@link ChatEventBridge.onQuestion}）。
 */

import {
  EVENT_METHODS,
  SESSION_EVENTS,
  SESSION_METHODS,
  // 「本地流式增量 vs 服务端快照」的合并规则：共享包里的唯一实现，本仓不许再写一份
  // （两个前端在同一个时序压力下做同一件事，抄两份就会在「宁可重复也不吞字」上分叉）
  mergeStreamedSnapshot,
  type GlobalNoticeEvent,
  type MessageDeltaEvent,
  type StreamedAssistant,
  type SubAgentEndedEvent,
  type SubAgentSnapshotResult,
  type SubAgentStartedEvent,
  type SessionAnswerResult,
  type SessionIdChangedEvent,
  type SessionMessageAppendedEvent,
  type SessionNoticeEvent,
  type SessionPhaseEvent,
  type SessionQuestionEvent,
  type SessionSnapshotResult,
  type SessionTitleChangedEvent,
  type SessionToolCallsEvent,
  type ToolCallState,
  type TurnEndEvent,
} from "@ai-zen/agents-client";
// 只要类型：`import type` 在产物里被整体擦除，main 因此不必为了一个 role 字符串把
// agents-core（连带 openai）拉进运行期 —— 握手/事件这条路上一个模型库也不该被加载
import type { AgentNS } from "@ai-zen/agents-core";
import type { ChatStreamEvent, SubAgentView } from "@ai-zen/desktop-shared";
import type { ServerConnection } from "./connection.js";
import { noticeText } from "./notices.js";

/**
 * 占位 assistant 消息的 role。
 *
 * 写字符串 + 断言而不是 `AgentNS.Role.Assistant`：后者要求**值导入** agents-core（类型
 * 导入在运行期是 undefined，见仓库 AGENTS.md 的踩坑记录），而那等于让 main 进程加载整个
 * 模型库。`Role` 是字符串枚举，`Assistant` 的字面值就是 `"assistant"`。
 */
const ASSISTANT_ROLE = "assistant" as AgentNS.Role;

/** 一条会话「当前这一轮」的本地拼装状态（`turn.end` 之后丢弃） */
interface TurnSlot {
  turnId: number;
  /** 是否已经派发过 `user` + `start`（没有「开始」事件，只能由阶段变化推一次） */
  started: boolean;
  /** 流式占位 assistant 消息的 id（服务端增量不带消息 id，见文件头缺口②） */
  messageId: string | null;
  text: string;
  reasoning: string;
  /**
   * 本轮工具调用的**组装态**（`session.toolCalls` 每次给全集，所以这里是整体替换）。
   *
   * 存的是已经回收成 core 形状的 `AgentNS.ToolCall`：翻译只做一次（进槽位时就做），
   * 之后「正文 + 工具调用」拼成一条消息时不必再转一遍。
   */
  toolCalls: AgentNS.ToolCall[];
}

/**
 * 一条会话「当前这一轮」的子 Agent 栏目（`turn.end` / `session.idChanged` 之后整份丢弃）。
 *
 * 为什么要两份状态（视图 + 流式拼接）：`SubAgentView.messages` 是**推给 render 的那一份**
 * （流式期间由增量拼、快照到了就整份换成合并后的结果），而 `streams` 是「本地已经拼出来
 * 多少」—— 它只喂给共享包的 `mergeStreamedSnapshot`，决定合并方向。合成一份的话，快照
 * 到达那一刻就没有「本地那份 vs 服务端那份」可比较了。
 */
interface SubAgentSlot {
  /** 顺序 = `session.subAgent.started` 的到达顺序 = 服务端给的 `index` 顺序 */
  views: SubAgentView[];
  /** `subAgentId` → 那一份临时 assistant 消息（一个子 Agent 一次委派只拼一条） */
  streams: Map<string, StreamedAssistant>;
}

export interface ChatEventBridgeOptions {
  connection: ServerConnection;
  /** 推给 render（桌面端是 `webContents.send("chat:push")`；用例里是一个收集函数） */
  push: (event: ChatStreamEvent) => void;
}

export class ChatEventBridge {
  /** sessionId → 这一轮的拼装状态（键是**render 认识的 id**，见 {@link keyOf}） */
  private readonly turns = new Map<string, TurnSlot>();
  /**
   * 本次发送的正文：服务端事件里没有「用户说了什么」（`message.delta` 只有模型增量），
   * 而 render 的 `user` 事件要正文才能上屏。发送时登记，派发 `start` 时消费掉。
   */
  private readonly sends = new Map<string, string>();
  /** 换过 id 的会话：新 id → render 认识的旧 key（见 {@link onIdChanged}） */
  private readonly aliases = new Map<string, string>();
  /**
   * 本轮的子 Agent 栏目（键同样是 render 认识的 key，见 {@link keyOf}）。
   *
   * 与 `turns` 分开存而不是塞进 `TurnSlot`：两者的生命周期判断点不同 —— 轮次槽位按
   * `turnId` 换，栏目只按 `turn.end` / `idChanged` 清（子 Agent 的事件里也带 `turnId`，
   * 但用它与主会话的槽位绑在一起，会让「子 Agent 比主会话先到」这类正常时序多出一个
   * 隐式依赖，收益为零）。
   */
  private readonly agents = new Map<string, SubAgentSlot>();
  private readonly offs: Array<() => void> = [];

  constructor(private readonly options: ChatEventBridgeOptions) {}

  /**
   * 连上服务端、订阅事件、让这条连接开始收事件。
   *
   * 必须在任何 `chat.send` 之前完成：服务端在 `send` 的**回执之前**就会推第一条阶段
   * 事件，订阅晚一步就会漏掉「这一轮开始了」—— 界面于是只看到正文在长、却一直不进
   * 流式态（旧实现里那条 `inner-loops-start` 是同步发的，没有这个窗口）。
   */
  async start(): Promise<void> {
    const client = await this.options.connection.client();
    this.offs.push(
      client.on(SESSION_EVENTS.phase, (event) => this.onPhase(event)),
      client.on(SESSION_EVENTS.delta, (event) => this.onDelta(event)),
      client.on(SESSION_EVENTS.toolCalls, (event) => this.onToolCalls(event)),
      client.on(SESSION_EVENTS.messageAppended, (event) => this.onMessageAppended(event)),
      client.on(SESSION_EVENTS.subAgentStarted, (event) => this.onSubAgentStarted(event)),
      client.on(SESSION_EVENTS.subAgentEnded, (event) => this.onSubAgentEnded(event)),
      client.on(SESSION_EVENTS.turnEnd, (event) => this.onTurnEnd(event)),
      client.on(SESSION_EVENTS.idChanged, (event) => this.onIdChanged(event)),
      client.on(SESSION_EVENTS.titleChanged, (event) => this.onTitleChanged(event)),
      client.on(SESSION_EVENTS.question, (event) => this.onQuestion(event)),
      client.on(SESSION_EVENTS.notice, (event) => this.onNotice(event)),
      client.on(SESSION_EVENTS.globalNotice, (event) => this.onGlobalNotice(event)),
    );
    await client.call(EVENT_METHODS.watch);
  }

  /** 一轮即将开始：记下正文（派发 `start` 时上屏用），服务端事件里没有这份内容 */
  noteSend(sessionId: string, content: string): void {
    this.sends.set(sessionId, content);
  }

  /** 这一轮没能发出去（`turn-busy` 之类）：撤回上面那条登记，别让它被下一轮认领 */
  dropSend(sessionId: string): void {
    this.sends.delete(sessionId);
  }

  /**
   * 直接推一条 `error`（`chat.send` 自己的失败出口）。
   *
   * 旧实现把「取 agent 阶段」的错误也走这条事件通道，而不是让 IPC 抛错 —— render 的
   * `send()` 因此永远正常返回，错误条由事件驱动。这里保持同一条语义。
   */
  pushError(conversationId: string, message: string): void {
    this.options.push({ conversationId, type: "error", message });
  }

  /** 断开订阅（连接本身由 `ServerConnection` 负责） */
  dispose(): void {
    for (const off of this.offs.splice(0)) off();
  }

  // ==================================================================
  // 事件翻译
  // ==================================================================

  /**
   * 阶段变化 → `user` + `start`。
   *
   * `phase === null` 是「本轮回到空闲」，收尾归 `turn.end`（它带 `ok` / `error`，之后
   * 还要补一次快照）—— 这里不重复收尾，否则一轮会派发两次 `done`。
   */
  private onPhase(event: SessionPhaseEvent): void {
    if (event.phase === null) return;
    const key = this.keyOf(event.sessionId);
    const slot = this.slotOf(key, event.turnId);
    if (slot.started) return;
    slot.started = true;

    const content = this.sends.get(key);
    if (content !== undefined) {
      this.sends.delete(key);
      // id 是客户端编的：服务端事件不带消息 id（缺口②），而 render 按 id 做 v-for key
      // 并就地 upsert。收尾那次快照会把它换成服务端真实 id（内容是同一份）。
      this.options.push({
        conversationId: key,
        type: "user",
        id: `${key}:user:${slot.turnId}`,
        content,
      });
    }
    this.options.push({ conversationId: key, type: "start" });
  }

  /**
   * 增量 → 占位 assistant 消息（正文 / 推理拼在一起，其余字段只有快照里才有）。
   *
   * 带 `subAgentId` 的那一支不是「主对话的增量」，而是**另一个对话**（子 Agent）的增量：
   * 送进它自己的拼接状态（见 {@link applySubAgentDelta}），**不碰**主会话这份槽位。
   * 混在一起的后果不是「多一行」，而是主回答里凭空长出一段子 Agent 的正文，而主会话
   * 本身的拼接状态被推着往前走（本来该停在「等待 xxx 返回」）。
   */
  private onDelta(event: MessageDeltaEvent): void {
    const key = this.keyOf(event.sessionId);
    if (event.subAgentId) {
      this.applySubAgentDelta(key, event.subAgentId, event.text, event.reasoning);
      return;
    }
    // 只带 usage 的流末 chunk（正文与推理都空）不该在转录里多出一条空消息
    if (!event.text && !event.reasoning) return;

    const slot = this.slotOf(key, event.turnId);
    slot.text += event.text;
    slot.reasoning += event.reasoning;
    this.pushAssistant(key, slot);
  }

  /**
   * 本轮工具调用的组装态 → 那条**同一条**占位 assistant 消息（就地更新）。
   *
   * 事件给的是**全集**（服务端按 `index` 拼好、参数没变就不发），所以这里整体替换掉槽位里
   * 那份列表，而不是往后面接：同一个调用第二次到达时参数更长、`id` 也许这时才出现，但消息
   * id 不变 —— render 按 id 就地 upsert，画面上是同一条消息里的卡片在长，不是每片多一张。
   *
   * 参数原样留着、**不在这里 `JSON.parse`**：流式当中它本来就是半截 JSON（`{"path":"a`），
   * 解析必抛；render 也按文本原样显示（`MessageBubble.vue` 的 `<pre class=…>`）。
   */
  private onToolCalls(event: SessionToolCallsEvent): void {
    const key = this.keyOf(event.sessionId);
    const slot = this.slotOf(key, event.turnId);
    slot.toolCalls = toSdkToolCalls(event.toolCalls);
    this.pushAssistant(key, slot);
  }

  /**
   * 一条**已经定型**的工具结果消息 → `type: "message"`，原样搬给 render。
   *
   * ## 为什么**不需要**本地拼装
   *
   * 服务端推过来的是那一刻就定型了的那条消息**本身**（`role: "tool"` + `tool_call_id` +
   * `name` + 正文 + `status`），与收尾快照里的是同一份东西。客户端在这一层唯一要做的是把
   * 协议的 `unknown` 回收成 SDK 形状（见下），然后原样推给 render —— 一旦在这里「顺手补
   * 点什么」（拼进占位消息、给正文加前缀、按工具调用把结果挂到卡片上），同一条消息就有了
   * 第二份表示，收尾对账时还得判「哪一份才是真的」。
   *
   * ## 为什么它不会和占位 assistant 消息打架
   *
   * 占位消息是**客户端编 id** 的那一条（`{@link ChatEventBridge.pushAssistant}` 里的
   * `${key}:assistant:${turnId}`，正文在流、由 `message.delta` 一路拼），而工具结果带的是
   * **服务端真实 id**。render 的 `type: "message"` 是按 id 就地 upsert（`stores/chat.ts`：
   * 有则替换、无则追加末尾），两个 id 不同，于是它们**各自占一个气泡**：正文一条、结果一条。
   * 也正因为 id 来自服务端，收尾那次 `done`（快照全量替换）不会把这条结果当成「多出来的
   * 本地消息」丢掉 —— 快照里那一条的 id 与这里推的完全相同。
   *
   * ## 顺序可能不是消息表里的顺序，别假设它跟在某条后面
   *
   * 服务端是「谁先跑完谁先推」（`tool-call-end` 每个工具各发一次）：并行时后开始的那个工具
   * 可能先完成、先上线，于是这条消息的下标在消息表里排在**正在跑**的那条之后，到达时间却
   * 更早。所以这里不按顺序做任何事（不插入指定位置、不假设上一条是谁）—— render 的追加
   * 语义就是它的正确语义：用户看到的是「谁先跑完谁的结果先出现」，而不是一条被卡住不动的
   * 队列。
   *
   * ## 消息**一定**有 id，所以这里没有兜底分支
   *
   * core 的 `Message` 构造函数保证 `id = options.id ?? generateMessageId()`
   * （`packages/core/src/Message.ts`），落进 `agent.messages` 的每一条都带着 id；协议把它
   * 交成 `unknown` 只是「不认识 SDK 的消息形状」，不是「可能没有 id」。为「万一是
   * undefined」补一条自编 id 的分支，就是在制造第二份 id 真相：同一条消息在 `messageAppended`
   * 里一个 id、在 `done` 的快照里另一个 id，render 按 id upsert 会把它画成两条 —— 一个
   * 本不存在的情况硬生生变成一份重复的气泡。
   *
   * 会话 key 走 `keyOf`：换过 id 的会话（迁移 / 另存为）在 render 那边仍以旧 key 认识自己，
   * 与 `message.delta` / `turn.end` / `notice` 同一口径。
   */
  private onMessageAppended(event: SessionMessageAppendedEvent): void {
    const key = this.keyOf(event.sessionId);
    // 回收成 SDK 形状是客户端这一层的事（协议刻意不认识它）：手法与收尾取快照那行
    // `snapshot.messages as AgentNS.Message[]` 一致 —— 服务端给的就是 core 那条消息本身
    const message = event.message as AgentNS.Message;
    this.options.push({ conversationId: key, type: "message", id: message.id, message });
  }

  /**
   * 一个子 Agent 开工 → 栏目里多一条 `running`，并立刻拉一次快照补已有内容。
   *
   * ## `id` / `index` 都用服务端给的
   *
   * `index` 是**展示序号**（本轮内从 1 起，栏目标签「子AGENT1」直接印它），`subAgentId` 是
   * **稳定标识**（选中态与 v-for key 靠它）。客户端不自己数：它要在「中途接上连接」「切到
   * 某一栏」时都对得上，而那时本地一个数都没数过 —— 自己数出来的序号会在这些时刻与服务端
   * 错开一位，用户看到的是「栏目标题与内容不是同一个子 Agent」。
   *
   * ## 为什么立刻拉一次快照
   *
   * `started` 只说明「它已经在跑」：服务端此刻可能已经有内容（子任务的用户消息、上一轮工具
   * 调用、甚至已经吐了几段正文）。只等增量的话，中途切过来看到的是半截。这次拉取是**补
   * 内容**，不是拉状态：`index` / `status` 已经由事件给过，同一份事实不在这条路上读第二遍。
   *
   * ## 失败为什么静默
   *
   * 这次拉取只补内容：拉不到时增量照样拼、`ended` 照样改状态、`turn.end` 照样清空 ——
   * 用户看不到任何"缺一块"的迹象。而连接真断了有别的信号（`turn.end` 的快照失败会走
   * `error`，收尾的 `send` 也会失败）。在这里再推一条错误，只会让一次成功的委派凭空多一句
   * 红字。所以 `.catch(() => {})` 吞的是「这次补内容没成功」，不是「吞掉一个错误」。
   */
  private onSubAgentStarted(event: SubAgentStartedEvent): void {
    const key = this.keyOf(event.sessionId);
    const slot = this.agentSlotOf(key);
    slot.views.push({
      id: event.subAgentId,
      index: event.index,
      status: "running",
      messages: [],
    });
    // 先推「它开跑了」：标签不该等一个往返才出现（此刻内容是空的，增量与快照一到就填）
    this.pushAgents(key, slot);
    void this.syncSubAgent(event.sessionId, event.subAgentId).catch(() => {});
  }

  /**
   * 一个子 Agent 收尾 → 只改状态（正文由增量与快照负责，这里不再拉一次）。
   *
   * `failed` 是**终态**，不能被后来的 `done` 覆盖：core 在 `finally` 里分发 `sub-agent-end`，
   * 出错的那一次也照样会走一遍 —— 无脑覆盖会把用户看到的 ✖ 擦成 ✓，让人以为一个真的挂了
   * 的子任务成功了。服务端今天已经用「只把仍在 running 的置为 done」挡了一层，协议也把
   * `failed` 写成终态，客户端这一层仍然照着判：这条规则的两个实现（服务端的事件、客户端的
   * 视图）说的是同一件事，少一处就有一处会漂。
   */
  private onSubAgentEnded(event: SubAgentEndedEvent): void {
    const key = this.keyOf(event.sessionId);
    const slot = this.agents.get(key);
    const view = slot?.views.find((item) => item.id === event.subAgentId);
    // 没有这一栏就没有状态可改：`ended` 属于一个客户端没见过的子 Agent（`turn.end` 已经
    // 把栏目清掉了，或者这条连接的 `started` 早于订阅）—— 凭空补一条出来是在编造内容
    if (!slot || !view) return;
    if (!(view.status === "failed" && event.status === "done")) view.status = event.status;
    this.pushAgents(key, slot);
  }

  private onTurnEnd(event: TurnEndEvent): void {
    // 子 Agent 只活当前这一轮：收尾就把栏目清掉（与 TUI 同一口径）。清在补快照**之前**
    // —— 那份快照只描述主会话，栏目不该被它带着复活（也不会：快照到达时列表已经空了）。
    this.clearSubAgents(this.keyOf(event.sessionId));
    void this.finishTurn(event).catch((error: unknown) => {
      // 快照拿不到（连接断了 / 会话刚被收掉）：没有权威消息可给，但 render 正等着收尾。
      // 走它认识的错误通道 —— `error` 会把流式态收掉，否则界面永久停在「生成中」。
      this.options.push({
        conversationId: this.keyOf(event.sessionId),
        type: "error",
        message: messageOf(error),
      });
    });
  }

  /**
   * 一轮收尾：补一次快照，用**服务端那份**全量替换。
   *
   * 为什么不把本地拼的那条流当作结果：工具调用参数、消息 status（`completed` /
   * `aborted` / `error`）与服务端对历史的清洗都只有服务端有。客户端拼出来的只是「能让屏幕
   * 滚起来的近似」，收尾必须换成真件。
   *
   * 工具结果消息已经由 `messageAppended` 提前推过了（见 {@link onMessageAppended}），但这里
   * 不做增量对账、照旧整份替换：那条路是「让用户早点看到」，快照才是「最终历史」，而两者
   * 里的同一条消息 id 相同（服务端真实 id），替换不会画成两条。
   */
  private async finishTurn(event: TurnEndEvent): Promise<void> {
    const key = this.keyOf(event.sessionId);
    const snapshot = await this.options.connection.call<SessionSnapshotResult>(
      SESSION_METHODS.snapshot,
      { sessionId: event.sessionId },
    );
    // 收尾期间下一轮可能已经开始（用户点得快）：只清掉属于**这一轮**的槽位
    if (this.turns.get(key)?.turnId === event.turnId) this.turns.delete(key);

    this.options.push({
      conversationId: key,
      type: "done",
      messages: snapshot.messages as AgentNS.Message[],
    });
    // 失败原因放在 `done` **之后**：render 的 `done` 分支会把错误条清空，先 error 后
    // done 等于把原因白白扔掉。
    if (event.error) {
      this.options.push({ conversationId: key, type: "error", message: event.error.message });
    }
  }

  /**
   * 会话换了 id（迁移 / 另存为；桌面端自己不会触发，只可能是"另一个客户端动了这段会话"）。
   *
   * render 的会话键只有 `conversationId`，`ChatStreamEvent` 里也没有「换 key」的类型 ——
   * 所以这里做**别名收敛**：新 id 上的后续请求与事件继续以旧 key 上报，画面才是连续的
   * （不做的话，一段正在跑的会话会在旧 id 上等一个永远不来的 `turn.end`，界面卡死）。
   * 迁移之后的内容是另一份历史，所以同时补一份快照推 `migrated`（render 的全量替换语义），
   * 侧栏里那条新会话由随后的列表刷新带出。
   */
  private onIdChanged(event: SessionIdChangedEvent): void {
    const key = this.keyOf(event.from);
    this.aliases.set(event.sessionId, key);
    // 换了 id = 换了一段会话（迁移 / 另存为）：上一段里的子 Agent 不该跟着过来。
    // 服务端此刻也把它们清掉了（`adopt` → `clearSubAgents`），客户端清一次才能与它同步
    // —— 不清的话，栏目会停在一段已经不存在于服务端的对话上，点进去永远拉不到快照。
    this.clearSubAgents(key);
    void this.options.connection
      .call<SessionSnapshotResult>(SESSION_METHODS.snapshot, { sessionId: event.sessionId })
      .then((snapshot) => {
        this.options.push({
          conversationId: key,
          type: "migrated",
          messages: snapshot.messages as AgentNS.Message[],
        });
      })
      .catch((error: unknown) => {
        // 同上：拿不到新会话的快照时，画面只能靠已知内容停住，但错误必须说出去
        this.options.push({ conversationId: key, type: "error", message: messageOf(error) });
      });
  }

  /**
   * 服务端在自动迁移之前问「用哪种方式交接」→ 立刻按**跳过**回答（`choice: null`）。
   *
   * ## 为什么必须答
   *
   * 服务端发出 `session.question` 之后会**一直等**：等不到答案，它自己等满
   * `ASK_TIMEOUT_MS`（5 分钟）才用 `fallback` 收场。而桌面端没有提问 UI
   * （`ChatStreamEvent` 里没有这一类，本期不许改 render），也就是说这 5 分钟里没有任何人
   * 看得见这个问题 —— 用户那边的感受是「界面像是死了 5 分钟，然后什么也没发生」（服务端
   * 那条「本次没迁移」的通知同样没有落点）。不答，就是把服务端的一段等待变成用户面前的
   * 一段假死。
   *
   * ## 为什么答的是「跳过」
   *
   * `choice: null`（跳过）与服务端这条退路的取值**是同一个答案**：这个问题的 `fallback`
   * 就是 `null`（本次不迁移）。所以这里没有替用户做决定 —— 只是把那个超时提前表达出来，
   * 最终结果与服务端等满 5 分钟后自己走 `fallback` 一字不差，唯一差别是不烧那 5 分钟。
   * 反过来，如果这里答 `self`（自动迁移），那才是替用户做了决定：谁来写交接文档（保真 vs
   * 便宜、要不要现在就走）是用户的，服务端已按产品决定废掉了「无人可问时默认 `self`」
   * （见 `SessionManager.askHandoffMode` 的注释），桌面端不该把它复活。
   *
   * ## 将来
   *
   * 加了提问 UI 之后，这里要改成**弹窗**（把 `kind` / `options` 交给用户，用户点了才
   * `session.answer`），而不是继续自动跳过 —— 「桌面端答不了」是今天的限制，不是产品语义。
   *
   * ## 失败不报人看
   *
   * `session.answer` 可能失败：连接断了、会话刚被收掉（`unknown-session`）、或者来晚了
   * （服务端回 `answered: false`）。这些都不是用户可感知的错误 —— 服务端那边本来就会走
   * `fallback`，结果与「答成功了」完全一样。所以这里**只吞掉**：不推 `error`（那会给一次
   * 本来就没事的自动迁移凭空弹一条红字），也不重试（重试只会撞上同一条「来晚了」）。
   */
  private onQuestion(event: SessionQuestionEvent): void {
    void this.options.connection
      .call<SessionAnswerResult>(SESSION_METHODS.answer, {
        // 用服务端给的 id（不是 `keyOf`）：回答这条请求认的是服务端自己的会话键
        sessionId: event.sessionId,
        questionId: event.questionId,
        choice: null,
      })
      .catch(() => {
        // 见上面「失败不报人看」：服务端自己会走 fallback，这条路不该出现在 render 里
      });
  }

  /**
   * 对话内通知 → `notice`（**带** `conversationId`）。
   *
   * 会话 id 走 `keyOf`：换过 id 的会话（迁移 / 另存为）在 render 那边仍以旧 key 认识自己 ——
   * 与 `message.delta` / `turn.end` 同一口径。直接报服务端 id 的话，通知会贴到一段 render
   * 从没见过、也永远不会选中过的会话上，等于又回到「什么都没发生」。
   */
  private onNotice(event: SessionNoticeEvent): void {
    this.options.push({
      conversationId: this.keyOf(event.sessionId),
      type: "notice",
      level: event.level,
      text: noticeText(event.code, event.params),
    });
  }

  /**
   * 全局通知 → `notice` 且**不给** `conversationId`。
   *
   * 它不属于任何会话（存档目录不可用、MCP 连不上是服务本身的事）：填个空串等于声称
   * 「有一个 key 为空的会话」，render 会照着这个 key 开一个假槽位；省掉这个字段才是
   * 「没有会话」—— `ChatStreamEvent.notice` 把它定义成可选就是为了这个。
   */
  private onGlobalNotice(event: GlobalNoticeEvent): void {
    this.options.push({
      type: "notice",
      level: event.level,
      text: noticeText(event.code, event.params),
    });
  }

  /** 服务端自动标题（只发「起好了」这一条）→ 旧的 `renamed`（侧栏直接改名，不刷列表） */
  private onTitleChanged(event: SessionTitleChangedEvent): void {
    this.options.push({
      conversationId: this.keyOf(event.sessionId),
      type: "renamed",
      name: event.title,
    });
  }

  // ==================================================================
  // 内部
  // ==================================================================

  /**
   * 子 Agent 的增量 → 拼到**它自己**的那条临时消息上。
   *
   * 与主会话的占位消息同一套拼接策略（临时消息给屏幕滚、快照到达再合并纠正），但状态**完全
   * 不共享**：主会话的 `TurnSlot`（正文 / 推理 / 工具调用）一个字段都不碰。共享的后果很具体
   * —— 主回答里凭空多出一段子 Agent 的文字，而且主会话的占位消息会被别人的增量推着长，用户
   * 看到的是「主 Agent 在说话，说的却是子 Agent 的内容」。
   *
   * 一个子 Agent 一次委派**只拼一条**临时消息（与 TUI 同一策略）：这期间它可能有多轮
   * assistant（工具调用把一段输出切成几段），拆成多条会让输出在栏目里断成好几截。
   */
  private applySubAgentDelta(
    key: string,
    subAgentId: string,
    text: string,
    reasoning: string,
  ): void {
    const slot = this.agents.get(key);
    const view = slot?.views.find((item) => item.id === subAgentId);
    // 没有 `started` 就没有这一栏：`index` 是服务端在 `started` 里给的，客户端编不出来
    // （中途接上连接时就是这种情形，那种场景的内容由快照负责补齐）
    if (!slot || !view) return;

    let stream = slot.streams.get(subAgentId);
    if (!stream) {
      const message: AgentNS.Message = {
        // 占位 id 与主对话同一手法（服务端不给流式消息 id）：同一个子 Agent 的后续增量必然
        // 落回这一条，而快照到达后会被服务端那条真实 id 换掉
        id: `${key}:sub:${subAgentId}`,
        role: ASSISTANT_ROLE,
        content: "",
      };
      stream = { message, text: "", reasoning: "" };
      slot.streams.set(subAgentId, stream);
      view.messages.push(message);
    }
    stream.text += text;
    stream.reasoning += reasoning;
    // 就地改这两个字段：推出去的拷贝取自这里，屏幕读的也是同一份
    stream.message.content = stream.text;
    if (stream.reasoning) stream.message.reasoning_content = stream.reasoning;
    this.pushAgents(key, slot);
  }

  /**
   * 拉一次子 Agent 快照并合并进栏目（`session.subAgent.snapshot`）。
   *
   * ## 合并只能用共享包里的 `mergeStreamedSnapshot`
   *
   * 这次往返可能比第一批增量还慢（子任务越小越明显）：`view.messages = snapshot.messages`
   * 会把这几片已经流出来的正文换回快照那一刻的旧内容 —— 屏幕上是「答案忽然短了一截」，而且
   * 本轮不会再补上。这条竞态的规则（取信息多的那份、宁可重复也不吞字）只该有一份实现，
   * 它在 `@ai-zen/agents-client` 里，两个前端共用；在本仓再写一遍就会在边界上分叉。
   *
   * ## 快照只用来补内容
   *
   * `index` / `status` 不从这里读：它们已经由 `started` / `ended` 给过。同一份事实有两个
   * 来源时，两边说法不同就得二选一 —— 那是又一处判定，收益为零。
   */
  private async syncSubAgent(sessionId: string, subAgentId: string): Promise<void> {
    const snapshot = await this.options.connection.call<SubAgentSnapshotResult>(
      SESSION_METHODS.subAgentSnapshot,
      // 用服务端给的 id（不是 `keyOf`）：这条请求认的是服务端自己的会话键
      { sessionId, subAgentId },
    );
    const key = this.keyOf(sessionId);
    const slot = this.agents.get(key);
    const view = slot?.views.find((item) => item.id === subAgentId);
    // 往返期间这一轮收了尾（`turn.end` 清空了栏目）：这份内容属于一段已经过去的子 Agent，
    // 落到一个不存在的栏目上就是凭空复活一个标签（点进去也再也拉不到第二次快照）
    if (!slot || !view) return;

    const merged = mergeStreamedSnapshot(
      snapshot.messages as AgentNS.Message[],
      slot.streams.get(subAgentId) ?? null,
    );
    view.messages = merged.messages;
    // 之后的增量继续拼在合并后那一条上（共享包已经把 `stream.message` 指过去了）；
    // 它返回 `null` = 服务端已经收下这段，本地那份作废，下一片增量重新起一条
    if (merged.stream) slot.streams.set(subAgentId, merged.stream);
    else slot.streams.delete(subAgentId);
    this.pushAgents(key, slot);
  }

  /**
   * 清空这条会话的子 Agent 栏目（`turn.end` / `session.idChanged`）。
   *
   * 子 Agent 是「内循环里工具调用的产物」，**只活在当前一轮**：一轮结束后主 Agent 已经给出
   * 最终答案，留着栏目就是留一份永远不会再更新的残影（而且下一轮的第一个子 Agent 会顶着上
   * 一轮的序号出现）。服务端在同一时刻做着同一件事（`settleTurn` → `clearSubAgents`），两边
   * 口径必须一致，否则「服务端说没有、界面还挂着」。
   *
   * 没有栏目可清时**不推空事件**：那等于每轮给 render 送一条什么也不改变的通知。
   */
  private clearSubAgents(key: string): void {
    const slot = this.agents.get(key);
    if (!slot) return;
    this.agents.delete(key);
    // 空数组 = 「这一轮的子 Agent 都没了」（语义见 `ChatStreamEvent` 的 `agents` 成员）
    this.options.push({ conversationId: key, type: "agents", agents: [] });
  }

  /**
   * 把整份栏目推给 render（**整份替换**语义）。
   *
   * 每条事件都带一份**拷贝**：render 收到的是序列化之后的东西（IPC 结构化克隆），而本进程
   * 里 `stream.message` 还在被就地改 —— 不拷贝的话，同一进程里的消费者（用例）会看到「历史
   * 事件自己变了」，一份本该定格在某一刻的载荷跟着流继续长。
   */
  private pushAgents(key: string, slot: SubAgentSlot): void {
    this.options.push({
      conversationId: key,
      type: "agents",
      agents: slot.views.map((view) => ({
        ...view,
        messages: view.messages.map((message) => ({ ...message })),
      })),
    });
  }

  /** 取（或开）这条会话本轮的子 Agent 栏目（`turn.end` / `idChanged` 之后整份丢弃） */
  private agentSlotOf(key: string): SubAgentSlot {
    const existing = this.agents.get(key);
    if (existing) return existing;
    const slot: SubAgentSlot = { views: [], streams: new Map() };
    this.agents.set(key, slot);
    return slot;
  }

  /**
   * 推这条占位 assistant 消息（**整条替换**语义）。
   *
   * ## 每次都推全量
   *
   * `type: "message"` 在 render 那边是按 id 整条替换（`stores/chat.ts` 的 upsert），推出去
   * 的 `message` 就是这条消息**此刻**的全部内容。所以正文、推理、工具调用一个都不能漏：
   * 漏了正文，等于把已经显示出来的字抹掉（工具调用常常晚于正文到达）；漏了工具调用，等于
   * 把已经画好的卡片抹掉（正文还在继续流）。两条路都从这个函数出去，就没有第二处能漏字段。
   *
   * ## 占位 id 为什么在这里生成
   *
   * 服务端不给消息 id（见文件头的缺口②），而 `message.delta` 与 `session.toolCalls` **任何
   * 一条都可能先到**：模型可以先决定调工具，正文要等工具跑完的下一段流才有。把生成收在这
   * 一个函数里，两条路就必然落在**同一条**消息上 —— render 才是原地替换，而不是工具卡片
   * 一行、正文一行。
   */
  private pushAssistant(key: string, slot: TurnSlot): void {
    slot.messageId ??= `${key}:assistant:${slot.turnId}`;
    const messageId = slot.messageId;

    const message: AgentNS.Message = {
      id: messageId,
      role: ASSISTANT_ROLE,
      content: slot.text,
      ...(slot.reasoning ? { reasoning_content: slot.reasoning } : {}),
      ...(slot.toolCalls.length ? { tool_calls: slot.toolCalls } : {}),
    };
    this.options.push({ conversationId: key, type: "message", id: messageId, message });
  }

  /** render 认识的那个 id（换过 id 的会话收敛回旧 key） */
  private keyOf(sessionId: string): string {
    return this.aliases.get(sessionId) ?? sessionId;
  }

  /** 取（或开）这条会话当前这一轮的拼装槽位；`turnId` 变了就是新的一轮 */
  private slotOf(key: string, turnId: number): TurnSlot {
    const existing = this.turns.get(key);
    if (existing && existing.turnId === turnId) return existing;
    const slot: TurnSlot = {
      turnId,
      started: false,
      messageId: null,
      text: "",
      reasoning: "",
      toolCalls: [],
    };
    this.turns.set(key, slot);
    return slot;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 协议里的**扁平**工具调用 → core 的（**嵌套**）`Message.tool_calls` 形状。
 *
 * ## 为什么协议是扁平的
 *
 * `session.toolCalls` 的载荷（`ToolCallState`）只有 `index` / `name` / `id` / `arguments`
 * 四个字段：服务端要回答的是「模型此刻拼到哪了」，它不做 SDK 类型的分发。协议一旦照抄嵌套
 * 形（`function.name` / `function.arguments`），等于把某个模型库版本的内部结构写进跨端
 * 契约 —— 那边哪天换形状，服务端与所有客户端要一起改。
 *
 * ## 为什么在客户端这一层回收成 SDK 形状
 *
 * 往下只有一个消费者，而它认的是 core 的 `AgentNS.Message`：`MessageBubble.vue` 读的正是
 * `tc.function?.name` / `tc.function?.arguments`（收尾之后快照里给的就是这个形状，流式期间
 * 与收尾后必须同形，否则同一张卡片会在收尾那一刻变脸）。所以形状对齐只能在**这里**做，而且
 * 只该有这一处 —— 在 render 里再写一遍，就是「协议 → SDK」的翻译复制到两个包里，漂起来的
 * 症状正是「流式时卡片空白、收尾后突然有内容」。
 */
function toSdkToolCalls(calls: readonly ToolCallState[]): AgentNS.ToolCall[] {
  return calls.map((call) => ({
    index: call.index,
    // `id` 要在场才有：core 收到第一个带 id 的 chunk 之后才认得出这个调用，之前那几片本来
    // 就没有 id（别补成空串 —— render 靠它和工具结果配对）
    ...(call.id ? { id: call.id } : {}),
    type: "function",
    // 参数原样搬（半截 JSON 也照搬）：这一层不解析、不修补
    function: { name: call.name, arguments: call.arguments },
  }));
}
