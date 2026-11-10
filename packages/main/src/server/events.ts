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
 * ## 四个必须在这里做掉的翻译（对应协议缺口的降级）
 *
 * 1. **没有「开始」事件** —— 从 `session.phase` 出现非 `null` 推出「这一轮开始了」，
 *    每个 `turnId` 只派发一次 `user` + `start`；
 * 2. **`message.delta` 只有 `text` / `reasoning`** —— 拼进一条**占位** assistant 消息，
 *    消息 id 是客户端生成的（服务端不给 id），`turn.end` 之后由快照全量替换成真实 id；
 *    工具调用的参数/结果在这一阶段**看不到**（协议里没有），只能等收尾那次快照；
 * 3. **`turn.end` 只带 `ok` / `error` 不带消息** —— 收尾补一次 `session.snapshot`，
 *    用全量替换（`done`）把工具结果与消息 status 一次补齐；
 * 4. **`session.phase` 的文案没处放** —— `ChatStreamEvent` 里没有 stage 字段，所以阶段
 *    只用来判「有没有在跑」（派发 `start`、给侧栏的 `running` 提供口径），文案不进 render。
 *
 * ## 没有 render 落点的那几条（协议有、这一阶段不用）
 *
 * `session.notice` / `global.notice` / `session.question` / `session.subAgent.*`：render
 * 侧既没有通知栏、也没有子 Agent 栏目（`ChatStreamEvent` 里没有对应类型，而 D1 不许改
 * render）。所以它们的增量不进主对话 —— 把子 Agent 的正文拼进主回答，等于凭空多出一段
 * 文字。自动迁移的「用哪种方式交接」因此也没人回答：服务端等超时后用它自己的 `fallback`。
 */

import {
  EVENT_METHODS,
  SESSION_EVENTS,
  SESSION_METHODS,
  type MessageDeltaEvent,
  type SessionIdChangedEvent,
  type SessionPhaseEvent,
  type SessionSnapshotResult,
  type SessionTitleChangedEvent,
  type TurnEndEvent,
} from "@ai-zen/agents-client";
// 只要类型：`import type` 在产物里被整体擦除，main 因此不必为了一个 role 字符串把
// agents-core（连带 openai）拉进运行期 —— 握手/事件这条路上一个模型库也不该被加载
import type { AgentNS } from "@ai-zen/agents-core";
import type { ChatStreamEvent } from "@ai-zen/desktop-shared";
import type { ServerConnection } from "./connection.js";

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
      client.on(SESSION_EVENTS.turnEnd, (event) => this.onTurnEnd(event)),
      client.on(SESSION_EVENTS.idChanged, (event) => this.onIdChanged(event)),
      client.on(SESSION_EVENTS.titleChanged, (event) => this.onTitleChanged(event)),
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

  /** 增量 → 占位 assistant 消息（正文 / 推理拼在一起，其余字段只有快照里才有） */
  private onDelta(event: MessageDeltaEvent): void {
    // 带 subAgentId 的增量属于子 Agent：render 没有子对话这个概念（见文件头）
    if (event.subAgentId) return;
    // 只带 usage 的流末 chunk（正文与推理都空）不该在转录里多出一条空消息
    if (!event.text && !event.reasoning) return;

    const key = this.keyOf(event.sessionId);
    const slot = this.slotOf(key, event.turnId);
    slot.text += event.text;
    slot.reasoning += event.reasoning;
    slot.messageId ??= `${key}:assistant:${slot.turnId}`;
    const messageId = slot.messageId;

    const message: AgentNS.Message = {
      id: messageId,
      role: ASSISTANT_ROLE,
      content: slot.text,
      ...(slot.reasoning ? { reasoning_content: slot.reasoning } : {}),
    };
    this.options.push({ conversationId: key, type: "message", id: messageId, message });
  }

  private onTurnEnd(event: TurnEndEvent): void {
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
   * 为什么不把本地拼的那条流当作结果：工具调用参数、工具结果消息、消息 status
   * （`completed` / `aborted` / `error`）与服务端对历史的清洗都只有服务端有。客户端拼
   * 出来的只是「能让屏幕滚起来的近似」，收尾必须换成真件。
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

  /** render 认识的那个 id（换过 id 的会话收敛回旧 key） */
  private keyOf(sessionId: string): string {
    return this.aliases.get(sessionId) ?? sessionId;
  }

  /** 取（或开）这条会话当前这一轮的拼装槽位；`turnId` 变了就是新的一轮 */
  private slotOf(key: string, turnId: number): TurnSlot {
    const existing = this.turns.get(key);
    if (existing && existing.turnId === turnId) return existing;
    const slot: TurnSlot = { turnId, started: false, messageId: null, text: "", reasoning: "" };
    this.turns.set(key, slot);
    return slot;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
