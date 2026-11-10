/**
 * 事件翻译用例：服务端的 12 条事件怎么变成 render 的 `ChatStreamEvent`。
 *
 * 这里断言的是**render 会看到什么**（`server.pushed` 的顺序与形状），不是服务端内部状态
 * —— 翻译层唯一的验收口径就是这条通道。
 *
 * 两处的例外：`session.question` **不进 render**（`ChatStreamEvent` 里没有「提问」这一类），
 * 但它必须被答回去 —— 断言的是「客户端真的答了」与服务端认领了那条回答；`server.notice`
 * 今天在服务端**没有生产者**（见 `TestServer.hub`），所以由脚手架扮演组装根那一声
 * `hub.publish`，往后每一段仍是真的（真 socket + 真翻译）。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  ChatStreamEvent,
  Conversation,
  ConversationState,
} from "@ai-zen/desktop-shared";
import type { AgentNS } from "@ai-zen/agents-core";
import { SERVER_EVENTS, SESSION_EVENTS } from "@ai-zen/agents-client";
import type { HandoffMode, SessionSaveAsResult } from "@ai-zen/agents-client";
import { noticeText } from "./notices.js";
import {
  FakeSubAgent,
  startTestServer,
  waitFor,
  AUTO_TITLE,
  type TestServer,
  type TestServerOptions,
} from "./test-harness.js";

let server: TestServer;
let workspaceId: string;
let conversationId: string;

/** 换一台服务端（自动标题不是每条用例都需要，见 `TestServerOptions`）并开一段会话 */
async function openServer(options: TestServerOptions = {}): Promise<void> {
  if (server) await server.stop();
  server = await startTestServer(options);
  const workspace = (await server.layer.manager.invokeService(
    "workspace",
    "create",
    "",
    server.projectDir,
  )) as { id: string };
  workspaceId = workspace.id;
  const conversation = (await server.layer.manager.invokeService(
    "conversation",
    "create",
    workspaceId,
    "default",
  )) as Conversation;
  conversationId = conversation.id;
}

beforeEach(async () => {
  await openServer();
});

afterEach(async () => {
  await server.stop();
});

async function send(content: string): Promise<void> {
  await invoke<void>("chat", "send", workspaceId, conversationId, content);
}

/** render 真实走的那条路：`window.electronAPI.invokeService(service, method, ...args)` */
async function invoke<T>(service: string, method: string, ...args: unknown[]): Promise<T> {
  return (await server.layer.manager.invokeService(service, method, ...args)) as T;
}

function eventsOf(type: ChatStreamEvent["type"]): ChatStreamEvent[] {
  return server.pushed.filter((event) => event.type === type);
}

/** `message` 事件（类型收窄：下面的断言要直接读 `message` / `id`） */
type MessageEvent = Extract<ChatStreamEvent, { type: "message" }>;

/** `user` 事件（类型收窄：下面的断言要直接读 `content`） */
type UserEvent = Extract<ChatStreamEvent, { type: "user" }>;

/** `done` 事件（类型收窄：下面的断言要直接读 `messages`） */
type DoneEvent = Extract<ChatStreamEvent, { type: "done" }>;

/** **带工具调用**的那几条 `message` 事件（正文增量推的那几条没有 `tool_calls`） */
function toolCallEvents(): MessageEvent[] {
  return server.pushed.filter(
    (event): event is MessageEvent =>
      event.type === "message" && Boolean(event.message.tool_calls?.length),
  );
}

/**
 * `role: "user"` / `role: "assistant"` 的字面值（`as` 断言成 core 的枚举，与 `events.ts` /
 * `test-harness.ts` 同一口径：不为一个字符串把整个模型库拉进依赖图）。
 */
const USER_ROLE = "user" as AgentNS.Role;
const ASSISTANT_ROLE = "assistant" as AgentNS.Role;

/**
 * `role: "tool"` 的字面值（`as` 断言成 core 的枚举，与 `events.ts` / `test-harness.ts`
 * 同一口径：不为一个字符串把整个模型库拉进依赖图）。
 */
const TOOL_ROLE = "tool" as AgentNS.Role;

/** 工具**结果**消息的 `message` 事件（`session.messageAppended` 翻出来的那一条） */
function toolResultEvents(): MessageEvent[] {
  return server.pushed.filter(
    (event): event is MessageEvent => event.type === "message" && event.message.role === TOOL_ROLE,
  );
}

/**
 * 按 **render 的 upsert 语义**把 `message` 事件合并成消息表（`stores/chat.ts` 的
 * `case "message"`：同一个 id 覆盖、新 id 追加）。
 *
 * 这是「原地更新 vs 多出一行」唯一有意义的判据：事件条数不说明问题（一片一次，本来就多条），
 * 按 id 合并后占几个位置才说明问题。
 */
function upsertLikeRender(): Map<string, AgentNS.Message> {
  const byId = new Map<string, AgentNS.Message>();
  for (const event of server.pushed) {
    if (event.type === "message") byId.set(event.id, event.message);
  }
  return byId;
}

/**
 * 服务端等「这次自动迁移用哪种方式交接」的缺省时限（`SessionManager` 的 `ASK_TIMEOUT_MS`）。
 *
 * 用例把它显式传给服务端，是为了让「客户端答得有多快」有一把可比的尺子：回答在几十毫秒
 * 内就回来了，与这个数差四个数量级。
 */
const ASK_TIMEOUT_MS = 300_000;

/**
 * `agents` 事件（类型收窄：下面的断言要直接读 `agents` 列表）。
 *
 * 它是**整份替换**语义的事件：最后一条就是此刻屏幕上那一份栏目，所以断言几乎都取 `.at(-1)`
 * —— 与 `message` 那条的「按 id upsert」不同，这里不需要把多条事件拼成一份。
 */
type AgentsEvent = Extract<ChatStreamEvent, { type: "agents" }>;

function agentsEvents(): AgentsEvent[] {
  return server.pushed.filter((event): event is AgentsEvent => event.type === "agents");
}
/** 屏幕上那一份栏目（最后一条 `agents` 事件；还没有事件时是 `undefined`） */
function latestAgents(): AgentsEvent["agents"] | undefined {
  return agentsEvents().at(-1)?.agents;
}

