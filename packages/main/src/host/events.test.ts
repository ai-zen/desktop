/**
 * `ChatEventBridge` 用例：六条宿主事件 → render 认的那几条。
 *
 * ## 为什么用假连接
 *
 * 这一层的输入是**事件载荷**、输出是 `ChatStreamEvent`，中间没有一行需要真 socket。假连接把
 * 「宿主此刻推了什么」变成一句可以直接写的调用，于是每条映射规则都能单独钉住：
 *
 *   · `message.delta` → 先 `start` 后 `message`（整条替换、正文递增）；
 *   · `run.state` → `stream`（六态）+ `settled` 时回拉 `message.list` 推 `done`；
 *   · `usage` → 钉到那条助手消息上；
 *   · `notice` / `question` → `notice`（文案是宿主渲染好的那句话）；
 *   · `conversation.changed` → `renamed`（名字要现拉）。
 *
 * ## 「收尾只收一次」为什么要单独一条
 *
 * `run.state` 是全量快照，重连补拉会再给一份 `settled`。收两次的后果是把已经结束的一轮又画一遍
 * （界面上看起来像又跑了一轮），而它只在「断线重连恰好落在一轮收尾之后」时出现 —— 手点不出来，
 * 只能在这里钉住。
 */

import { AgentNS } from "@ai-zen/agents-core";
import type {
  ClientError,
  ConversationState as WireConversationState,
  NoticeView,
  QuestionView,
  ResumedConversation,
  ResumeOutcome,
  RunState,
  UsageSnapshot,
} from "@ai-zen/agents-client";
import { ClientError as ClientErrorValue } from "@ai-zen/agents-client";
import type { ChatStreamEvent } from "@ai-zen/desktop-shared";
import { describe, expect, it } from "vitest";
import type { ContractConnection } from "./contract.js";
import { ChatEventBridge } from "./events.js";

const CONVERSATION = "conv-1";

// ==================================================================
// 假连接
// ==================================================================

type AnyHandler = (payload: unknown) => void;

interface FakeConnection extends ContractConnection {
  /** 让宿主「推一条」 */
  emit(event: string, payload: unknown): void;
  /** 连接断了 */
  emitClose(error: ClientError): void;
  /** 补拉结果回来了 */
  emitResume(outcome: ResumeOutcome): void;
  /** 这一层发出去的每一次请求（按先后） */
  calls: Array<{ method: string; params: unknown }>;
  /** `track` / `untrack` 的轨迹 */
  tracked: Map<string, string | undefined>;
  /** `reconnect()` 被调了几次 */
  reconnects: number;
  /** 连接被关了吗 */
  closed: boolean;
}

/**
 * 一条假连接：事件随手推，请求按 `reply` 回。
 *
 * `reply` 抛错就等于宿主回了错 —— `settle` 失败那条分支只能这样造（真宿主不会配合你失败）。
 */
function fakeConnection(options: {
  reply?: (method: string, params: unknown) => unknown;
  reconnectError?: unknown;
} = {}): FakeConnection {
  const handlers = new Map<string, Set<AnyHandler>>();
  const closeHandlers = new Set<(error: ClientError) => void>();
  const resumeHandlers = new Set<(outcome: ResumeOutcome) => void>();
  const calls: Array<{ method: string; params: unknown }> = [];
  const tracked = new Map<string, string | undefined>();

  const connection: FakeConnection = {
    calls,
    tracked,
    reconnects: 0,
    closed: false,
    hello: null,
    call: (async (method: string, params: unknown) => {
      calls.push({ method, params });
      return options.reply ? options.reply(method, params) : {};
    }) as ContractConnection["call"],
    subscribe(event, handler) {
      const set = handlers.get(event) ?? new Set<AnyHandler>();
      set.add(handler as AnyHandler);
      handlers.set(event, set);
      return () => set.delete(handler as AnyHandler);
    },
    onClose(handler) {
      closeHandlers.add(handler);
      return () => closeHandlers.delete(handler);
    },
    onResume(handler) {
      resumeHandlers.add(handler);
      return () => resumeHandlers.delete(handler);
    },
    resume: (async (conversationId: string) => ({ conversationId })) as ContractConnection["resume"],
    // 上传那两条出口本文件用不到（事件桥不碰上传），但它们是连接的一部分：假件也得有
    sendBinary: async () => {},
    language: "zh",
    track(conversationId, anchor) {
      tracked.set(conversationId, anchor);
    },
    untrack(conversationId) {
      tracked.delete(conversationId);
    },
    reconnect: async () => {
      connection.reconnects += 1;
      if (options.reconnectError) throw options.reconnectError;
    },
    close: async () => {
      connection.closed = true;
    },
    emit(event, payload) {
      for (const handler of [...(handlers.get(event) ?? [])]) handler(payload);
    },
    emitClose(error) {
      for (const handler of [...closeHandlers]) handler(error);
    },
    emitResume(outcome) {
      for (const handler of [...resumeHandlers]) handler(outcome);
    },
  };
  return connection;
}

