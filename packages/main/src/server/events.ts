/**
 * 服务端事件 → render 的 `ChatStreamEvent`（`packages/shared/src/types.ts`，一字未改）。
 *
 * ## 这一层只做翻译，不再自己攒状态
 *
 * 「一轮之内该记住什么」—— 正文增量往哪条消息上拼、子 Agent 的增量与服务端快照怎么合并、
 * 一轮收尾用哪份数据、失败算不算终态 —— 全部归 `@ai-zen/agents-client` 的 `SessionStream`
 * （纯状态机，零 I/O）。那是这条规则在本仓与 CLI 之间**唯一**的一份实现：在这一层再攒一份，
 * 两份的边界情形迟早分叉，而分叉只在竞态里显形（「答案凭空短一截」「子任务失败显示成
 * 成功」）。这里只剩三件事：
 *
 *   1. **一段会话一台状态机**（`Map<conversationId, SessionStream>`）。
 *
 *      桌面端与 TUI 不同：**一条连接、多段会话并发**（`stores/chat.ts` 的
 *      `byConversation`，后台会话继续收事件）。所以这里不套包里那个「一个
 *      `SessionChannel` 代表当前会话」的形态 —— `SessionChannel` 自带连接、重连与
 *      `events.watch`，而这三件事 main 已经用 `ServerConnection` 解决过（`./index.ts` 只
 *      建一条连接）。再套一层就是第二份「哪条连接」的记账，那是这类 bug 的老家。
 *   2. **状态 → `ChatStreamEvent`**：`stream.state` 是唯一输入。推出去的成员不多不少就是
 *      render 认的那 9 个（`start` / `user` / `message` / `done` / `migrated` / `error` /
 *      `renamed` / `notice` / `agents`）。
 *   3. **桌面端独有的两件事**（包里不管，也不该管，见下）。
 *
 * ## 桌面端独有，留在 main 的两件事
 *
 * - **`user` 事件的正文**：协议**不推用户消息**（`chunk-parsed` 只有模型增量），而 render
 *   的 `user` 事件要正文才能上屏。正文由 `chat.send` 那一侧登记（{@link noteSend}），派发
 *   `start` 时消费掉，占位 id 用 `${会话}:user:${turnId}`（render 的 `v-for` key 要稳定）。
 * - **`session-question` 自动答「跳过」**：桌面端没有提问 UI（`ChatStreamEvent` 里没有这一
 *   类事件），不答就等于让服务端干等 5 分钟超时（用户看不到为什么什么都没
 *   发生）。这条留在 main，**不**塞进 `SessionStream`：纯状态机不该有 Promise 回调，包里
 *   的提问由 `SessionChannel` 的 `answerQuestion` 拿 `policy.answerQuestion` 分派（本端没有用它）。
 *
 * ## 为什么占位 assistant 消息的 id 还在这一层编
 *
 * `ChatStreamEvent.message` 的 `id` 是 render 的 `v-for` key（按 id 就地 upsert：有则替换、
 * 无则追加末尾），而状态机里那条**正在流式**的临时消息刻意**不带 id**（包里的
 * `placeholder()`：收尾快照会给真 id，编一个假的反而在收尾时与它打架，同一条消息两个 id
 * 会被画成两条）。协议不给流式消息 id、状态机也不编 —— 于是「给 render 一个稳定的 key」
 * 只能在通道这一层做：一轮一个 id（`${会话}:assistant:${turnId}`），正文与工具调用都落在
 * 同一条上，`session-tool-calls` 与 `chunk-parsed` 谁先到都一样。
 *
 * ## 收尾 / 迁移：都以服务端快照为准
 *
 * `session-turn-end` 只带 `ok` / `error`，不带消息：补一次 `session.snapshot` 交给
 * `stream.settle(snapshot)`，再把合并结果推成 `done`（消息 `status` 与服务端对历史的清洗
 * 都只有快照里有）。`session-id-changed`（迁移 / 另存为 / **一轮进行中的自动迁移**）要做
 * **别名收敛**（新 id → render 认识的旧 key）：`ChatStreamEvent` 里没有「换 key」这个类型，
 * 不收敛的话一段正在跑的会话会在旧 id 上等一个永远不来的 `session-turn-end`。
 *
 * ## 通知与子 Agent
 *
 * 通知（`session-notice` / `server-notice`）服务端只给 `code + params`，文案由本端出
 * （`notices.ts`，全桌面端就这一份）。丢掉它们的后果不是「少一条提示」，而是**用户看不到
 * 为什么什么都没发生**。子 Agent 的增量（带 `subAgentId`）**不进主对话**（那是另一层对话）：
 * 状态机把它拼进那个子 Agent 自己的临时消息，本层把 `stream.state.subAgents` **整份**推给
 * render —— 整份替换让 render 一个合并口径都不需要。
 */

