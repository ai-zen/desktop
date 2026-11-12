/**
 * 附件结局上屏那一条：`attachments` 事件 → 气泡上那几行字。
 *
 * 这里要钉住的是**文案的来源**：句子的每一个字都来自服务端（它按这条连接的语言渲染过），
 * 渲染层只决定「说不说、按什么顺序说」。所以下面三条用例的断言都是「等于服务端给的那句
 * 原文」，而不是「包含某个关键词」—— 后者放过一次悄悄改写。
 *
 * 另外两条是 F-H7 的两端：正常送达的**不打扰**、说了 dropped 却没给原因的**不能装没事**。
 */

import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { AgentNS } from "@ai-zen/agents-core";
import type { AttachmentOutcome, ProblemFact } from "@ai-zen/desktop-shared";
import { useChatStore } from "./chat.js";
import { attachmentNotes } from "./attachmentNotes.js";

const CONV = "conv-1";
const USER_MESSAGE = "m-user";

/** 服务端给的原因就是这一整份（码 + 参数 + 已渲染的那句），不是一句摘出来的话 */
function problem(message: string): ProblemFact {
  return { code: "message.imageFallback", messageKey: "message.imageFallback", params: {}, message };
}

function outcome(
  overrides: Partial<AttachmentOutcome> & { problemText?: string } = {},
): AttachmentOutcome {
  const { problemText, ...rest } = overrides;
  return {
    assetId: "a1",
    deliveredAs: "file_reference",
    section: null,
    problem: problemText === undefined ? null : problem(problemText),
    name: "图.png",
    ...rest,
  };
}

describe("附件结局上屏（attachments 事件）", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("服务端那句原文照搬进气泡（措辞、标点、文件名都是它给的）", () => {
    const store = useChatStore();
    store.ensure(CONV);
    store.activeConversationId = CONV;
    const serverText = "假模型 看不了图片，图.png 改成用文字描述发过去。";

    store.applyEvent({
      conversationId: CONV,
      type: "attachments",
      userMessageId: USER_MESSAGE,
      attachments: [outcome({ deliveredAs: "text_fallback", problemText: serverText })],
    });

    const stored = store.attachmentOutcomes[USER_MESSAGE];
    expect(attachmentNotes(stored)).toEqual([serverText]);
    // 原文：一个字都没有被加工过
    expect(attachmentNotes(stored)[0]).toBe(serverText);
  });

  it("正常送达的附件不打扰（`file_reference` / `inline` 且无原因 → 一个字都不出现）", () => {
    expect(
      attachmentNotes([
        outcome({ assetId: "a1", deliveredAs: "file_reference" }),
        outcome({ assetId: "a2", deliveredAs: "inline" }),
      ]),
    ).toEqual([]);
  });

  it("说了 dropped 却没给原因：补一句兜底（不能让一张图凭空消失）", () => {
    const notes = attachmentNotes([
      outcome({ assetId: "a1", deliveredAs: "dropped", problem: null, name: null }),
    ]);

    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("没能发出去");
  });

  it("逐张说明：几张图各有各的结局时按服务端给的顺序一句一行", () => {
    const notes = attachmentNotes([
      outcome({ assetId: "a1", deliveredAs: "dropped", problemText: "图.png 没能发出去，这条消息里没有它。" }),
      outcome({ assetId: "a2", deliveredAs: "file_reference" }),
      outcome({ assetId: "a3", deliveredAs: "text_fallback", problemText: "假模型 看不了图片，另一张.png 改成用文字描述发过去。" }),
    ]);

    expect(notes).toEqual([
      "图.png 没能发出去，这条消息里没有它。",
      "假模型 看不了图片，另一张.png 改成用文字描述发过去。",
    ]);
  });

  it("结局挂在它自己那条用户消息上（`done` 全量替换之后仍按 id 找得到）", () => {
    const store = useChatStore();
    store.ensure(CONV);
    store.activeConversationId = CONV;

    store.applyEvent({
      conversationId: CONV,
      type: "attachments",
      userMessageId: USER_MESSAGE,
      attachments: [outcome({ deliveredAs: "dropped", problemText: "有一张没能发出去" })],
    });
    store.applyEvent({
      conversationId: CONV,
      type: "done",
      messages: [{ id: USER_MESSAGE, role: AgentNS.Role.User, content: "发一张图" }],
    });

    expect(attachmentNotes(store.attachmentOutcomes[USER_MESSAGE])).toEqual(["有一张没能发出去"]);
    // 别的消息没有结局（不会把这一轮的几行字挂到每条气泡上）
    expect(store.attachmentOutcomes["m-other"]).toBeUndefined();
  });
});
