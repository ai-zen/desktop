/**
 * 跑中发送（宿主回了 `queued: true`）在界面这一侧的后果。
 *
 * 这一条的两端都不由 render 定：回显那条消息是 main 推来的 `user` 事件（内容是手上那句正文、
 * id 是宿主入队时定死的那个），轮末落库那条也从同一个通道来（同一个 id、内容是宿主拼好的
 * 内容段数组）。所以这里只验一件 render 真负责的事：**同一个 id 只占一个位置** ——
 * 回显先上屏，轮末那条到达时是替换（图片跟着补上），全程不会出现两条。
 *
 * 另一半是那句提示：它走 `notice` → toast，**不碰** `error`。错误条是「本轮失败了」的位置，
 * 排队不是失败；塞进去还会被下一轮的 `done` 替它销账。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { AgentNS } from "@ai-zen/agents-core";
import type { LocalizedText } from "@ai-zen/desktop-shared";
import { useChatStore } from "./chat.js";
import { resetDeps, stubDeps } from "../deps.js";

const CONV = "conv-1";
const QUEUED_ID = "m-queued";

/** main 的 `echoQueuedSend` 推来的那条：手上这句正文 + 宿主入队时给的 id */
const echo: AgentNS.Message = { id: QUEUED_ID, role: AgentNS.Role.User, content: "再看看这个" };

/** 轮末落库那条：同一个 id，内容是宿主拼好的内容段数组（这里带一张图） */
const stored = {
  id: QUEUED_ID,
  role: AgentNS.Role.User,
  content: [
    { index: 0, type: "text", text: "再看看这个" },
    { index: 1, type: "image_url", image_url: { url: "" }, __asset_id: "a1" },
  ],
} as AgentNS.Message;

/** main 那句提示（文案在 main 那一侧定死，这里只是把同一句话搬过来） */
const noticeText = (message: string): LocalizedText => ({ code: "", messageKey: "", params: {}, message });

describe("排队受理：回显与轮末那条同 id（不会画成两条）", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    stubDeps({ notify: { info: () => {} } });
  });

  afterEach(() => {
    resetDeps();
  });

  it("回显先上屏，轮末库里那条（同 id）到达时是替换：始终只有一条", () => {
    const store = useChatStore();
    store.ensure(CONV);
    store.activeConversationId = CONV;

    // 这一轮本来就在跑（排队的前提），回显只是插进这一轮的消息列表
    store.applyEvent({ conversationId: CONV, type: "start" });
    store.applyEvent({ conversationId: CONV, type: "user", message: echo });

    expect(store.viewMessages.map((message) => message.id)).toEqual([QUEUED_ID]);

    // 轮末：宿主落库那条到了（同一个 id）—— 替换，不是追加
    store.applyEvent({ conversationId: CONV, type: "user", message: stored });

    expect(store.viewMessages.map((message) => message.id)).toEqual([QUEUED_ID]);
    // 图也跟着补上了（回显那一刻只有文字：内容段由宿主在落库时才拼出来）
    expect(store.viewMessages[0]).toEqual(stored);

    // 收尾那次 `done` 是全量替换：仍旧只有这一条
    store.applyEvent({ conversationId: CONV, type: "done", messages: [stored] });

    expect(store.viewMessages.map((message) => message.id)).toEqual([QUEUED_ID]);
    expect(store.viewMessages[0]).toEqual(stored);
  });

  it("那句提示走 toast，不写进错误条（排队不是「这一轮失败」）", () => {
    const info = vi.fn();
    stubDeps({ notify: { info } });
    const store = useChatStore();
    store.ensure(CONV);
    store.activeConversationId = CONV;

    store.applyEvent({
      type: "notice",
      level: "info",
      duration: null,
      text: noticeText("已排队，会在当前这一轮的工具轮结束后送出。"),
      conversationId: CONV,
    });

    // 原文照搬给 toast（一个字都不在这里改）
    expect(info).toHaveBeenCalledWith("已排队，会在当前这一轮的工具轮结束后送出。");
    // 错误条空着：这一轮没失败
    expect(store.error).toBe("");
    // 通知不是消息：消息列表一个字都没动
    expect(store.viewMessages).toEqual([]);
  });
});
