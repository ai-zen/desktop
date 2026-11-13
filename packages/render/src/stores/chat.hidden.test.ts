/**
 * `hidden` 的消息整条不显示（宿主建会话时写进去的那条「当前目录」）。
 *
 * 口径：`hidden` 是 core 的原意 —— **不给人看**。所以界面侧只做一件事：把它从「要显示的那一份」
 * 里滤掉，不看它内容写了什么。
 *
 * 这里锁三件：
 *   1. 过滤点只有 `viewMessages` 一处（气泡 / 渲染窗口 / 滚动跟随读的都是它）；
 *   2. store 里存着的 `messages` 不动（重连补拉与重试用的还是宿主给的那一份）；
 *   3. `hidden: false` 是正常消息（判据严格比 `true`）。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { AgentNS } from "@ai-zen/agents-core";
import { useChatStore } from "./chat.js";
import { MAIN_AGENT_VIEW_ID } from "./agentView.js";
import { isHidden, visibleMessages } from "./messageVisibility.js";

const CONV = "conv-1";

/** 宿主建会话时写进去的那条：`hidden: true` 的 user 消息，内容里写着当前目录 */
const injected = (): AgentNS.Message => ({
  id: "inj",
  role: AgentNS.Role.User,
  hidden: true,
  content: "当前目录是 /tmp/x",
});

const said = (id: string, content: string): AgentNS.Message => ({
  id,
  role: AgentNS.Role.User,
  content,
});

describe("isHidden / visibleMessages（判据本身）", () => {
  it("只认 hidden === true：false 与不给字段都是正常消息", () => {
    expect(isHidden(injected())).toBe(true);
    expect(isHidden({ ...said("u1", "你好"), hidden: false })).toBe(false);
    expect(isHidden(said("u2", "你好"))).toBe(false);
  });

  it("过滤保留原来的顺序与内容，且不改原数组", () => {
    const messages = [said("u1", "一"), injected(), said("u2", "二")];
    expect(visibleMessages(messages).map((m) => m.id)).toEqual(["u1", "u2"]);
    expect(messages).toHaveLength(3);
  });
});

describe("chat store · viewMessages 滤掉 hidden", () => {
  let store: ReturnType<typeof useChatStore>;

  beforeEach(() => {
    setActivePinia(createPinia());
    store = useChatStore();
    store.ensure(CONV);
    store.activeConversationId = CONV;
  });

  it("主对话：hidden 的那条不出现在要显示的列表里", () => {
    store.applyEvent({ conversationId: CONV, type: "done", messages: [injected(), said("u1", "你好")] });

    expect(store.viewMessages.map((m) => m.id)).toEqual(["u1"]);
  });

  it("store 里存着的仍是宿主给的全量（hidden 的没被删掉）", () => {
    store.applyEvent({ conversationId: CONV, type: "done", messages: [injected(), said("u1", "你好")] });

    expect(store.messages.map((m) => m.id)).toEqual(["inj", "u1"]);
  });

  it("子 Agent 视图一视同仁：它自己的 hidden 消息也不画", () => {
    store.applyEvent({
      conversationId: CONV,
      type: "agents",
      agents: [
        {
          id: "sub-a",
          index: 1,
          status: "running",
          messages: [injected(), { id: "sub-a-m1", role: AgentNS.Role.Assistant, content: "做完了" }],
        },
      ],
    });
    store.selectAgent(CONV, "sub-a");

    expect(store.viewMessages.map((m) => m.id)).toEqual(["sub-a-m1"]);

    store.selectAgent(CONV, MAIN_AGENT_VIEW_ID);
    expect(store.viewMessages).toEqual([]);
  });

  it("流式期间那条 user 回显照常上屏（hidden 只针对宿主注入的消息）", () => {
    store.applyEvent({ conversationId: CONV, type: "start" });
    store.applyEvent({ conversationId: CONV, type: "user", message: { id: "u1", role: AgentNS.Role.User, content: "你好" } });

    expect(store.viewMessages.map((m) => m.id)).toEqual(["u1"]);
  });
});