import {
  AGENT_EVENTS,
  SERVER_EVENTS,
  SESSION_EVENTS,
  SESSION_METHODS,
  SessionStream,
  type AgentChunkEvent,
  type AgentSubAgentEndEvent,
  type AgentSubAgentStartEvent,
  type AgentToolCallEndEvent,
  type ServerClient,
  type ServerConnection,
  type ServerNoticeEvent,
  type SessionAnswerResult,
  type SessionIdChangedEvent,
  type SessionNoticeEvent,
  type SessionPhaseEvent,
  type SessionQuestionEvent,
  type SessionSnapshotResult,
  type SessionStreamState,
  type SessionTitleChangedEvent,
  type SessionTurnEndEvent,
  type SubAgentSnapshotResult,
} from "@ai-zen/agents-client";
// 运行期要它的 `Role` 枚举：core 的产物运行期只加载 `@ai-zen/event-bus`（`openai` 在 core
// 里只占类型位置），所以这条边不会把模型库拉进 main 的握手/事件路径
import { AgentNS } from "@ai-zen/agents-core";
import type { ChatStreamEvent } from "@ai-zen/desktop-shared";
import type { ProtocolCall } from "./call.js";
import { noticeText } from "./notices.js";

/**
 * 占位 assistant 消息的 role。
 *
 * 直接取 core 的枚举：`AgentNS.Role` 是运行期值，而 core 的产物运行期只加载
 * `@ai-zen/event-bus`（`openai` 在 core 里只占类型位置），所以这一个字符串的代价是零。
 * 抄一个字面量当镜像反而多出第二个定义 —— 枚举加一个角色、镜像照旧时，比较就会静默失效。
 */
const ASSISTANT_ROLE = AgentNS.Role.Assistant;

/**
 * 一轮的「通道侧」记账 —— 状态机不管的那部分。
 *
 * `SessionStream` 管消息、阶段、子 Agent、失败终态；「`user` + `start` 派发过没有」与
 * 「推给 render 的占位消息 id 是什么」是**通道**的事（render 的事件契约，协议里没有对应
 * 概念），所以留在这里。收尾时整条丢弃。
 */
interface TurnTrack {
  /** 服务端在事件里给的轮次编号（会话内从 1 起，**进程重启后从 1 重来**，见 {@link adoptSnapshot}） */
  turnId: number;
  /** 是否已经派发过 `user` + `start`（协议没有「开始」事件，只能由阶段变化推一次） */
  started: boolean;
  /** 占位 assistant 消息的 id（render 的 `v-for` key，见文件头）；还没推过时为 `null` */
  messageId: string | null;
}

export interface ChatEventBridgeOptions {
  /**
   * 那一条常驻连接：本层只用它做**订阅**这一侧的事 ——
   * `client()`（拿当前活着的连接挂监听）、`watch()`（让这条连接开始收事件）、
   * `onOpen()`（连接换了一条就重挂监听）。
   *
   * 它**不是**发请求的入口（那是 {@link ChatEventBridgeOptions.call}）：包里那个
   * `ServerConnection` 刻意不管「怎么发一个请求」，两件事分开之后，没有任何一个字段能
   * 缓存住一条会过期的 client。
   */
  connection: ServerConnection;
  /** 发一次协议调用（收尾要的快照、提问的回答、子 Agent 的快照都走它） */
  call: ProtocolCall;
  /** 推给 render（桌面端是 `webContents.send("chat:push")`；用例里是一个收集函数） */
  push: (event: ChatStreamEvent) => void;
}