/**
 * 一个可自己放行的闸门：`wait` 交给被测方，`open()` 由用例在合适的时机扳一下。
 *
 * 用例用它把 `session.subAgent.snapshot` 的**回程**推迟到「第一批增量已经上屏」之后 ——
 * 真事里那条竞态（快照比增量还慢）靠碰运气凑不出来，而它恰好是合并规则的唯一场景。
 */
function latch(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => (open = resolve));
  return { wait, open };
}

/**
 * 让服务端真的问一次「用哪种方式交接」，返回它最后拿到的选择。
 *
 * ## 为什么造得出来（真件里这条路由谁调起）
 *
 * 真件里它是 SDK 的 `AutoMigratePlugin` 在上下文快满时调的：`resolveMode(info)` →
 * `SessionManager.askHandoffMode` → 发 `session.question` 并等 `session.answer`。
 * 用例里的假 Agent 不会自己跑到那一步（那要真模型把上下文跑满），所以直接取会话层在
 * **装配 Agent 时交出去的那一个 `resolveMode`**（`buildAgent` → `createAgent(input)`，
 * 存在 `server.agentInputs` 里）调一次。
 *
 * 除了「谁按下这个按钮」之外，路上每一步都是真的：`askQuestion` 记表 → hub → 真 socket
 * → 桌面端的事件翻译 → `session.answer` 原路回去 → `manager.answer` 认领。用例没有替任何
 * 一侧演一个动作（它只负责按下那个按钮）。
 */
function askHandoffMode(): Promise<HandoffMode | null> {
  // 每个用例只开一段会话（`openServer`），所以装配入参只有一条
  const resolver = server.agentInputs.at(-1)?.resolveMode;
  if (!resolver) throw new Error("会话没有接上 resolveMode：脚手架没拿到装配入参");
  return Promise.resolve(resolver({ promptTokens: 9_000, handoffTokens: 8_000 }));
}

describe("开始：没有「开始」事件，从阶段变化推", () => {
  it("派发 user + start，每个 turnId 只派发一次（后续阶段变化不再重复）", async () => {
    await send("你好");
    server.agent.emitDelta("答");
    server.agent.emitDelta("案");

    await waitFor(() => eventsOf("start").length > 0, "start 事件");

    // user 在 start 之前（与旧实现同序：先让用户那句话上屏，再进流式态）
    const kinds = server.pushed.map((event) => event.type);
    expect(kinds.indexOf("user")).toBeGreaterThanOrEqual(0);
    expect(kinds.indexOf("start")).toBeGreaterThan(kinds.indexOf("user"));

    const user = eventsOf("user")[0]!;
    expect(user).toMatchObject({ conversationId, content: "你好" });
    // 一片增量一个阶段事件，但 start 只有一条
    expect(eventsOf("start")).toHaveLength(1);
  });
});

describe("增量：只有 text / reasoning，拼进一条占位 assistant 消息", () => {
  it("正文与推理都累加在同一条消息上（id 稳定，content 逐片增长）", async () => {
    await send("你好");
    server.agent.emitDelta("你");
    server.agent.emitDelta("好", "想一想");

    await waitFor(() => eventsOf("message").length >= 2, "两片增量");

    const messages = eventsOf("message");
    expect(messages.map((event) => (event.type === "message" ? event.id : ""))).toEqual([
      `${conversationId}:assistant:1`,
      `${conversationId}:assistant:1`,
    ]);
    const first = messages[0]!;
    const second = messages[1]!;
    expect(first.type === "message" && first.message.content).toBe("你");
    expect(second.type === "message" && second.message.content).toBe("你好");
    expect(second.type === "message" && second.message.reasoning_content).toBe("想一想");
  });
});

/**
 * 一条连接、多段会话并发 —— 桌面端与 TUI 最大的不同（`stores/chat.ts` 的 `byConversation`：
 * 切走的会话继续收事件）。main 这一侧是「一段会话一台状态机」：串台在这里就是「主回答里
 * 凭空出现另一段会话的正文」，而它只在并发时才显形。
 */
describe("并发：一条连接、多段会话", () => {
  it("两段会话各自流式、互不串台（各自一条 user / 一条正文 / 一条 done）", async () => {
    // 每段会话一台假 Agent：共用一台的话，「两段会话混了」与「脚手架把一台 Agent 给了两段
    // 会话」长得一模一样，测出来的就不是客户端的事
    await openServer({ freshAgentPerSession: true });

    const conversationB = await invoke<Conversation>(
      "conversation",
      "create",
      workspaceId,
      "default",
    );
    // 两段会话各装配了一台（顺序 = `conversation.create` 的先后）
    const [agentA, agentB] = server.agents;
    if (!agentA || !agentB) throw new Error("两段会话应当各装配一台 Agent");

    await send("先说 A");
    await invoke<void>("chat", "send", workspaceId, conversationB.id, "先说 B");
    // 两段会话同时流（后台会话照收事件，不是「只有当前那段能长」）
    agentA.emitDelta("答A");
    agentB.emitDelta("答B");

    const messages = await waitFor(
      () => (eventsOf("message").length >= 2 ? (eventsOf("message") as MessageEvent[]) : undefined),
      "两段会话各自的正文",
    );
    const bodyOf = (id: string): string =>
      String(messages.find((event) => event.conversationId === id)!.message.content);
    // 谁的字落在谁的会话上：串台的表现是 A 的正文贴到 B 上（或者一条正文两条会话各收一份）
    expect(bodyOf(conversationId)).toBe("答A");
    expect(bodyOf(conversationB.id)).toBe("答B");
    expect(messages.every((event) => event.message.content === "答A" || event.message.content === "答B"))
      .toBe(true);

    // user 也各归各的（正文由 main 在 send 时登记，登记表按会话分键）
    const users = await waitFor(
      () =>
        eventsOf("user").length === 2 ? (eventsOf("user") as UserEvent[]) : undefined,
      "两段会话各自的 user",
    );
    const userOf = (id: string): string =>
      users.find((event) => event.conversationId === id)!.content;
    expect(userOf(conversationId)).toBe("先说 A");
    expect(userOf(conversationB.id)).toBe("先说 B");

    // 各自收尾：done 里只有自己那段会话的消息（快照也按会话取）
    agentA.finish();
    agentB.finish();
    const dones = await waitFor(
      () => (eventsOf("done").length === 2 ? (eventsOf("done") as DoneEvent[]) : undefined),
      "两段会话各一条 done",
    );
    const doneOf = (id: string): AgentNS.Message[] =>
      dones.find((event) => event.conversationId === id)!.messages;
    expect(doneOf(conversationId).map((message) => message.content)).toEqual(["先说 A", "答A"]);
    expect(doneOf(conversationB.id).map((message) => message.content)).toEqual(["先说 B", "答B"]);
  });
});

