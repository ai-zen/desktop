/**
 * 事件翻译用例：服务端的 10 条事件怎么变成 render 的 `ChatStreamEvent`。
 *
 * 这里断言的是**render 会看到什么**（`server.pushed` 的顺序与形状），不是服务端内部状态
 * —— 翻译层唯一的验收口径就是这条通道。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatStreamEvent, Conversation } from "@ai-zen/desktop-shared";
import type { SessionSaveAsResult } from "@ai-zen/agents-client";
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
