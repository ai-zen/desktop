/**
 * `chat store` 里子 Agent 栏目那部分（`agents` 事件 → 整份替换 + 选中态修正 + `viewMessages`）。
 *
 * 为什么敢在 node 环境里直接调 store：`stores/chat.ts` 的模块级 import（element-plus / pinia /
 * apis）在 vitest 的 node 环境下能正常加载（apis 层对 `window.electronAPI` 是惰性访问），
 * 所以这一条**走的是生产代码本身**，而不是另写一份影子实现。
 *
 * 纯规则的穷举（Tab 循环顺序、各种"消失"的组合）在 `agentView.test.ts` 里；这里只锁
 * 「store 有没有把那条规则接上」以及两个 getter 的取值口径。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import type { ChatStreamEvent, SubAgentView } from "@ai-zen/desktop-shared";
import { AgentNS } from "@ai-zen/agents-core";
import { useChatStore } from "./chat.js";
import { MAIN_AGENT_VIEW_ID } from "./agentView.js";

const CONV = "conv-1";

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
  store = useChatStore();
  store.activeConversationId = CONV;
  store.ensure(CONV);
});

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
