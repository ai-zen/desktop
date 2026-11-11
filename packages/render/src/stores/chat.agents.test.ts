/**
 * `chat store` 里子 Agent 栏目那部分（`agents` 事件 → 整份替换 + 选中态修正 + `viewMessages`），
 * 以及 `send` / `retry` 的返回值（调用方拿它决定输入框里的字留不留 —— 发送失败时把用户敲的
 * 内容清空就是「把用户输入弄丢」）。
 *
 * 为什么敢在 node 环境里直接调 store：`stores/chat.ts` 的模块级 import（element-plus / pinia /
 * apis）在 vitest 的 node 环境下能正常加载（apis 层对 `window.electronAPI` 是惰性访问），
 * 所以这一条**走的是生产代码本身**，而不是另写一份影子实现。
 *
 * 纯规则的穷举（Tab 循环顺序、各种"消失"的组合）在 `agentView.test.ts` 里；这里只锁
 * 「store 有没有把那条规则接上」以及两个 getter 的取值口径。
 *
 * 发送那几条唯一换掉的东西是 `apis/chat`（`vi.mock`，不打真 IPC）；`workspace` / `conversation`
 * 两个 store 用**真件** —— 早退的判据就是它们俩的 active id，mock 掉等于把被测条件也 mock 了。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import type { ChatStreamEvent, SubAgentView } from "@ai-zen/desktop-shared";
import { AgentNS } from "@ai-zen/agents-core";
import { useChatStore } from "./chat.js";
import { useConversationStore } from "./conversation.js";
import { useWorkspaceStore } from "./workspace.js";
import { MAIN_AGENT_VIEW_ID } from "./agentView.js";

/** `apis/chat` 的入口（`vi.mock` 的工厂会被提升，所以用 `vi.hoisted` 拿变量） */
const chatMocks = vi.hoisted(() => ({ sendChatMessage: vi.fn() }));

vi.mock("../apis/chat.js", () => ({
  sendChatMessage: chatMocks.sendChatMessage,
  abortChatMessage: vi.fn(),
  getChatState: vi.fn(),
  onChatPush: vi.fn(),
}));

const CONV = "conv-1";
const WS = "ws-1";

function agent(id: string, index: number, status: SubAgentView["status"] = "running"): SubAgentView {
  return {
    id,
    index,
    status,
    messages: [{ id: `${id}-m1`, role: AgentNS.Role.Assistant, content: `${id} says hi` }],
  };
}

function pushAgents(agents: SubAgentView[]): ChatStreamEvent {
  return { conversationId: CONV, type: "agents", agents };
}

let store: ReturnType<typeof useChatStore>;

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
  store = useChatStore();
  store.activeConversationId = CONV;
  store.ensure(CONV);
});

/** 摆出「一个工作区 + 一个打开的会话」：`send` 的前置条件，缺一条就走早退 */
function openSession(): void {
  useWorkspaceStore().activeWorkspaceId = WS;
  useConversationStore().activeConversationId = CONV;
}

describe("chat store · agents 事件", () => {
  it("整份替换：新列表直接换掉本地那份（顺序照数组，不重排）", () => {
    store.applyEvent(pushAgents([agent("sub-a", 1), agent("sub-b", 2)]));
    expect(store.agents.map((a) => a.id)).toEqual(["sub-a", "sub-b"]);
    expect(store.agents.map((a) => a.index)).toEqual([1, 2]);

    store.applyEvent(pushAgents([agent("sub-a", 1, "done")]));
    expect(store.agents.map((a) => a.id)).toEqual(["sub-a"]);
    expect(store.agents[0]!.status).toBe("done");
  });

  it("③ 从没选过子 Agent：activeAgentId 恒为 \"\"（来了子 Agent 也不会自动跳过去）", () => {
    expect(store.activeAgentId).toBe(MAIN_AGENT_VIEW_ID);
    store.applyEvent(pushAgents([agent("sub-a", 1)]));
    expect(store.activeAgentId).toBe(MAIN_AGENT_VIEW_ID);
  });

  it("① 选中项还在新列表里 → 保持选中", () => {
    store.applyEvent(pushAgents([agent("sub-a", 1), agent("sub-b", 2)]));
    store.selectAgent(CONV, "sub-b");
    expect(store.activeAgentId).toBe("sub-b");

    // 同一批 id 整份替换（状态变了、新消息到了）：选中态不能丢
    store.applyEvent(pushAgents([agent("sub-a", 1, "done"), agent("sub-b", 2, "running")]));
    expect(store.activeAgentId).toBe("sub-b");
  });

  it("② 这一轮结束（agents: []）→ 退回主对话", () => {
    store.applyEvent(pushAgents([agent("sub-a", 1)]));
    store.selectAgent(CONV, "sub-a");
    store.applyEvent(pushAgents([]));
    expect(store.agents).toEqual([]);
    expect(store.activeAgentId).toBe(MAIN_AGENT_VIEW_ID);
  });

  it("② 换了一批子 Agent（旧 id 消失）→ 退回主对话", () => {
    store.applyEvent(pushAgents([agent("sub-a", 1)]));
    store.selectAgent(CONV, "sub-a");
    store.applyEvent(pushAgents([agent("sub-c", 1)]));
    expect(store.activeAgentId).toBe(MAIN_AGENT_VIEW_ID);
  });

  it("子 Agent 的状态/消息变化不影响主对话的 messages / streaming", () => {
    store.applyEvent({ conversationId: CONV, type: "start" });
    store.applyEvent({ conversationId: CONV, type: "user", id: "u1", content: "hi" });
    const mainMessages = store.messages;

    store.applyEvent(pushAgents([agent("sub-a", 1, "failed")]));
    expect(store.messages).toEqual(mainMessages);
    expect(store.streaming).toBe(true);
  });
});

