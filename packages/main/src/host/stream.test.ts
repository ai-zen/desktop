/**
 * `StreamingMessage` 用例：增量怎么攒进那条助手消息。
 *
 * 这里断言的规则**不是本仓定的**——它们是 core 的 `applyChunk` 的规则（正文追加、思考单独一根、
 * 工具参数「整串重发」与「只发增量」两种厂商行为都要认、内容段数组按 index 落位）。所以这一组用例
 * 的作用是**钉住「我们确实用了它」**：一旦有人在这里手写一份拼接（把 delta 的字段挨个搬到 receiver
 * 上），这些边界情形会当场红。
 */

import { AgentNS } from "@ai-zen/agents-core";
import { describe, expect, it } from "vitest";
import { StreamingMessage } from "./stream.js";

describe("StreamingMessage：正文", () => {
  it("多片正文按顺序接起来，状态是「还在写」", () => {
    const stream = new StreamingMessage();
    stream.applyDelta("m1", { content: "你" });
    stream.applyDelta("m1", { content: "好" });
    const message = stream.applyDelta("m1", { content: "！" });

    expect(message.id).toBe("m1");
    expect(message.role).toBe(AgentNS.Role.Assistant);
    expect(message.content).toBe("你好！");
    expect(message.status).toBe(AgentNS.MessageStatus.Writing);
  });

  it("中间夹一片什么都不带的增量：正文不动（收尾片常常只有 usage / finish_reason）", () => {
    const stream = new StreamingMessage();
    stream.applyDelta("m1", { content: "开头" });
    const message = stream.applyDelta("m1", {});

    expect(message.content).toBe("开头");
  });
});

describe("StreamingMessage：思考", () => {
  it("思考与正文各走各的（正文里不该混进思考的内容）", () => {
    const stream = new StreamingMessage();
    stream.applyDelta("m1", { reasoning_content: "想一" });
    stream.applyDelta("m1", { reasoning_content: "想" });
    const message = stream.applyDelta("m1", { content: "答案" });

    expect(message.reasoning_content).toBe("想一想");
    expect(message.content).toBe("答案");
  });
});

describe("StreamingMessage：工具调用", () => {
  it("名字一次给全、参数多片到达：拼成一条完整的调用", () => {
    const stream = new StreamingMessage();
    // 第一片就是真实厂商的形状：名字 + 一个空参数串（只给 name 不给 arguments 时，core 会把
    // 参数串当成 undefined 去接，得到 "undefined{…}" —— 所以这里照真实形状写）
    stream.applyDelta("m1", {
      tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read", arguments: "" } }],
    });
    stream.applyDelta("m1", { tool_calls: [{ index: 0, function: { arguments: '{"pa' } }] });
    const message = stream.applyDelta("m1", { tool_calls: [{ index: 0, function: { arguments: 'th":"a"}' } }] });

    expect(message.tool_calls).toHaveLength(1);
    expect(message.tool_calls?.[0]?.function?.name).toBe("read");
    expect(message.tool_calls?.[0]?.function?.arguments).toBe('{"path":"a"}');
  });

  it("有的厂商把「到目前为止的整串」重发：不能变成两份参数", () => {
    const stream = new StreamingMessage();
    stream.applyDelta("m1", {
      tool_calls: [{ index: 0, function: { name: "read", arguments: '{"a":' } }],
    });
    // 整串重发（以已攒的为前缀）
    const message = stream.applyDelta("m1", {
      tool_calls: [{ index: 0, function: { arguments: '{"a":1}' } }],
    });

    expect(message.tool_calls?.[0]?.function?.arguments).toBe('{"a":1}');
  });

  it("多个调用：各片带自己的 index，按 index 落位（并行工具）", () => {
    const stream = new StreamingMessage();
    // 真实的并行调用是「每片一个 tool call」：`applyChunk` 每片只认 `tool_calls[0]`
    //（core 的现有实现，本仓不另写一份）
    stream.applyDelta("m1", {
      tool_calls: [{ index: 0, id: "a", function: { name: "read", arguments: "{}" } }],
    });
    stream.applyDelta("m1", {
      tool_calls: [{ index: 1, id: "b", function: { name: "write", arguments: '{"x"' } }],
    });
    const message = stream.applyDelta("m1", {
      tool_calls: [{ index: 1, function: { arguments: ":1}" } }],
    });

    expect(message.tool_calls?.map((call) => call.function?.name)).toEqual(["read", "write"]);
    expect(message.tool_calls?.[1]?.function?.arguments).toBe('{"x":1}');
  });
});

describe("StreamingMessage：换 id / 重置", () => {
  it("id 变了就重开一条（两条消息的正文不许拼在一起）", () => {
    const stream = new StreamingMessage();
    stream.applyDelta("m1", { content: "上一轮" });
    const message = stream.applyDelta("m2", { content: "这一轮" });

    expect(message.id).toBe("m2");
    expect(message.content).toBe("这一轮");
    expect(stream.messageId).toBe("m2");
  });

  it("reset 之后手上没有消息（下一片会开一条新的）", () => {
    const stream = new StreamingMessage();
    stream.applyDelta("m1", { content: "x" });
    stream.reset();

    expect(stream.current).toBeNull();
    expect(stream.messageId).toBeNull();
    expect(stream.applyDelta("m2", { content: "y" }).content).toBe("y");
  });

  it("用量钉到手上那条消息上（增量里没有 usage，它来自 `usage` 事件）", () => {
    const stream = new StreamingMessage();
    stream.applyDelta("m1", { content: "x" });
    const message = stream.attachUsage({
      prompt_tokens: 10,
      completion_tokens: 2,
      total_tokens: 12,
    });

    expect(message?.usage).toEqual({ prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 });
  });

  it("还没开始拼时用量无处可钉：返回空，不凭空造一条消息", () => {
    const stream = new StreamingMessage();
    expect(stream.attachUsage({ prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 })).toBeNull();
    expect(stream.current).toBeNull();
  });
});
