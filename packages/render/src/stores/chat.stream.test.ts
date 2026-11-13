/**
 * `chat store` 里**生成六态**那一条（`stream` 事件 → 正在生成那行字）。
 *
 * 六态本身是宿主的事实（`run.state.generation.phase`，PRD L8），store 只做两件事：把态存下来、
 * 按一句界面用词说出来。所以这里验的是「存的对不对 + 说的人话对不对」，不验「现在到底算哪一态」
 * —— 那是宿主的事，在这里推一遍就等于抄了第二份判据。
 */

import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useChatStore } from "./chat.js";

const CONV = "conv-1";

describe("生成六态（stream 事件）", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("开始输出：那行字换成「正在输出…」", () => {
    const store = useChatStore();
    store.ensure(CONV);
    store.activeConversationId = CONV;

    store.applyEvent({ conversationId: CONV, type: "stream", phase: "generating", toolCalls: [] });

    expect(store.streamingHint).toBe("正在输出…");
  });

  it("在等工具：只念还在跑的那几个（并行时跑完的不该还挂着）", () => {
    const store = useChatStore();
    store.ensure(CONV);
    store.activeConversationId = CONV;

    store.applyEvent({
      conversationId: CONV,
      type: "stream",
      phase: "awaiting_tools",
      toolCalls: [
        { index: 0, function: { name: "read" } },
        { index: 1, function: { name: "grep" } },
      ],
    });

    expect(store.streamingHint).toBe("正在等待工具结果…（read、grep）");
  });

  it("还没拿到态时用一句中的话，不留空白", () => {
    const store = useChatStore();
    store.ensure(CONV);
    store.activeConversationId = CONV;

    expect(store.streamingHint).toBe("正在思考…");
  });

  it("六态变化不动消息与流式态（那是「在哪一态」，不是「开始了 / 结束了」）", () => {
    const store = useChatStore();
    const slot = store.ensure(CONV);
    store.activeConversationId = CONV;
    store.applyEvent({ conversationId: CONV, type: "start" });

    store.applyEvent({ conversationId: CONV, type: "stream", phase: "thinking", toolCalls: [] });

    expect(store.streaming).toBe(true);
    expect(slot.messages).toEqual([]);
  });

  it("收尾（done）把六态清掉（下一轮不该顶着上一轮那行字）", () => {
    const store = useChatStore();
    store.ensure(CONV);
    store.activeConversationId = CONV;
    store.applyEvent({ conversationId: CONV, type: "start" });
    store.applyEvent({ conversationId: CONV, type: "stream", phase: "awaiting_tools", toolCalls: [{ index: 0, function: { name: "read" } }] });

    store.applyEvent({ conversationId: CONV, type: "done", messages: [] });

    expect(store.streaming).toBe(false);
    expect(store.streamingHint).toBe("正在思考…");
  });
});
