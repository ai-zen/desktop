/**
 * `agentView.ts` 的用例：栏目选中态修正 + Tab 循环顺序。
 *
 * 这两条是纯逻辑，也是这次改动的**唯一易错点**（一轮结束时栏目整份消失，选中态若不同步
 * 修正，会话就停在一段已经不存在的子对话上）。组件渲染本身不在这一层测：那需要 jsdom +
 * @vue/test-utils，属于另一笔投入。
 */
import { describe, expect, it } from "vitest";
import type { SubAgentView } from "@ai-zen/desktop-shared";
import { MAIN_AGENT_VIEW_ID, nextAgentViewId, resolveActiveAgentId } from "./agentView.js";

/** 造一个子 Agent 视图（只关心 id / index，消息与状态对这些规则无关） */
function agent(id: string, index: number, status: SubAgentView["status"] = "running"): SubAgentView {
  return { id, index, status, messages: [] };
}

describe("resolveActiveAgentId", () => {
  it("① 选中的子 Agent 还在新列表里 → 保持不动", () => {
    const agents = [agent("sub-a", 1), agent("sub-b", 2)];
    expect(resolveActiveAgentId(agents, "sub-b")).toBe("sub-b");
  });

  it("① 只是别人的状态变了（整份替换但 id 不变）→ 仍然保持", () => {
    const before = [agent("sub-a", 1, "running")];
    expect(resolveActiveAgentId(before, "sub-a")).toBe("sub-a");
    const after = [agent("sub-a", 1, "done")];
    expect(resolveActiveAgentId(after, "sub-a")).toBe("sub-a");
  });

  it("② 这一轮结束（agents: []）→ 退回主对话", () => {
    expect(resolveActiveAgentId([], "sub-a")).toBe(MAIN_AGENT_VIEW_ID);
  });

  it("② 换了一批子 Agent（旧 id 不在新列表里）→ 退回主对话", () => {
    const nextTurn = [agent("sub-c", 1), agent("sub-d", 2)];
    expect(resolveActiveAgentId(nextTurn, "sub-a")).toBe(MAIN_AGENT_VIEW_ID);
  });

  it("③ 从没选过子 Agent（\"\"）→ 仍是 \"\"，不会被顺手选到某个子 Agent 上", () => {
    const agents = [agent("sub-a", 1), agent("sub-b", 2)];
    expect(resolveActiveAgentId(agents, MAIN_AGENT_VIEW_ID)).toBe(MAIN_AGENT_VIEW_ID);
    expect(resolveActiveAgentId([], MAIN_AGENT_VIEW_ID)).toBe(MAIN_AGENT_VIEW_ID);
  });
});

describe("nextAgentViewId", () => {
  const agents = [agent("sub-a", 1), agent("sub-b", 2)];

  it("循环顺序：主对话 → 子1 → 子2 → 主对话", () => {
    const step1 = nextAgentViewId(agents, MAIN_AGENT_VIEW_ID);
    expect(step1).toBe("sub-a");
    const step2 = nextAgentViewId(agents, step1);
    expect(step2).toBe("sub-b");
    // 末位回到主对话（首尾相接，不是停在最后一个）
    expect(nextAgentViewId(agents, step2)).toBe(MAIN_AGENT_VIEW_ID);
  });

  it("只有一个子 Agent 时在主对话与它之间来回", () => {
    const one = [agent("sub-a", 1)];
    expect(nextAgentViewId(one, MAIN_AGENT_VIEW_ID)).toBe("sub-a");
    expect(nextAgentViewId(one, "sub-a")).toBe(MAIN_AGENT_VIEW_ID);
  });

  it("没有子 Agent：无处可切，返回主对话", () => {
    expect(nextAgentViewId([], MAIN_AGENT_VIEW_ID)).toBe(MAIN_AGENT_VIEW_ID);
    // 选中项失效 + 栏目已空（Tab 实际不会走到这里，规则本身仍需自洽）
    expect(nextAgentViewId([], "sub-a")).toBe(MAIN_AGENT_VIEW_ID);
  });

  it("选中项已失效（不在列表里）：当作主对话起步，下一个是子1", () => {
    expect(nextAgentViewId(agents, "sub-gone")).toBe("sub-a");
  });
});