describe("工具调用：流式期间就画出来（session.toolCalls）", () => {
  it("推一片工具调用就收到 message，形状是 core 的嵌套形，随后的正文仍落在同一条消息上", async () => {
    await send("读一下文件");
    // 真件里模型可以先决定调工具、正文要等工具跑完的下一段流才有 —— 这一片没有任何正文
    server.agent.emitToolCall({ index: 0, id: "call_1", name: "read", arguments: '{"path":' });

    const streamed = await waitFor(() => toolCallEvents()[0], "流式期间的工具调用");
    const call = streamed.message.tool_calls?.[0];
    expect(call?.function?.name).toBe("read");
    // 半截 JSON 原样透传：这一层不解析、不修补
    expect(call?.function?.arguments).toBe('{"path":');
    expect(call).toMatchObject({ index: 0, id: "call_1", type: "function" });
    // 扁平字段不能漏到 render：那边读的是 `tc.function?.name` / `tc.function?.arguments`
    expect(call).not.toHaveProperty("name");
    expect(call).not.toHaveProperty("arguments");

    // 工具调用**先于正文**到达：占位 id 的生成规则只有一处，所以随后那片正文说的仍是同一条消息
    server.agent.emitDelta("查到了");
    const withText = await waitFor(
      () => toolCallEvents().find((event) => Boolean(event.message.content)),
      "带正文的后续更新",
    );
    expect(withText.id).toBe(streamed.id);
    expect(withText.message.content).toBe("查到了");
    // 正文与工具调用是**并存**的两个字段，不是二选一
    expect(withText.message.tool_calls?.[0]?.function?.name).toBe("read");
  });

  it("参数变长的那一片仍是同一个 id、给的是完整参数，按 render 的 upsert 合并后只有一条", async () => {
    await send("读一下文件");
    server.agent.emitToolCall({ index: 0, id: "call_1", name: "read", arguments: '{"path":' });
    const first = await waitFor(() => toolCallEvents()[0], "第一片工具调用");

    // 第二片只带参数片段：core 把它接到 receiver 上，服务端上报的是**拼到此刻**的整串
    server.agent.emitToolCall({ index: 0, arguments: '"a.ts"}' });
    const second = await waitFor(() => toolCallEvents()[1], "第二片工具调用");

    expect(second.id).toBe(first.id);
    expect(second.message.tool_calls?.[0]?.function?.arguments).toBe('{"path":"a.ts"}');

    // render 的 upsert：同一个 id 只占一个位置 —— 这两条事件在界面上是「一张卡片长大了」
    const merged = upsertLikeRender();
    expect(merged.size).toBe(1);
    expect(merged.get(first.id)?.tool_calls?.[0]?.function?.arguments).toBe('{"path":"a.ts"}');
  });

  it("正文已经在流：后到的工具调用不抹掉正文（整条替换语义要带全字段）", async () => {
    await send("你好");
    server.agent.emitDelta("我查一下");
    const bodyOnly = await waitFor(() => {
      const event = eventsOf("message")[0];
      return event?.type === "message" ? event : undefined;
    }, "正文增量");

    server.agent.emitToolCall({ index: 0, id: "call_1", name: "read", arguments: "{}" });
    const withTools = await waitFor(() => toolCallEvents()[0], "工具调用");

    expect(withTools.id).toBe(bodyOnly.id);
    // `type: "message"` 是整条替换：推到 render 的那份必须把已累积的正文一起带上，
    // 否则已经显示出来的字会被一次工具调用上报抹掉
    expect(withTools.message.content).toBe("我查一下");
    expect(withTools.message.tool_calls?.[0]?.function?.name).toBe("read");
  });

  it("收尾仍以快照为准：done 换成服务端那份（真实 id + 工具结果）", async () => {
    await send("读一下文件");
    server.agent.emitToolCall({
      index: 0,
      id: "call_1",
      name: "read",
      arguments: '{"path":"a.ts"}',
    });
    const streamed = await waitFor(() => toolCallEvents()[0], "流式期间的工具调用");
    server.agent.emitDelta("看完了");
    // 工具结果只有服务端知道（协议没有「结果增量」这条事件）
    server.agent.pushToolResult("文件内容");
    server.agent.finish();

    const done = await waitFor(() => eventsOf("done")[0], "done 事件");
    if (done.type !== "done") throw new Error("unreachable");

    expect(done.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool"]);
    // 占位消息被服务端真实 id 换掉（同一位置、同一份工具调用参数）
    expect(done.messages[1]!.id).not.toBe(streamed.id);
    expect(done.messages[1]!.tool_calls?.[0]).toMatchObject({
      id: "call_1",
      function: { name: "read", arguments: '{"path":"a.ts"}' },
    });
    expect(done.messages[1]!.content).toBe("看完了");
    // 工具**结果**仍然只有快照里有：它不会从流式那条占位消息里出现
    expect(streamed.message.tool_call_id).toBeUndefined();
    expect(done.messages[2]).toMatchObject({ content: "文件内容", tool_call_id: "call_1" });
  });
});

/**
 * 工具结果消息：工具跑完那一刻就上屏（`session.messageAppended`）。
 *
 * 这一组盯的是**时机与身份**：什么时候能收到（不必等 `session.turnEnd`）、收到的是哪条消息
 * （服务端真实 id + `tool_call_id`，不是占位 id）、以及它和占位 assistant 消息在 render 那边
 * 是否各自占一个位置。
 */
describe("工具结果：跑完那一刻就上屏（session.messageAppended）", () => {
  it("工具一跑完就收到 message：role=tool、tool_call_id/正文对得上、id 是服务端那条", async () => {
    await send("读一下文件");
    // 真件的顺序：模型先决定调工具（组装态走 `session.toolCalls`），跑完才有结果
    server.agent.emitToolCall({ index: 0, id: "call_1", name: "read", arguments: '{"path":"a.ts"}' });
    await waitFor(() => toolCallEvents()[0], "流式期间的工具调用");

    // 工具跑完：结果消息定型 + `tool-call-end`（服务端就在这一刻推上线）
    const result = server.agent.pushToolResult("文件内容", "read");
    server.agent.endToolCall(result);

    const event = await waitFor(() => toolResultEvents()[0], "工具结果的 message 事件");
    expect(event.message.role).toBe("tool");
    expect(event.message.tool_call_id).toBe("call_1");
    expect(event.message.content).toBe("文件内容");
    expect(event.message.name).toBe("read");
    expect(event.message.status).toBe("completed");
    // id 是**服务端那条**（`pushToolResult` 造出来的那份），不是客户端编的占位 id ——
    // 否则同一条消息会在 `messageAppended` 与 `done` 里各有一个 id，render 画成两条
    expect(event.id).toBe(result.id);
    expect(event.id).not.toBe(`${conversationId}:assistant:1`);
    // 这一刻这一轮还**没**收尾：不必等 `session.turnEnd` 正是这条事件存在的理由
    expect(eventsOf("done")).toHaveLength(0);
  });

  it("它与占位 assistant 同屏是两条：id 不同，占位在前、结果在后（render 的追加语义）", async () => {
    await send("读一下文件");
    // 正文先流：占位 assistant 消息先出现（它的 id 是客户端编的）
    server.agent.emitDelta("我先读一下");
    const placeholder = await waitFor(() => {
      const event = eventsOf("message")[0];
      return event?.type === "message" ? event : undefined;
    }, "占位 assistant 消息");

    const result = server.agent.pushToolResult("文件内容", "read");
    server.agent.endToolCall(result);
    await waitFor(() => toolResultEvents()[0], "工具结果的 message 事件");

    // 按 render 的 upsert 合并：id 不同 → **两条**（不是同一个气泡被改写）
    const merged = upsertLikeRender();
    expect(merged.size).toBe(2);
    expect(merged.has(placeholder.id)).toBe(true);
    expect(merged.has(result.id)).toBe(true);
    // 追加语义：正文那条在前（它先出现），工具结果在后 —— 用户看到的是「结果单独一个气泡」
    expect([...merged.keys()]).toEqual([placeholder.id, result.id]);
    // 结果正文没有挤进占位消息里（挤进去就等于同一条消息两份表示）
    expect(merged.get(placeholder.id)?.tool_call_id).toBeUndefined();
    expect(merged.get(result.id)?.tool_call_id).toBe("call_1");
  });

  it("session.turnEnd 之后仍以快照为准：done 里那条结果与流式推来的是同一条（同一个 id）", async () => {
    await send("读一下文件");
    server.agent.emitDelta("我读一下");
    const result = server.agent.pushToolResult("文件内容", "read");
    server.agent.endToolCall(result);
    const streamed = await waitFor(() => toolResultEvents()[0], "工具结果的 message 事件");

    server.agent.finish();
    const done = await waitFor(() => eventsOf("done")[0], "done 事件");
    if (done.type !== "done") throw new Error("unreachable");

    // 快照仍是权威：工具结果在里面……
    const inSnapshot = done.messages.find((message) => message.role === TOOL_ROLE);
    expect(inSnapshot).toMatchObject({ content: "文件内容", tool_call_id: "call_1" });
    // ……而且就是流式期间推的那一条：id 相同，收尾的全量替换不会把它画成第二条
    expect(inSnapshot?.id).toBe(streamed.id);
    // 收尾路径没被打乱：占位 assistant 仍被服务端真实 id 换掉，工具结果排在它后面
    expect(done.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool"]);
    expect(done.messages[1]!.id).not.toBe(`${conversationId}:assistant:1`);
  });

  it("换过 id 的会话：messageAppended 仍以 render 认识的那个 conversationId 上报", async () => {
    await send("第一轮");
    server.agent.emitDelta("答");
    server.agent.finish();
    await waitFor(() => eventsOf("done").length > 0, "第一轮收尾");

    // 另存为：活会话换键（与「换 id」那组用例同一套构造）
    await server.call<SessionSaveAsResult>("session.saveAs", {
      sessionId: conversationId,
      id: "chat_renamed",
    });
    await waitFor(() => eventsOf("migrated")[0], "migrated 事件");

    // 新 id 上跑第二轮，工具在这一次跑完（服务端事件里的 sessionId 已是 `chat_renamed`）
    const startsBefore = eventsOf("start").length;
    await server.call("session.send", { sessionId: "chat_renamed", content: "迁移之后" });
    await waitFor(() => eventsOf("start").length > startsBefore, "新 id 上的 start");

    const result = server.agent.pushToolResult("迁移之后的结果", "read");
    server.agent.endToolCall(result);

    const event = await waitFor(() => toolResultEvents()[0], "工具结果的 message 事件");
    // 落回 render 认识的那个 key：报新 id 的话，这条结果会贴到一段 render 从没见过、也永远
    // 不会选中过的会话上 —— 画面上等于什么都没发生（`keyOf` 与其它事件同一口径）
    expect(event.conversationId).toBe(conversationId);
    expect(event.id).toBe(result.id);
    expect(event.message.content).toBe("迁移之后的结果");
  });
});

describe("收尾：session.turnEnd 不带消息，必须补一次快照", () => {
  it("done 里是服务端那份完整消息（含工具结果），流式占位消息被真实 id 替换", async () => {
    await send("你好");
    server.agent.emitDelta("答案");
    // 工具结果只有服务端知道（增量里没有）；协议缺口②的降级就靠这次快照补齐
    server.agent.pushToolResult("工具结果");
    server.agent.finish();

    const done = await waitFor(() => eventsOf("done")[0], "done 事件");
    if (done.type !== "done") throw new Error("unreachable");

    expect(done.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool"]);
    expect(done.messages[2]).toMatchObject({ content: "工具结果", tool_call_id: "call_1" });
    // 占位消息的 id 是客户端编的，收尾后被服务端真实 id 换掉（同一个位置、同一份内容）
    const streamed = eventsOf("message")[0];
    expect(streamed?.type === "message" && streamed.id).toBe(`${conversationId}:assistant:1`);
    expect(done.messages[1]!.id).not.toBe(`${conversationId}:assistant:1`);
    expect(done.messages[1]!.content).toBe("答案");
  });

  it("失败的一轮：done 之后紧跟 error（render 的 done 会清错误条，所以顺序不能反）", async () => {
    await send("你好");
    server.agent.emitDelta("半截");
    server.agent.fail({ code: "boom", message: "模型炸了" });

    const done = await waitFor(() => eventsOf("done")[0], "done 事件");
    const error = await waitFor(() => eventsOf("error")[0], "error 事件");
    if (error.type !== "error" || done.type !== "done") throw new Error("unreachable");

    expect(error.message).toBe("模型炸了");
    // 半截内容仍然留在 done 里（中断现场要能看到）
    expect(done.messages[1]).toMatchObject({ content: "半截" });
    expect(server.pushed.indexOf(done)).toBeLessThan(server.pushed.indexOf(error));
  });
});

/**
 * 服务端把轮次计数**从 0 重来**（进程重启、会话被回收后重新装回，都是同一条）。
 *
 * 这一条锁的是 main 那份「一轮的通道侧记账」的边界。`turnId` 是**会话内**的编号：服务端每轮
 * +1，而计数从 0 起（`LiveSession` 初值 0；`session.attach` 把存档装回来的会话也是 0；一次
 * `session.close` 之后再装回同样如此 —— 真进程重启的效果与这条路径一字不差）。于是「上一段
 * 里停在第 1 轮」与「这一段的第一轮」是同一个数字，而 main 的槽位按 `turnId` 换。
 *
 * 不校正的话新的一轮会**复用旧槽位**：`user` / `start` 一个都不推（界面不进流式态、用户那
 * 句话不上屏），槽位里那半句正文还会接在新答案前面（状态机那份拼接态被合并规则当成「本地
 * 更全」留下来）。包里 `SessionChannel` 收尾时用 `Math.max(snapshot.turnId, pending.turnId)`
 * 防的是同一件事的另一面，这里同样是「以服务端快照说的大数为准」。
 */
describe("轮次计数从 0 重来：新的一轮不复用旧槽位", () => {
  it("会话被放掉再装回来（turnId 回到 0）：user / start 照推，正文不接旧半句", async () => {
    await send("第一轮");
    server.agent.emitDelta("半截");
    await waitFor(() => eventsOf("message")[0], "第一轮那半句上屏");

    // 把这一轮写到盘上（它还没收尾）：接下来要把会话从服务端内存里放掉再点名装回来，而
    // 「装回来」要的正是盘上这份存档
    await server.call("session.save", { sessionId: conversationId });

    // 会话从内存里退场 → 装回来：新的 `LiveSession` 的 `turnId` 从 0 起（真进程重启时
    // 内存里的一切同样消失），所以下一轮的编号又是 1 —— 与脏槽位里那个 1 撞车
    await invoke<void>("chat", "release", conversationId);
    const state = await invoke<ConversationState>(
      "chat",
      "getState",
      workspaceId,
      conversationId,
    );
    // 装回来的是一个空闲会话（这一轮不在飞）；消息来自存档
    expect(state.streaming).toBe(false);
    expect(state.messages.map((message) => message.content)).toEqual(["第一轮", "半截"]);

    const usersBefore = eventsOf("user").length;
    const startsBefore = eventsOf("start").length;
    await send("重来一轮");
    server.agent.emitDelta("新答案");

    // 这一轮的 user / start 必须重新派发：复用旧槽位时两者都会缺席（`started` 已经是 true）
    const user = await waitFor(
      () => (eventsOf("user") as UserEvent[]).slice(usersBefore).at(-1),
      "重来这一轮的 user",
      // 比 vitest 的用例时限（5s）短：红的时候要报「在等什么」，而不是一句
      // `Test timed out in 5000ms`
      3_000,
    );
    expect(user).toMatchObject({ conversationId, content: "重来一轮" });
    await waitFor(() => eventsOf("start").length > startsBefore, "重来这一轮的 start", 3_000);

    // 正文不接旧半句：状态机里那份拼接态属于上一个 `LiveSession`，而合并规则会把它当成
    // 「本地更全」留下来 —— 屏幕上于是出现「半截新答案」
    const before = eventsOf("message").length;
    const latest = await waitFor(() => {
      const messages = eventsOf("message") as MessageEvent[];
      if (messages.length <= before) return undefined;
      return messages
        .filter((event) => event.message.id?.startsWith(`${conversationId}:assistant:`))
        .at(-1);
    }, "新答案上屏", 3_000);
    expect(latest.message.content).toBe("新答案");
  });
});

describe("自动标题：session.titleChanged → renamed", () => {
  it("第一轮收尾后服务端起好名字，侧栏拿到的就是它", async () => {
    // 这一条要服务端真的去起名（其余用例不注入自动标题：那是 `session.turnEnd` 之后的后台动作）
    await openServer({ autoTitle: true });

    await send("你好");
    server.agent.emitDelta("答");
    server.agent.finish();

    const renamed = await waitFor(
      () => eventsOf("renamed")[0],
      "renamed 事件（服务端自动标题）",
    );
    expect(renamed).toEqual({ conversationId, type: "renamed", name: AUTO_TITLE });
  });
});

describe("换 id：session.idChanged → migrated + 之后的 key 收敛", () => {
  it("迁移/另存为换 id 后，事件仍以 render 认识的那个 conversationId 上报", async () => {
    await send("第一轮");
    server.agent.emitDelta("答");
    server.agent.finish();
    await waitFor(() => eventsOf("done").length > 0, "第一轮收尾");

    // 另存为：服务端写新档、删旧档、活会话换键，并发 `session.idChanged`
    const saved = await server.call<SessionSaveAsResult>("session.saveAs", {
      sessionId: conversationId,
      id: "chat_renamed",
    });
    expect(saved.sessionId).toBe("chat_renamed");

    const migrated = await waitFor(() => eventsOf("migrated")[0], "migrated 事件");
    if (migrated.type !== "migrated") throw new Error("unreachable");
    // 用旧 id 上报：render 手里只有这个键（`ChatStreamEvent` 里没有"换 key"的类型）
    expect(migrated.conversationId).toBe(conversationId);
    expect(migrated.messages.map((message) => message.role)).toEqual(["user", "assistant"]);

    // 之后在新 id 上发生的一切仍然落在旧 key 上 —— 否则界面会在旧 id 上永远等不到收尾。
    // 计数要在发请求**之前**取：阶段事件是在 `session.send` 的回执之前推的
    const startsBefore = eventsOf("start").length;
    await server.call("session.send", { sessionId: "chat_renamed", content: "迁移之后" });
    await waitFor(() => eventsOf("start").length > startsBefore, "新 id 上的 start");
    expect(eventsOf("start").at(-1)).toEqual({ conversationId, type: "start" });
  });
});

describe("提问：桌面端没有提问 UI，收到就按「跳过」回答", () => {
  it("收到 session.question 立刻回 session.answer（choice:null），服务端当场认领 —— 不烧那 5 分钟", async () => {
    // 超时用它真实的缺省值：客户端答得早不早，只能在这个尺度下看出来
    await openServer({ askTimeoutMs: ASK_TIMEOUT_MS });

    // 生产里提问发生在一轮**内部**（插件在 onAfterSend 里调），这里也让它在跑着的一轮里发生
    await send("你好");
    server.agent.emitDelta("答");

    const startedAt = Date.now();
    const asking = askHandoffMode();

    // 服务端**收到了这条回答**（证明是客户端发了 session.answer，不是超时兜底）……
    const claimed = await waitFor(() => server.answerResults[0], "服务端认领的 session.answer");
    // ……而且**认领了它**：`answered:true` 只会在问题还挂在表里时出现（超时之后是 false）
    expect(claimed).toEqual({ answered: true });
    expect(server.answerCalls).toHaveLength(1);
    expect(server.answerCalls[0]).toMatchObject({ sessionId: conversationId, choice: null });
    expect(typeof server.answerCalls[0]!.questionId).toBe("string");

    // 提问方拿到的就是「跳过」——与服务端超时后自己走 fallback 是同一个答案
    await expect(asking).resolves.toBeNull();
    // 不是等出来的：墙上时间远小于超时阈值（没答的话，上面那条 waitFor 会先超时红掉）
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  it("回答失败（会话已收 / 来晚了）不推 error，同一会话后续 delta 与 session.turnEnd 照常翻译", async () => {
    // 回答失败在生产里就是「会话刚被收掉」：服务端自己会走 fallback，不该弹一条红字。
    // 超时调小只是让挂着的那个问题自己收场（客户端没答成，它就得等这一下）
    await openServer({
      askTimeoutMs: 50,
      failAnswerWith: () => new Error("unknown-session: 会话已收"),
    });

    await send("你好");
    server.agent.emitDelta("答");

    const asking = askHandoffMode();
    // 客户端确实**尝试**答了，只是那次调用在服务端失败了（失败没有回执）
    await waitFor(() => server.answerCalls.length > 0, "客户端发出的 session.answer");
    expect(server.answerResults).toEqual([]);

    // 同一条会话后续的翻译一点不受影响：增量照旧拼、收尾照样补快照
    server.agent.emitDelta("案");
    server.agent.finish();
    const done = await waitFor(() => eventsOf("done")[0], "done 事件");
    if (done.type !== "done") throw new Error("unreachable");
    expect(done.messages.map((message) => message.content)).toEqual(["你好", "答案"]);

    // 提问方由服务端的兜底收场（拿到的仍是「跳过」）……
    await expect(asking).resolves.toBeNull();
    // ……而整轮里错误通道一直是干净的：这条失败不该变成 render 里的 error
    expect(eventsOf("error")).toEqual([]);
  });
});

describe("通知：服务端推来的通知不再被丢掉", () => {
  /**
   * 造一条**真的** `session.notice`：让服务端问一次「用哪种方式交接」，客户端答「跳过」
   * 之后它会发 `migrationSkipped`（`SessionManager.askHandoffMode` 的最后一行）。
   *
   * 为什么用这条链路而不是自己发一条事件：这一条路是「真件里用户会遇上的那种通知」，
   * 每一环都是真的（`askQuestion` 记表 → hub → 真 socket → 翻译）。而它曾经是静默丢弃的
   * 那一条 —— 用户只看到「什么都没发生」。
   */
  it("回答「跳过」之后那条 session.notice(migrationSkipped) 变成 notice，conversationId 是本会话", async () => {
    await openServer({ askTimeoutMs: ASK_TIMEOUT_MS });

    await send("你好");
    server.agent.emitDelta("答");

    // 提问 → 客户端答「跳过」→ 服务端当场发那条 migrationSkipped
    await expect(askHandoffMode()).resolves.toBeNull();

    const notice = await waitFor(() => eventsOf("notice")[0], "notice 事件");
    if (notice.type !== "notice") throw new Error("unreachable");

    expect(notice.level).toBe("info");
    // 文本是词典出的**人话**，不是 code 本身（丢掉词典这一环，用户会看到 `migrationSkipped`）
    expect(notice.text).toBe(noticeText("migrationSkipped"));
    expect(notice.text).not.toBe("migrationSkipped");
    // 绑会话：这条通知属于 render 认识的那段会话（与 session.delta 同一口径）
    expect(notice.conversationId).toBe(conversationId);
    // 通知不是错误：错误通道一点没被它碰过
    expect(eventsOf("error")).toEqual([]);
  });

  it("server.notice 也进 render，且**不带** conversationId（它不属于任何会话）", async () => {
    // 服务端今天还没有全局通知的生产者（协议先立住 code）；组装根的职责就是往 hub 里发
    server.hub.publish({
      event: SERVER_EVENTS.notice,
      level: "warn",
      code: "mcpUnavailable",
      params: { name: "filesystem" },
    });

    const notice = await waitFor(() => eventsOf("notice")[0], "server.notice 翻出来的 notice");
    expect(notice).toEqual({
      type: "notice",
      level: "warn",
      text: noticeText("mcpUnavailable", { name: "filesystem" }),
    });
    // 不能拿空串糊：`conversationId: ""` 在 render 那边等于「有一个 key 为空的会话」
    expect(notice).not.toHaveProperty("conversationId");
  });
});

/**
 * 子 Agent 的视图（`type: "agents"`）：用户要能切到某个子 Agent，看它自己的完整对话。
 *
 * 这一组盯的是 main 这一侧的三件事：**分流**（子 Agent 的增量不进主对话）、**对齐**（快照
 * 与本地增量合并，已经上屏的正文不被摸短）、**回收**（只活当前这一轮）。判据与别处同一口径：
 * render 会收到什么（`server.pushed`）+ 服务端确实收到了哪些请求（`subAgentSnapshotCalls`）。
 *
 * 服务端那一侧的现象在这里都是真的：`sub-agent-start` / `chunk-parsed` / `error` 由假件按
 * core 的形状发出去，`session.subAgent.started` / `.ended` / `session.subAgent.snapshot` 全部
 * 由真 `SessionManager` 产生 —— 用例只负责按真件的时刻扳一下。
 */
describe("子 Agent：另开一条 agents 通道（整份替换）", () => {
  it("started → 出现一条 running 视图，id / index 都是服务端给的（客户端不自己数）", async () => {
    await send("第一轮");
    const first = server.agent.startSubAgent();

    const view = await waitFor(() => latestAgents()?.[0], "子 Agent 的视图");
    // 三件事一次说清：`index` 来自 `started`（不是客户端数的）、状态开门就是 running、
    // 内容此刻还是空的（它由增量与快照负责填）
    expect(view).toEqual({ id: "sub-1", index: 1, status: "running", messages: [] });

    // `started` 一到就**立刻**拉了一次快照：它可能已经跑了一会儿、已经有内容了。
    // 服务端收到过这条请求才是这条规矩的判据（屏幕上什么都没变，客户端那一侧看不见）
    const call = await waitFor(() => server.subAgentSnapshotCalls[0], "started 之后的快照请求");
    expect(call).toEqual({ sessionId: conversationId, subAgentId: "sub-1" });
    expect(first.messages).toEqual([]);

    // 第二轮：展示序号归零（用户看到的又是「子AGENT1」），而 id **不**归零（它是稳定标识）。
    // 服务端就是这么给的（`subAgentSeq` 归零、`subAgentIdSeq` 不归零）。这一条咬的是那些
    // 「按 id 序号 / 一个跨轮不复位的计数器推标签序号」的实现 —— 它们在这里会得出 2，
    // 而服务端说的是 1（同一个子 Agent 在标题上被叫成「子AGENT2」）。
    server.agent.endSubAgent(first);
    server.agent.finish();
    await waitFor(() => agentsEvents().at(-1)?.agents.length === 0, "session.turnEnd 清空栏目");

    await send("第二轮");
    server.agent.startSubAgent();
    const second = await waitFor(
      () => agentsEvents().map((event) => event.agents[0]).find((item) => item?.id === "sub-2"),
      "第二轮的子 Agent 视图",
    );
    // id 递增了、index 还是 1：一位来自 id 序号、一位来自本轮展示序号，两个都是服务端给的
    expect(second).toMatchObject({ id: "sub-2", index: 1, status: "running" });
  });

  it("带 subAgentId 的增量进子 Agent、不进主对话（主回答不被别人的正文推着长）", async () => {
    await send("查两件事");
    // 主 Agent 此刻停在「等工具返回」，占位消息里只有它自己说的那一句
    server.agent.emitDelta("主线在等");
    await waitFor(() => eventsOf("message")[0], "主对话的占位消息");

    const sub = server.agent.startSubAgent();
    await waitFor(() => latestAgents()?.[0], "子 Agent 的视图");

    sub.emitDelta("子");
    sub.emitDelta("答案");

    const view = await waitFor(
      () => latestAgents()?.[0]?.messages.at(-1)?.content === "子答案" && latestAgents()?.[0],
      "子 Agent 的正文",
    );
    // 一个子 Agent 只拼一条临时消息（这期间它可能有多轮 assistant，拆开就断了）
    expect(view.messages).toHaveLength(1);
    expect(view.messages[0]).toMatchObject({ role: "assistant", content: "子答案" });

    // 主对话那一侧一个字都没被动过：所有 `message` 事件里都没有子 Agent 的文字，
    // 最后一条仍是主 Agent 自己那句话（拼进去 = 主回答里凭空多出一段别人的正文）
    const mainBodies = server.pushed
      .filter((event): event is MessageEvent => event.type === "message")
      .map((event) => String(event.message.content));
    expect(mainBodies.some((content) => content.includes("子答案"))).toBe(false);
    expect(mainBodies.at(-1)).toBe("主线在等");
  });

  it("快照晚于增量到达：正文取更全的那份（直接赋值会把已经上屏的字摸短）", async () => {
    // 把快照的回程扣住不放：真事里它就是可能比第一批增量还慢
    let snapshotCaptured!: () => void;
    const captured = new Promise<void>((resolve) => (snapshotCaptured = resolve));
    const hold = latch();
    await openServer({
      holdSubAgentSnapshot: () => {
        snapshotCaptured();
        return hold.wait;
      },
    });

    await send("查一件事");

    // 子 Agent 已经跑了一会儿：服务端那一刻的快照里有一条用户消息 + 半句正文
    const sub = new FakeSubAgent();
    sub.pushMessage(USER_ROLE, "子任务");
    sub.pushMessage(ASSISTANT_ROLE, "答");
    server.agent.startSubAgent(sub);

    // 快照已在服务端**定格**（那一刻还没有任何增量），回程还扣着
    await captured;

    // 增量先到，并且比快照那份更全（"答" → "答案"）
    sub.emitDelta("答");
    sub.emitDelta("案");
    const streamed = await waitFor(
      () => latestAgents()?.[0]?.messages.at(-1)?.content === "答案" && latestAgents()?.[0],
      "增量先上屏",
    );
    // 此刻只有本地拼出来的那一条：快照还在路上（这就是那条竞态本身）
    expect(streamed.messages).toHaveLength(1);

    hold.open();

    // 快照回来之后：它那份内容补上了（用户消息在），而正文是**更全**的那份
    const merged = await waitFor(
      () => latestAgents()?.[0]?.messages.length === 2 && latestAgents()?.[0],
      "快照与增量合并之后的栏目",
    );
    expect(merged.messages[0]).toMatchObject({ role: "user", content: "子任务" });
    // 直接赋值的话这里会是快照那一刻的「答」—— 屏幕上的答案凭空短一截，而本轮不会再补上
    expect(merged.messages[1]).toMatchObject({ role: "assistant", content: "答案" });
  });

  it("ended 只改状态，且 failed 不被后来的 done 覆盖", async () => {
    await send("查一件事");
    const sub = server.agent.startSubAgent();
    await waitFor(() => latestAgents()?.[0], "子 Agent 的视图");

    // 子 Agent 出错：服务端标 failed 并发 `session.subAgent.ended{failed}`
    sub.fail(new Error("模型 500"));
    const failed = await waitFor(
      () => latestAgents()?.[0]?.status === "failed" && latestAgents()?.[0],
      "failed 状态",
    );
    // 只改状态：栏目还在、序号还在（它没被这条事件清掉，正文也不归它管）
    expect(failed).toMatchObject({ id: "sub-1", index: 1, status: "failed" });

    // core 在 `finally` 里还会广播一次 `sub-agent-end`（出错的那一次也走这条路）。服务端今天
    // 已经用「只把仍在 running 的置为 done」挡了一层，但协议把 `failed` 写成**终态**，客户端
    // 这一层自己也要挡住 —— 所以这条 done 直接从事件出口发出去，验的就是客户端。
    server.hub.publish({
      event: SESSION_EVENTS.subAgentEnded,
      sessionId: conversationId,
      turnId: 1,
      subAgentId: "sub-1",
      status: "done",
    });

    // 再用「下一个子 Agent 开工」这条**真**事件把栏目重推一次：判据是那次推送里的 sub-1。
    // （不能等「那条 done 自己引起一次推送」——状态机把它吞掉了，吞掉正是对的行为：那一帧
    // 没有改变任何事实，再推一遍就是把一份完全相同的栏目重发一次）
    server.agent.startSubAgent();
    const after = await waitFor(
      () => (latestAgents()?.length === 2 ? latestAgents() : undefined),
      "第二个子 Agent 开工之后的那份栏目",
    );
    // 无脑覆盖会把 ✖ 擦成 ✓：用户会以为一个真的挂了的子任务成功了
    expect(after?.[0]).toMatchObject({ id: "sub-1", status: "failed" });
    expect(after?.[1]).toMatchObject({ id: "sub-2", index: 2, status: "running" });
  });

  it("session.turnEnd 清空栏目：推一条空数组（子 Agent 只活当前这一轮）", async () => {
    await send("第一轮");
    server.agent.startSubAgent();
    const shown = await waitFor(
      () => (latestAgents()?.length === 1 ? latestAgents() : undefined),
      "栏目里有一条",
    );
    expect(shown).toHaveLength(1);

    server.agent.finish();

    // 空数组 = 「这一轮的子 Agent 都没了」：render 据此把栏目收回去，退回主对话
    const cleared = await waitFor(
      () => (agentsEvents().at(-1)?.agents.length === 0 ? agentsEvents().at(-1) : undefined),
      "session.turnEnd 之后的清空事件",
    );
    expect(cleared?.conversationId).toBe(conversationId);
    expect(cleared?.agents).toEqual([]);
  });

  it("换过 id 的会话：agents 仍以 render 认识的那个 conversationId 上报", async () => {
    await send("第一轮");
    server.agent.emitDelta("答");
    server.agent.finish();
    await waitFor(() => eventsOf("done").length > 0, "第一轮收尾");

    // 另存为：活会话换键（与「换 id」那组用例同一套构造）
    await server.call<SessionSaveAsResult>("session.saveAs", {
      sessionId: conversationId,
      id: "chat_renamed",
    });
    await waitFor(() => eventsOf("migrated")[0], "migrated 事件");

    // 新 id 上跑第二轮，子 Agent 在这一轮开跑（服务端事件里的 sessionId 已是 chat_renamed）
    const startsBefore = eventsOf("start").length;
    await server.call("session.send", { sessionId: "chat_renamed", content: "迁移之后" });
    await waitFor(() => eventsOf("start").length > startsBefore, "新 id 上的 start");

    server.agent.startSubAgent();
    await waitFor(() => latestAgents()?.[0], "新 id 上的子 Agent 视图");

    const event = agentsEvents().at(-1)!;
    // 落回 render 认识的那个 key：报新 id 的话，这条栏目会贴到一段 render 从没见过、也永远
    // 不会选中过的会话上 —— 画面上等于什么都没发生（`keyOf` 与其它事件同一口径）
    expect(event.conversationId).toBe(conversationId);
    // 而拉快照用的是**服务端**的会话 id（服务端只认自己的键）：两件事别混为一谈
    expect(server.subAgentSnapshotCalls.at(-1)).toEqual({
      sessionId: "chat_renamed",
      subAgentId: "sub-1",
    });
  });
});