describe("chat store · send / retry 的返回值", () => {
  // 这一批锁的是「调用方能不能知道到底发出去没有」：`handleSend` 靠这个布尔决定输入框
  // 里的字留不留。返回 void 时它只能先清空，早退/失败就把用户敲的内容弄丢了。

  it("① 成功 → 返回 true（内容原样交给了服务端）", async () => {
    openSession();
    chatMocks.sendChatMessage.mockResolvedValue(undefined);

    await expect(store.send("你好")).resolves.toBe(true);
    expect(chatMocks.sendChatMessage).toHaveBeenCalledWith(WS, CONV, "你好");
    expect(store.error).toBe("");
  });

  it("② 没有活动工作区 → 返回 false，且一个字节都没提交", async () => {
    // 只开会话、不开工作区
    useConversationStore().activeConversationId = CONV;

    await expect(store.send("你好")).resolves.toBe(false);
    expect(chatMocks.sendChatMessage).not.toHaveBeenCalled();
  });

  it("② 没有打开的会话 → 返回 false，且一个字节都没提交", async () => {
    // 只开工作区、没有会话
    useWorkspaceStore().activeWorkspaceId = WS;
    useConversationStore().activeConversationId = "";

    await expect(store.send("你好")).resolves.toBe(false);
    expect(chatMocks.sendChatMessage).not.toHaveBeenCalled();
  });

  it("③ invoke 抛错 → 返回 false，st.error 照旧写上、streaming 放下（既有兜底不许退化）", async () => {
    openSession();
    store.applyEvent({ conversationId: CONV, type: "start" });
    chatMocks.sendChatMessage.mockRejectedValue(new Error("IPC 断了"));

    await expect(store.send("重试我")).resolves.toBe(false);
    expect(store.error).toBe("IPC 断了");
    expect(store.streaming).toBe(false);
    // 失败的内容留着，消息气泡上的重试入口靠它
    expect(store.lastFailedContent).toBe("重试我");
  });

  it("④ retry 把 send 的布尔值透传出来（成功 → true，没东西可重试 → false）", async () => {
    openSession();
    chatMocks.sendChatMessage.mockRejectedValue(new Error("第一次失败"));
    await store.send("重试我");

    chatMocks.sendChatMessage.mockResolvedValue(undefined);
    await expect(store.retry()).resolves.toBe(true);
    expect(chatMocks.sendChatMessage).toHaveBeenLastCalledWith(WS, CONV, "重试我");
  });

  it("④ retry 在没东西可重试时返回 false（调用方不必猜 undefined 是什么意思）", async () => {
    openSession();

    await expect(store.retry()).resolves.toBe(false);
    expect(chatMocks.sendChatMessage).not.toHaveBeenCalled();
  });
});

describe("chat store · viewMessages", () => {
  it("选中主对话 → 主对话消息；选中子 Agent → 它自己的消息", () => {
    store.applyEvent({ conversationId: CONV, type: "user", id: "u1", content: "hi" });
    store.applyEvent(pushAgents([agent("sub-a", 1)]));

    expect(store.viewMessages.map((m) => m.id)).toEqual(["u1"]);

    store.selectAgent(CONV, "sub-a");
    expect(store.viewMessages.map((m) => m.id)).toEqual(["sub-a-m1"]);

    store.selectAgent(CONV, MAIN_AGENT_VIEW_ID);
    expect(store.viewMessages.map((m) => m.id)).toEqual(["u1"]);
  });
});