export class ChatEventBridge {
  /** 会话（render 认识的 id，见 {@link keyOf}）→ 它那台状态机 */
  private readonly streams = new Map<string, SessionStream>();
  /** 会话 → 这一轮的通道侧记账（收尾后丢弃，见 {@link TurnTrack}） */
  private readonly turns = new Map<string, TurnTrack>();
  /**
   * 本次发送的正文：协议不推用户消息，而 render 的 `user` 事件要正文才能上屏。
   * 发送时登记，派发 `start` 时消费掉。
   */
  private readonly sends = new Map<string, string>();
  /** 换过 id 的会话：新 id → render 认识的旧 key（见 {@link onIdChanged}） */
  private readonly aliases = new Map<string, string>();
  /**
   * 当前这一组订阅（挂在 `bound` 那条连接上）。
   *
   * 它必须能被**整组换掉**：监听挂在具体的 `ServerClient` 上，而连接会换（daemon 重启 →
   * 包里那个 `ServerConnection` 重建一条）。旧连接上的订阅在断开那一刻就已经失效（socket
   * 客户端会 `listeners.clear()`），留着既没用，又会让这个数组每重连一次长一截。
   */
  private subscriptions: Array<() => void> = [];
  /** 上面那一组订阅挂在哪条连接上（`null` = 还没挂过） */
  private bound: ServerClient | null = null;
  /** 对「一条新连接就绪」的订阅（`dispose` 时摘掉） */
  private unsubscribeOpen: (() => void) | null = null;

  constructor(private readonly options: ChatEventBridgeOptions) {}

  /**
   * 连上服务端、订阅事件、让这条连接开始收事件。
   *
   * 必须在任何 `chat.send` 之前完成：服务端在 `send` 的**回执之前**就会推第一条阶段
   * 事件，订阅晚一步就会漏掉「这一轮开始了」—— 界面于是只看到正文在长、却一直不进
   * 流式态。
   *
   * ## 订阅跟着连接走（`onOpen`）
   *
   * 监听挂在**具体那条** `ServerClient` 上，而连接会换（daemon 重启、socket 断了由包里的
   * `ServerConnection` 重建）。不重挂的话，新连接能发请求、却**一个事件也收不到**，症状是
   * 界面安静地不动（不报错、不重连、也没有提示）。
   */
  async start(): Promise<void> {
    this.unsubscribeOpen = this.options.connection.onOpen(() => {
      // 重建的那一次不必让调用方等：`start()` 自己那一下已经保证「首次一定挂上」，而重挂
      // 失败不该抛进一个没人 await 的栈 —— 下一次取用会再建一条，那时还会再挂一次
      void this.rebind().catch(() => {});
    });
    await this.rebind();
  }

  /**
   * 在**当前**那条连接上挂好监听，并让它开始收事件。
   *
   * 顺序是必须的：**先挂监听，再 `watch()`**。反过来的话，「服务端已登记订阅者」到「客户端
   * 挂上监听」之间有一个窗口，那期间推来的事件没有接收者。`watch()` 幂等（包里按连接记账），
   * 多发一帧的后果是服务端每帧多注册一个订阅者，屏幕上的答案会被切成两遍。
   */
  private async rebind(): Promise<void> {
    const client = await this.options.connection.client();
    this.attach(client);
    await this.options.connection.watch();
  }