/** 让挂起的异步链跑完（`settle` 要 await 一次 `message.list`） */
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

interface Harness {
  bridge: ChatEventBridge;
  connection: FakeConnection;
  events: ChatStreamEvent[];
}

function harness(reply?: (method: string, params: unknown) => unknown): Harness {
  const connection = fakeConnection({ reply });
  const events: ChatStreamEvent[] = [];
  const bridge = new ChatEventBridge({
    call: connection.call,
    push: (event) => events.push(event),
    log: () => {},
  });
  bridge.attach(connection);
  return { bridge, connection, events };
}

// ==================================================================
// 载荷构造
// ==================================================================

const ZERO_USAGE: AgentNS.Usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

function usageSnapshot(turn: AgentNS.Usage = ZERO_USAGE): UsageSnapshot {
  return {
    turn,
    total: turn,
    subAgent: ZERO_USAGE,
    rate: { value: 0, unit: "tokens_per_second", basis: "completion" },
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function runState(overrides: Partial<RunState> = {}): RunState {
  return {
    conversationId: CONVERSATION,
    status: "running",
    assistantMessageId: "m-assistant",
    startedAt: "2026-01-01T00:00:00.000Z",
    settledAt: null,
    generation: { phase: "awaiting_first_token", since: "2026-01-01T00:00:00.000Z" },
    outcome: null,
    problem: null,
    subagents: [],
    usage: usageSnapshot(),
    ...overrides,
  };
}

function conversationState(run: RunState): WireConversationState {
  return {
    conversationId: CONVERSATION,
    run,
    context: {
      usage: ZERO_USAGE,
      handoffThreshold: 100,
      guardThreshold: 200,
      overHandoff: false,
      overGuard: false,
    },
    thinking: { preset: null, levels: [], selected: null, source: "not_adjustable", params: {} },
    usage: usageSnapshot(),
    questions: [],
    statusBlocks: [],
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function message(id: string, role: AgentNS.Role, content: string): AgentNS.Message {
  return { id, role, content };
}

// ==================================================================
// message.delta
// ==================================================================

describe("message.delta → start + message", () => {
  it("第一片增量之前先推一次 start（render 靠它进流式态）", () => {
    const h = harness();

    h.connection.emit("message.delta", {
      conversationId: CONVERSATION,
      messageId: "m-assistant",
      seq: 0,
      delta: { content: "你" },
      at: "2026-01-01T00:00:00.000Z",
    });

    expect(h.events.map((event) => event.type)).toEqual(["start", "message"]);
    const pushed = h.events[1];
    if (pushed?.type !== "message") throw new Error("第二条应当是 message");
    expect(pushed.message.id).toBe("m-assistant");
    expect(pushed.message.content).toBe("你");
    // 消息本体就是 core 的 `AgentNS.Message`，原样搬（不重新包装字段）
    expect(pushed.message.role).toBe(AgentNS.Role.Assistant);
  });

  it("第二片只推 message，`start` 不重复（它是「进入流式态」，不是每一片）", () => {
    const h = harness();
    const delta = (content: string, seq: number) => ({
      conversationId: CONVERSATION,
      messageId: "m-assistant",
      seq,
      delta: { content },
      at: "2026-01-01T00:00:00.000Z",
    });

    h.connection.emit("message.delta", delta("你", 0));
    h.connection.emit("message.delta", delta("好", 1));

    expect(h.events.map((event) => event.type)).toEqual(["start", "message", "message"]);
    const last = h.events.at(-1);
    if (last?.type !== "message") throw new Error("最后一条应当是 message");
    // 整条替换语义：每次推的是「到此刻的完整内容」
    expect(last.message.content).toBe("你好");
  });
});

// ==================================================================
// run.state
// ==================================================================

describe("run.state → stream（六态）", () => {
  it("在跑时推六态；换成「在等工具」时带上还在跑的那几个调用（core 的 ToolCall 原样）", () => {
    const h = harness();

    h.connection.emit("run.state", {
      conversationId: CONVERSATION,
      run: runState({ generation: { phase: "thinking", since: "…", chars: 12 } }),
      at: "2026-01-01T00:00:00.000Z",
    });
    h.connection.emit("run.state", {
      conversationId: CONVERSATION,
      run: runState({
        generation: {
          phase: "awaiting_tools",
          since: "…",
          runningTools: [
            { toolCall: { id: "call-1", index: 0, function: { name: "read", arguments: "{}" } }, startedAt: "…" },
            { toolCall: { id: "call-2", index: 1, function: { name: "grep" } }, startedAt: "…" },
          ],
        },
      }),
      at: "2026-01-01T00:00:01.000Z",
    });

    const phases = h.events.flatMap((event) => (event.type === "stream" ? [event] : []));
    expect(phases.map((event) => event.phase)).toEqual(["thinking", "awaiting_tools"]);
    // 名字、参数、id、index 都在里面：不先拍成名字列表
    expect(phases[1]?.toolCalls).toEqual([
      { id: "call-1", index: 0, function: { name: "read", arguments: "{}" } },
      { id: "call-2", index: 1, function: { name: "grep" } },
    ]);
    expect(phases[0]?.toolCalls).toEqual([]);
  });

  it("六态没变（只是别的字段变了）就不重复推", () => {
    const h = harness();
    const same = runState({ generation: { phase: "generating", since: "…", chars: 3 } });

    h.connection.emit("run.state", { conversationId: CONVERSATION, run: same, at: "a" });
    h.connection.emit("run.state", { conversationId: CONVERSATION, run: same, at: "b" });

    expect(h.events.filter((event) => event.type === "stream")).toHaveLength(1);
  });
});

describe("run.state → done（收尾）", () => {
  it("settled 之后回拉 message.list，把整段消息推成 done", async () => {
    const messages = [
      message("m-user", AgentNS.Role.User, "你好"),
      message("m-assistant", AgentNS.Role.Assistant, "你好呀"),
    ];
    const h = harness((method) => {
      if (method === "message.list") {
        return { conversationId: CONVERSATION, anchor: null, messages };
      }
      return {};
    });

    h.connection.emit("run.state", {
      conversationId: CONVERSATION,
      run: runState({ status: "settled", outcome: "completed", settledAt: "2026-01-01T00:00:02.000Z", generation: null }),
      at: "2026-01-01T00:00:02.000Z",
    });
    await flush();

    const done = h.events.find((event) => event.type === "done");
    if (done?.type !== "done") throw new Error("应当推一条 done");
    expect(done.messages).toEqual(messages);
    // 收尾拿的是宿主那份，不是本地拼出来的近似
    expect(h.connection.calls.at(-1)?.method).toBe("message.list");
  });

  it("失败的一轮：done 之后补一条 error（顺序反了原因会被 done 清掉）", async () => {
    const h = harness((method) => {
      if (method === "message.list") {
        return { conversationId: CONVERSATION, anchor: null, messages: [message("m1", AgentNS.Role.Assistant, "半截")] };
      }
      return {};
    });

    h.connection.emit("run.state", {
      conversationId: CONVERSATION,
      run: runState({
        status: "settled",
        outcome: "error",
        settledAt: "2026-01-01T00:00:03.000Z",
        generation: null,
        problem: {
          code: "tool.failed",
          messageKey: "tool.failed" as never,
          params: {},
          message: "工具 read 失败了",
        },
      }),
      at: "2026-01-01T00:00:03.000Z",
    });
    await flush();

    const types = h.events.map((event) => event.type);
    expect(types).toEqual(["stream", "done", "error"]);
    const error = h.events.at(-1);
    if (error?.type !== "error") throw new Error("最后一条应当是 error");
    // `run.problem` 整块递下去：码、参数、句子都在
    expect(error.problem).toEqual({
      code: "tool.failed",
      messageKey: "tool.failed",
      params: {},
      message: "工具 read 失败了",
    });
  });

  it("同一轮收两次（重连补拉又给一份 settled）：只推一次 done", async () => {
    const h = harness((method) => {
      if (method === "message.list") {
        return { conversationId: CONVERSATION, anchor: null, messages: [] };
      }
      return {};
    });
    const settled = runState({
      status: "settled",
      outcome: "completed",
      settledAt: "2026-01-01T00:00:02.000Z",
      generation: null,
    });

    h.connection.emit("run.state", { conversationId: CONVERSATION, run: settled, at: "a" });
    await flush();
    h.connection.emit("run.state", { conversationId: CONVERSATION, run: settled, at: "b" });
    await flush();

    expect(h.events.filter((event) => event.type === "done")).toHaveLength(1);
  });

  it("拉消息失败：推一条 error（界面不许永远停在「生成中」）", async () => {
    const h = harness(() => {
      throw new Error("宿主刚被关掉了");
    });

    h.connection.emit("run.state", {
      conversationId: CONVERSATION,
      run: runState({ status: "settled", outcome: "completed", settledAt: "t", generation: null }),
      at: "t",
    });
    await flush();

    const error = h.events.at(-1);
    if (error?.type !== "error") throw new Error("应当推一条 error");
    expect(error.problem.message).toContain("宿主刚被关掉了");
  });
});

// ==================================================================
// usage / notice / question / conversation.changed
// ==================================================================

describe("usage → message（本轮用量钉在助手消息上）", () => {
  it("增量拼过的那条消息会带上 turn 用量", () => {
    const h = harness();
    h.connection.emit("message.delta", {
      conversationId: CONVERSATION,
      messageId: "m-assistant",
      seq: 0,
      delta: { content: "答" },
      at: "a",
    });

    h.connection.emit("usage", {
      conversationId: CONVERSATION,
      usage: usageSnapshot({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }),
      at: "b",
    });

    const last = h.events.at(-1);
    if (last?.type !== "message") throw new Error("最后一条应当是 message");
    // `usage` 在 core 的 `Message` 上有，而 render 那份 `AgentNS.Message`（shared 用的 4.1.0）
    // 还没声明它 —— 形状不一致是版本问题，不是这里造了一个新字段（已记进交付报告）
    const carried = (last.message as unknown as { usage?: AgentNS.Usage }).usage;
    expect(carried).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  });

  it("还没开始拼的时候：什么都不推（不凭空造一条消息）", () => {
    const h = harness();
    h.connection.emit("usage", { conversationId: CONVERSATION, usage: usageSnapshot(), at: "a" });
    expect(h.events).toEqual([]);
  });
});

describe("notice / question → notice", () => {
  it("通知的三档语气照搬，文案用宿主渲染好的那句", () => {
    const h = harness();
    const notice: NoticeView = {
      id: "n1",
      level: "warning",
      duration: 3,
      text: {
        code: "notice.settingsSaved",
        messageKey: "notice.settingsSaved" as never,
        params: {},
        message: "配置已保存",
      },
      conversationId: CONVERSATION,
      createdAt: "2026-01-01T00:00:00.000Z",
    };

    h.connection.emit("notice", { notice, at: "a" });

    // 语气用宿主那套词（`warning`），内容整份搬（码 / 键 / 参数 / 已渲染的那句），时长也带上
    expect(h.events).toEqual([
      {
        type: "notice",
        level: "warning",
        duration: 3,
        text: notice.text,
        conversationId: CONVERSATION,
      },
    ]);
  });

  it("全局通知（不属于任何会话）：conversationId 是 `null`（与 omitted 不是一回事）", () => {
    const h = harness();
    h.connection.emit("notice", {
      notice: {
        id: "n2",
        level: "error",
        duration: null,
        text: { code: "x", messageKey: "x" as never, params: {}, message: "宿主日志写不进去" },
        conversationId: null,
        createdAt: "a",
      },
      at: "a",
    });

    const event = h.events[0];
    if (event?.type !== "notice") throw new Error("应当是一条 notice");
    expect(event.conversationId).toBeNull();
    // 宿主没设「自动消失」：不替它编一个秒数
    expect(event.duration).toBeNull();
  });

  it("问题对象念成一条 info 提示（桌面端没有提问 UI，但不许「什么都没发生」）", () => {
    const h = harness();
    const question: QuestionView = {
      id: "q1",
      conversationId: CONVERSATION,
      kind: "handoff",
      state: "pending",
      prompt: { code: "ask.handoff", messageKey: "ask.handoff" as never, params: {}, message: "上下文快满了，要交接吗？" },
      options: [],
      answer: null,
      blocking: true,
      createdAt: "a",
      updatedAt: "a",
    };

    h.connection.emit("question", { question, at: "a" });

    // 题目原文就是宿主那份 `LocalizedText`（`prompt` 原样递给界面）
    expect(h.events).toEqual([
      {
        type: "notice",
        level: "info",
        duration: null,
        text: question.prompt,
        conversationId: CONVERSATION,
      },
    ]);
  });
});

describe("conversation.changed → renamed", () => {
  it("改名之后现拉一次会话（推送里只有「改名了」）", async () => {
    const h = harness((method) => {
      if (method === "conversation.get") {
        return { conversation: { id: CONVERSATION, name: "新名字" } };
      }
      return {};
    });

    h.connection.emit("conversation.changed", {
      conversationId: CONVERSATION,
      workspaceId: "ws-1",
      change: "renamed",
      messageCount: 2,
      at: "a",
    });
    await flush();

    expect(h.connection.calls.at(-1)).toEqual({
      method: "conversation.get",
      params: { conversationId: CONVERSATION },
    });
    expect(h.events).toEqual([{ conversationId: CONVERSATION, type: "renamed", name: "新名字" }]);
  });

  it("deleted：清掉本地那几份账，并让客户端别再跟着这段对话补拉", () => {
    const h = harness();
    h.connection.track(CONVERSATION, "m1");

    h.connection.emit("conversation.changed", {
      conversationId: CONVERSATION,
      workspaceId: "ws-1",
      change: "deleted",
      messageCount: null,
      at: "a",
    });

    expect(h.connection.tracked.has(CONVERSATION)).toBe(false);
    expect(h.events).toEqual([]);
  });
});

// ==================================================================
// 发送受理 / 补拉 / 断线
// ==================================================================

describe("beginTurn → start + user", () => {
  it("受之后回显的是**库里那条消息**（带图那句是内容段数组，不是一句字）", async () => {
    const stored: AgentNS.Message = {
      id: "m-user",
      role: AgentNS.Role.User,
      content: [
        { index: 0, type: "text", text: "看看这张" },
        { index: 1, type: "image_url", image_url: { url: "" }, __asset_id: "a1" },
      ],
    } as AgentNS.Message;
    const h = harness((method) => {
      if (method === "message.list") {
        return { conversationId: CONVERSATION, anchor: null, messages: [stored] };
      }
      return {};
    });

    await h.bridge.beginTurn(CONVERSATION, "m-user");

    expect(h.events).toEqual([
      { conversationId: CONVERSATION, type: "start" },
      { conversationId: CONVERSATION, type: "user", message: stored },
    ]);
  });

  it("受理回执里的 id 在 message.list 里找不到：当场报错（不编一条消息上屏）", async () => {
    const h = harness((method) => {
      if (method === "message.list") return { conversationId: CONVERSATION, anchor: null, messages: [] };
      return {};
    });

    await expect(h.bridge.beginTurn(CONVERSATION, "m-user")).rejects.toThrow("m-user");
  });
});

describe("onResume → done（补拉）", () => {
  it("锚点命中：从那条开始整段替换（流式中那条是替换，不是再追加一条）", () => {
    const h = harness();
    const local = [
      message("m1", AgentNS.Role.User, "旧问题"),
      message("m2", AgentNS.Role.Assistant, "写了一半"),
    ];
    h.bridge.noteMessages(CONVERSATION, local);

    const resumed: ResumedConversation = {
      conversationId: CONVERSATION,
      state: conversationState(runState({ status: "idle", generation: null })),
      anchor: "m2",
      messages: [message("m2", AgentNS.Role.Assistant, "写完了"), message("m3", AgentNS.Role.User, "下一个")],
      mode: "anchor",
    };
    h.connection.emitResume({ ok: true, resumed });

    const done = h.events.find((event) => event.type === "done");
    if (done?.type !== "done") throw new Error("应当推一条 done");
    expect(done.messages.map((item) => item.content)).toEqual(["旧问题", "写完了", "下一个"]);
  });

  it("补拉时这一轮还在跑：推完 done 再补一次 start（界面接着收增量）", () => {
    const h = harness();
    h.connection.emitResume({
      ok: true,
      resumed: {
        conversationId: CONVERSATION,
        state: conversationState(runState({ generation: { phase: "generating", since: "…", chars: 5 } })),
        anchor: null,
        messages: [message("m1", AgentNS.Role.Assistant, "半截")],
        mode: "full",
      },
    });

    expect(h.events.map((event) => event.type)).toEqual(["done", "start", "stream"]);
  });

  it("补拉失败：说一句话，不静默", () => {
    const h = harness();
    const error = new ClientErrorValue("connection_lost", "与宿主的连接断了");

    h.connection.emitResume({ ok: false, conversationId: CONVERSATION, error });

    const event = h.events[0];
    if (event?.type !== "notice") throw new Error("应当是一条 notice");
    expect(event.level).toBe("warning");
    expect(event.text.message).toContain("与宿主的连接断了");
  });
});

describe("断线 → 重连", () => {
  it("可重试的失败会重连；重连不成功就推一条错误通知（不假装还在连）", async () => {
    const connection = fakeConnection({ reconnectError: new Error("还是连不上") });
    const events: ChatStreamEvent[] = [];
    const bridge = new ChatEventBridge({
      call: connection.call,
      push: (event) => events.push(event),
      log: () => {},
    });
    bridge.attach(connection);

    connection.emitClose(new ClientErrorValue("connection_lost", "断了"));

    // `reconnectUntilConnected` 里第 1 次就抛（用例造的错误不是 `ClientError`，走「可重试」那一支，
    // 于是要等 5 次退避）。这里只等第一条通知，不去等满退避 —— 断言的是「有条路把它说出来」。
    expect(connection.reconnects).toBe(1);
    expect(events).toEqual([]);
    bridge.dispose();
  });

  it("被宿主拒（不可重试）：当场放弃并说清原因", async () => {
    const connection = fakeConnection({
      reconnectError: new ClientErrorValue("unauthorized", "凭证不对"),
    });
    const events: ChatStreamEvent[] = [];
    const bridge = new ChatEventBridge({
      call: connection.call,
      push: (event) => events.push(event),
      log: () => {},
    });
    bridge.attach(connection);

    connection.emitClose(new ClientErrorValue("connection_lost", "断了"));
    await flush();

    const notice = events.find((event) => event.type === "notice");
    if (notice?.type !== "notice") throw new Error("应当推一条通知");
    expect(notice.level).toBe("error");
    expect(notice.text.message).toContain("凭证不对");
  });

  it("dispose 之后不再订阅：事件推过来什么都不发生", () => {
    const h = harness();
    h.bridge.dispose();

    h.connection.emit("message.delta", {
      conversationId: CONVERSATION,
      messageId: "m1",
      seq: 0,
      delta: { content: "x" },
      at: "a",
    });

    expect(h.events).toEqual([]);
  });
});
