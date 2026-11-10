/**
 * 事件翻译用例：服务端的 10 条事件怎么变成 render 的 `ChatStreamEvent`。
 *
 * 这里断言的是**render 会看到什么**（`server.pushed` 的顺序与形状），不是服务端内部状态
 * —— 翻译层唯一的验收口径就是这条通道。
 *
 * 最后一个 block 是个例外：`session.question` **不进 render**（`ChatStreamEvent` 里没有
 * 这一类），但它必须被答回去 —— 断言的是「客户端真的答了」与服务端认领了那条回答。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatStreamEvent, Conversation } from "@ai-zen/desktop-shared";
import type { HandoffMode, SessionSaveAsResult } from "@ai-zen/agents-client";
import { startTestServer, waitFor, AUTO_TITLE, type TestServer, type TestServerOptions } from "./test-harness.js";

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
  await server.layer.manager.invokeService("chat", "send", workspaceId, conversationId, content);
}

function eventsOf(type: ChatStreamEvent["type"]): ChatStreamEvent[] {
  return server.pushed.filter((event) => event.type === type);
}

/**
 * 服务端等「这次自动迁移用哪种方式交接」的缺省时限（`SessionManager` 的 `ASK_TIMEOUT_MS`）。
 *
 * 用例把它显式传给服务端，是为了让「客户端答得有多快」有一把可比的尺子：回答在几十毫秒
 * 内就回来了，与这个数差四个数量级。
 */
const ASK_TIMEOUT_MS = 300_000;

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

describe("收尾：turn.end 不带消息，必须补一次快照", () => {
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

describe("自动标题：session.titleChanged → renamed", () => {
  it("第一轮收尾后服务端起好名字，侧栏拿到的就是它", async () => {
    // 这一条要服务端真的去起名（其余用例不注入自动标题：那是 `turn.end` 之后的后台动作）
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

  it("回答失败（会话已收 / 来晚了）不推 error，同一会话后续 delta 与 turn.end 照常翻译", async () => {
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