  /** 把这一组订阅挂到 `client` 上（同一个对象重复调用是空操作：连接没换就不重订） */
  private attach(client: ServerClient): void {
    if (this.bound === client) return;
    for (const off of this.subscriptions.splice(0)) off();
    this.bound = client;
    this.subscriptions.push(
      client.on(SESSION_EVENTS.phase, (event) => this.onPhase(event)),
      client.on(AGENT_EVENTS.chunk, (event) => this.onChunk(event)),
      client.on(AGENT_EVENTS.toolCallEnd, (event) => this.onMessageAppended(event)),
      client.on(AGENT_EVENTS.subAgentStart, (event) => this.onSubAgentStarted(event)),
      client.on(AGENT_EVENTS.subAgentEnd, (event) => this.onSubAgentEnded(event)),
      client.on(SESSION_EVENTS.turnEnd, (event) => this.onTurnEnd(event)),
      client.on(SESSION_EVENTS.idChanged, (event) => this.onIdChanged(event)),
      client.on(SESSION_EVENTS.titleChanged, (event) => this.onTitleChanged(event)),
      client.on(SESSION_EVENTS.question, (event) => this.onQuestion(event)),
      client.on(SESSION_EVENTS.notice, (event) => this.onNotice(event)),
      client.on(SERVER_EVENTS.notice, (event) => this.onServerNotice(event)),
    );
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
   * 不让 IPC 抛错，而是走这条事件通道 —— render 的 `send()` 因此永远正常返回，错误条由
   * 事件驱动。
   */
  pushError(conversationId: string, message: string): void {
    this.options.push({ conversationId, type: "error", message });
  }

  /**
   * 把服务端快照当**新基线**喂给状态机（`chat.getState` 那条路：render 点开一段会话）。
   *
   * ## 为什么要走这一趟（不能只是把快照回给 render）
   *
   * 状态机是**长命**的（一段会话一台），而服务端的轮次计数**短命**：`turnId` 是会话内的
   * 编号、服务端每轮 +1，进程重启后从 0 重新数（`LiveSession` 初值 0；`session.attach` 把
   * 存档装回来的会话也是 0；一次 `session.close` 之后再装回同样如此）。于是「上一个进程里
   * 停在第 3 轮」与「这个进程的第 3 轮」是同一个数字，而状态机里那份拼接态（拼了一半的
   * 正文、在飞的轮次）属于那个已经不在的进程 —— 不校正的话，新答案会接在旧半句后面长，
   * 屏幕上就是「答案凭空多出一截上一轮的话」。
   *
   * 判据只能来自服务端：快照里的 `turnId` 比手上的**小**，说明它的计数在往回走（同一个
   * 进程里轮次只增不减），手上这一轮是残影。包里 `SessionChannel` 收尾时做的是同一件事的
   * 另一面（`Math.max(snapshot.turnId, pendingTurn.turnId ?? 0)`：快照的编号可能比我们等的那个小，
   * 别让较小的那个把在等的一轮判成不存在）—— 两处都必须以「较大值才是我们知道的真相」
   * 为准。
   *
   * 怎么做：丢掉残影（轮次记账 + 那台状态机整台换掉，别让它那份拼接态被合并规则当成
   * 「本地更全」留下来），再以快照为基线重开一台。
   */
  noteSnapshot(conversationId: string, snapshot: SessionSnapshotResult): void {
    this.adoptSnapshot(conversationId, snapshot);
  }

  /** 断开订阅（连接本身由 `ServerConnection` 负责） */
  dispose(): void {
    this.unsubscribeOpen?.();
    this.unsubscribeOpen = null;
    for (const off of this.subscriptions.splice(0)) off();
    this.bound = null;
  }

  // ==================================================================
  // 事件翻译
  // ==================================================================

  /**
   * 阶段变化 → `user` + `start`。
   *
   * 阶段本身先喂给状态机（它才是「这一轮在跑没有」的唯一记账处）。`phase === null` 是
   * 「本轮回到空闲」，收尾归 `session-turn-end`（它带 `ok` / `error`，之后还要补快照）
   * —— 这里不重复收尾，否则一轮会派发两次 `done`。
   */
  private onPhase(event: SessionPhaseEvent): void {
    const key = this.keyOf(event.sessionId);
    const stream = this.streamOf(key);
    stream.setPhase(event.phase);
    if (event.phase === null) return;

    const track = this.openTurn(key, event.turnId);
    if (track.started) return;
    track.started = true;

    const content = this.sends.get(key);
    if (content !== undefined) {
      this.sends.delete(key);
      // id 是客户端编的：协议不推用户消息（文件头「桌面端独有」第 1 条），而 render 按 id
      // 做 `v-for` key。收尾那次 `done` 会把整份消息换成服务端那份（带真 id）。
      this.options.push({
        conversationId: key,
        type: "user",
        id: `${key}:user:${track.turnId}`,
        content,
      });
    }
    this.options.push({ conversationId: key, type: "start" });
  }

  /**
   * 一片**原始 chunk** → 状态机用 core 的 `applyChunk` 折进那条正在拼的 assistant 消息
   * （正文、推理、工具调用的组装、流末用量与结束原因都在这一片里）。
   *
   * 带 `subAgentId` 的那一支不是「主对话的增量」，而是**另一个对话**（子 Agent）的：交给
   * 状态机分流（它自己按 `subAgentId` 各存一份拼接态），本层只把栏目整份推出去。混在一起
   * 的后果不是「多一行」，而是主回答里凭空长出一段子 Agent 的正文。
   *
   * 「状态没变就别推」用**引用比较**：`SessionStream` 的状态是不可变的（每次变更换一个新
   * 对象），没变就是同一个对象。
   */
  private onChunk(event: AgentChunkEvent): void {
    const key = this.keyOf(event.sessionId);
    const stream = this.streamOf(key);
    const before = stream.state;
    if (event.subAgentId) {
      stream.subAgentChunk(event.subAgentId, event.chunk);
      if (stream.state !== before) this.pushAgents(key, stream.state);
      return;
    }
    stream.applyChunk(event.chunk);
    if (stream.state !== before) this.pushStreamed(key, stream.state, event.turnId);
  }

  /**
   * 一条**已经定型**的工具结果消息 → `type: "message"`，原样搬给 render。
   *
   * 服务端推过来的是那一刻就定型了的那条消息**本身**（`role: "tool"` + `tool_call_id` +
   * `name` + 正文 + `status`），与收尾快照里的是同一份东西 —— `stream.applyMessageAppended`
   * 放进状态里的就是**这一个对象**，所以没有「第二份表示」可言：`id` 是服务端真实 id，
   * 与随后的 `done` 里那一条相同，render 按 id upsert 不会画成两条。
   *
   * 顺序别假设：服务端是「谁先跑完谁先推」（并行时后开始的工具可能先完成），所以这里不插
   * 到指定位置、也不假设上一条是谁 —— render 的追加语义就是它的正确语义。
   */
  private onMessageAppended(event: AgentToolCallEndEvent): void {
    const key = this.keyOf(event.sessionId);
    this.streamOf(key).applyMessageAppended(event.message);
    this.options.push({
      conversationId: key,
      type: "message",
      id: event.message.id,
      message: event.message,
    });
  }

  /**
   * 一个子 Agent 开工 → 栏目里多一条 `running`，并立刻拉一次快照补已有内容。
   *
   * `id` / `index` 都用服务端给的：`index` 是展示序号（本轮内从 1 起，栏目标签直接印它），
   * `subAgentId` 是稳定标识（选中态与 `v-for` key 靠它）。客户端不自己数 —— 它要在「中途
   * 接上连接」「切到某一栏」时都对得上，而那时本地一个数都没数过。
   *
   * 快照是**补内容**，不是拉状态：`index` / `status` 已经由事件给过。拉不到就静默（增量照样
   * 拼、`ended` 照样改状态、收尾照样清空），在一条成功的委派上凭空弹红字才是错的。
   */
  private onSubAgentStarted(event: AgentSubAgentStartEvent): void {
    const key = this.keyOf(event.sessionId);
    const stream = this.streamOf(key);
    const before = stream.state;
    stream.subAgentStarted({ subAgentId: event.subAgentId, index: event.index });
    if (stream.state !== before) this.pushAgents(key, stream.state);
    void this.syncSubAgent(event.sessionId, event.subAgentId).catch(() => {});
  }

  /**
   * 一个子 Agent 收尾 → 只改状态（正文由增量与快照负责）。
   *
   * `failed` 不被随后的 `done` 覆盖那条规则在状态机里（core 在 `finally` 里分发收尾事件，
   * 出错的那次也照样会来一条）—— 本层只搬运结果。
   */
  private onSubAgentEnded(event: AgentSubAgentEndEvent): void {
    const key = this.keyOf(event.sessionId);
    const stream = this.streamOf(key);
    const before = stream.state;
    stream.subAgentEnded({ subAgentId: event.subAgentId, status: event.status });
    if (stream.state !== before) this.pushAgents(key, stream.state);
  }

  private onTurnEnd(event: SessionTurnEndEvent): void {
    void this.finishTurn(event).catch((error: unknown) => {
      // 快照拿不到（连接断了 / 会话刚被收掉）：没有权威消息可给，但 render 正等着收尾。
      // 走它认识的错误通道 —— `error` 会把流式态收掉，否则界面永久停在「生成中」。
      // （不能在这里推一份「本地近似」的 `done`：状态机里那条占位消息**没有 id**，而
      // render 的 `done` 直接拿它替换整个列表，`v-for` 会拿到一个 undefined 的 key。）
      this.options.push({
        conversationId: this.keyOf(event.sessionId),
        type: "error",
        message: messageOf(error),
      });
    });
  }

  /**
   * 一轮收尾：补一次快照，交给状态机对账，再把结果推成 `done`。
   *
   * 为什么不把本地拼的那条流当作结果：工具调用参数、消息 status（`completed` /
   * `aborted` / `error`）与服务端对历史的清洗都只有服务端有；客户端拼出来的只是「能让屏幕
   * 滚起来的近似」。合并规则（尤其「宁可重复也不吞字」）在包里的 `mergeStreamedSnapshot`，
   * 由 `stream.settle()` 执行，本文件一行都不再碰。
   */
  private async finishTurn(event: SessionTurnEndEvent): Promise<void> {
    const key = this.keyOf(event.sessionId);
    const stream = this.streamOf(key);
    // 子 Agent 只活当前这一轮：`settle()` 会把栏目收掉，收之前记一下有没有东西要通知
    const hadAgents = stream.state.subAgents.length > 0;

    let snapshot: SessionSnapshotResult;
    try {
      snapshot = await this.options.call<SessionSnapshotResult>(SESSION_METHODS.snapshot, {
        sessionId: event.sessionId,
      });
    } catch (error) {
      // 拿不到快照也要把这一轮在本地收掉（拼接态丢掉），否则下一轮的增量会接着往那条
      // 已经死掉的临时消息上拼
      stream.settle(null);
      if (hadAgents) this.pushAgents(key, stream.state);
      throw error;
    }

    // 收尾期间下一轮可能已经开始（用户点得快）：只清掉属于**这一轮**的槽位
    if (this.turns.get(key)?.turnId === event.turnId) this.turns.delete(key);

    stream.settle(snapshot);
    // 失败进状态（`failed` 是终态，文案由 render 显示，状态机只收 code + 原话）
    if (event.error) stream.failTurn({ code: event.error.code, message: event.error.message });
    // 空数组 = 「这一轮的子 Agent 都没了」：render 据此把栏目收回去，退回主对话
    if (hadAgents) this.pushAgents(key, stream.state);

    this.options.push({ conversationId: key, type: "done", messages: stream.state.messages });
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
   * （不做的话，一段正在跑的会话会在旧 id 上等一个永远不来的 `session-turn-end`，界面卡死）。
   * 迁移之后的内容是另一份历史，所以同时补一份快照推 `migrated`（render 的全量替换语义）。
   */
  private onIdChanged(event: SessionIdChangedEvent): void {
    const key = this.keyOf(event.from);
    this.aliases.set(event.sessionId, key);
    const stream = this.streamOf(key);
    const hadAgents = stream.state.subAgents.length > 0;
    // 换了 id = 换了一段会话（迁移 / 另存为）：上一段里的子 Agent 不该跟着过来（服务端此刻
    // 也把它们清掉了）。不清的话，栏目会停在一段点进去永远拉不到快照的对话上。
    stream.applyIdChanged(event.sessionId);
    if (hadAgents) this.pushAgents(key, stream.state);

    void this.options
      .call<SessionSnapshotResult>(SESSION_METHODS.snapshot, { sessionId: event.sessionId })
      .then((snapshot) => {
        this.adoptSnapshot(key, snapshot);
        this.options.push({
          conversationId: key,
          type: "migrated",
          messages: stream.state.messages,
        });
      })
      .catch((error: unknown) => {
        // 拿不到新会话的快照时，画面只能靠已知内容停住，但错误必须说出去
        this.options.push({ conversationId: key, type: "error", message: messageOf(error) });
      });
  }

  /**
   * 服务端在自动迁移之前问「用哪种方式交接」→ 立刻按**跳过**回答（`choice: null`）。
   *
   * 服务端发出 `session-question` 之后会一直等（等满 `ASK_TIMEOUT_MS`，5 分钟）。桌面端
   * 没有提问 UI，也就是说这 5 分钟里没有任何人看得见这个问题 —— 用户那边的感受是「界面像
   * 是死了 5 分钟」。`choice: null` 与服务端这条退路的取值是**同一个答案**（`fallback` 就是
   * `null`），所以这里没有替用户做决定，只是把那个超时提前表达出来。
   *
   * 失败不报人看：连接断了 / 会话刚被收掉 / 来晚了，服务端那边本来就会走 `fallback`，结果
   * 与「答成功了」完全一样 —— 弹一条红字只会让一次本来就没事的自动迁移看起来坏了。
   *
   * 「桌面端答不了」是这一层的**限制**，不是产品语义：有提问 UI 的客户端会把 `kind` /
   * `options` 交给用户、点了才调 `session.answer`；没有 UI 时，早答 `null` 与等满超时
   * 是同一个结果。
   */
  private onQuestion(event: SessionQuestionEvent): void {
    void this.options
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
   * 对话内通知 → `notice`（**带** `conversationId`，走 `keyOf`）。
   *
   * 报服务端 id 的话，换过 id 的会话（迁移 / 另存为）会把通知贴到一段 render 从没见过、
   * 也永远不会选中过的会话上，等于又回到「什么都没发生」。
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
   * 服务端通知（`server-notice`）→ `notice` 且**不给** `conversationId`。
   *
   * 它不属于任何会话（存档目录不可用、MCP 连不上是服务本身的事）：填个空串等于声称
   * 「有一个 key 为空的会话」，render 会照着这个 key 开一个假槽位；省掉这个字段才是
   * 「没有会话」—— `ChatStreamEvent.notice` 把它定义成可选就是为了这个。
   */
  private onServerNotice(event: ServerNoticeEvent): void {
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
   * 拉一次子 Agent 快照并交给状态机合并（`session.subAgent.snapshot`）。
   *
   * 合并规则（快照那个往返可能比第一批增量还慢，直接赋值会让屏幕上已经流出来的正文凭空短
   * 一截）在包里的 `mergeStreamedSnapshot`，由状态机的 `subAgentSnapshot()` 执行。栏目在
   * 往返期间被收掉（这一轮收了尾 / 换了 id）时状态机自己会忽略这次快照 —— 本层不必再判。
   */
  private async syncSubAgent(sessionId: string, subAgentId: string): Promise<void> {
    const snapshot = await this.options.call<SubAgentSnapshotResult>(
      SESSION_METHODS.subAgentSnapshot,
      // 用服务端给的 id（不是 `keyOf`）：这条请求认的是服务端自己的会话键
      { sessionId, subAgentId },
    );
    const key = this.keyOf(sessionId);
    const stream = this.streams.get(key);
    if (!stream) return;
    const before = stream.state;
    stream.subAgentSnapshot(snapshot);
    if (stream.state !== before) this.pushAgents(key, stream.state);
  }

  /** 以服务端快照为新基线；顺手把手上的残影轮次丢掉（见 {@link noteSnapshot}） */
  private adoptSnapshot(key: string, snapshot: SessionSnapshotResult): void {
    const track = this.turns.get(key);
    if (track && snapshot.turnId < track.turnId) {
      // 计数在往回走 = 手上这一轮属于上一个进程（或属于一次被回收后重新装回的会话）：
      // 它的收尾永远不会来了，那份拼接态也不能留给合并规则（「本地更全」会把上一轮的
      // 半句正文接在新答案前面）。整台状态机换掉，以快照为基线重开。
      this.turns.delete(key);
      this.streams.delete(key);
    }
    this.streamOf(key).applySnapshot(snapshot);
  }

  /**
   * 把状态里「正在流式的那条 assistant 消息」翻成 `message` 事件（**整条替换**语义）。
   *
   * 挑法：状态里**最后一条 assistant 消息**。这条规则成立的理由在状态机的形状里 —— 一轮
   * 之内它只维护**一条**临时 assistant 消息（`applyDelta` / `applyToolCalls` 都写它），排在
   * 它后面被追加的只有工具结果（`role: "tool"`，走 `messageAppended` / 快照）。
   *
   * 每次都推全量：render 按 id 整条替换，漏一个字段就等于把已经显示出来的东西抹掉 ——
   * 漏正文（工具调用常常晚于正文到达）、漏工具调用（正文还在继续流）都会在屏幕上看出来。
   */
  private pushStreamed(key: string, state: SessionStreamState, turnId: number): void {
    const message = [...state.messages].reverse().find((item) => item.role === ASSISTANT_ROLE);
    if (!message) return;
    const track = this.openTurn(key, turnId);
    // 状态机那条临时消息刻意不带 id（见文件头）：给 render 的 key 在这里编，一轮一个
    track.messageId ??= `${key}:assistant:${track.turnId}`;
    // 已经带服务端真 id 的那条（收尾快照合并进来的）就用它：同一个 id 才能就地替换
    const id = message.id ?? track.messageId;
    this.options.push({
      conversationId: key,
      type: "message",
      id,
      message: message.id ? message : { ...message, id },
    });
  }

  /**
   * 把整份子 Agent 栏目推给 render（**整份替换**语义）。
   *
   * 不需要拷贝：状态机每次变更都换新对象（`subAgents` 数组、每个视图、每条消息都是），
   * 推出去的那一份因此天然定格在这一刻 —— 本层不再就地改状态里的字段，也就没有拷贝的理由。
   */
  private pushAgents(key: string, state: SessionStreamState): void {
    this.options.push({ conversationId: key, type: "agents", agents: state.subAgents });
  }

  /** render 认识的那个 id（换过 id 的会话收敛回旧 key） */
  private keyOf(sessionId: string): string {
    return this.aliases.get(sessionId) ?? sessionId;
  }

  /** 取（或开）这段会话的状态机 —— 一段会话一台，后台会话继续收事件也走它 */
  private streamOf(key: string): SessionStream {
    const existing = this.streams.get(key);
    if (existing) return existing;
    const stream = new SessionStream({ sessionId: key });
    this.streams.set(key, stream);
    return stream;
  }

  /** 取（或开）这一轮的通道侧记账；`turnId` 变了就是新的一轮 */
  private openTurn(key: string, turnId: number): TurnTrack {
    const existing = this.turns.get(key);
    if (existing && existing.turnId === turnId) return existing;
    const track: TurnTrack = { turnId, started: false, messageId: null };
    this.turns.set(key, track);
    return track;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
