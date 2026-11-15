/**
 * `chat store` 里**问题对象**那一条：推送接住 → 面板出现 → 作答 → `question.answer` → 按 `effects`
 * 切会话。
 *
 * ## 为什么这些用例盯的是 store 而不是组件
 *
 * 本仓没有组件测试（见 `vitest.config.ts`：node 环境、不渲染 DOM）。所以「面板出现」这件事在
 * 这里被钉成它**唯一的数据前提**：`pendingQuestions` 里有那道题、`inputBlocked` 为真（视图那边
 * 就是拿这两个 getter 决定画不画面板、禁不禁用输入区）。整条链于是从「宿主推来一道题」一路到
 * 「宿主说任务搬到新对话，界面切过去了」，中间没有一段是假设。
 *
 * ## 换掉的东西只有两处
 *
 * `deps.api`（`stubDeps`，不打真 IPC）与 `deps.notify`（node 里没有 DOM，弹不出 toast；
 * 而「切过去之后说了哪两句」恰好是要断言的东西）。`workspace` / `conversation` 两个 store 用**真件**
 * —— 「按 effects 切会话」这件事就是它们俩合作的结果，mock 掉等于把被测的行为也 mock 了。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import type { ChatState, ConversationSummary, QuestionView } from "@ai-zen/desktop-shared";
import { resetDeps, stubDeps } from "../deps.js";
import { useChatStore } from "./chat.js";
import { useConversationStore } from "./conversation.js";

/** 宿主那一侧（IPC）：只摆本文件会走的四条 */
const apiMocks = {
  getChatState: vi.fn(),
  listQuestions: vi.fn(),
  answerQuestion: vi.fn(),
  listConversations: vi.fn(),
};

/** toast 的三个入口（`showNotice` 用它说话） */
const messageMocks = {
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
};

const WS = "ws-1";
const CONV = "conv-1";
const NEW_CONV = "conv-new";

// ==================================================================
// 夹具
// ==================================================================

/**
 * 一道交接题（宿主 `QuestionView` 原样形状）。
 *
 * `options` 的顺序就是宿主给的顺序：自交接 → 独立摘要 → 不交接。用例拿它钉「界面不重排」。
 */
function handoffQuestion(overrides: Partial<QuestionView> = {}): QuestionView {
  return {
    id: "q1",
    conversationId: CONV,
    kind: "handoff",
    state: "pending",
    prompt: {
      code: "ask.handoff",
      messageKey: "ask.handoff" as never,
      params: {},
      message: "上下文快满了，要交接吗？",
    },
    options: [
      {
        value: "handoff_self",
        label: { code: "o1", messageKey: "o1" as never, params: {}, message: "自交接（接着这段继续）" },
        detail: null,
      },
      {
        value: "handoff_summary",
        label: { code: "o2", messageKey: "o2" as never, params: {}, message: "独立摘要" },
        detail: { code: "o2d", messageKey: "o2d" as never, params: {}, message: "把结论写成摘要，开一段新对话" },
      },
      {
        value: "no_handoff",
        label: { code: "o3", messageKey: "o3" as never, params: {}, message: "不交接" },
        detail: null,
      },
    ],
    answer: null,
    blocking: true,
    createdAt: "2026-11-11T00:00:00.000Z",
    updatedAt: "2026-11-11T00:00:00.000Z",
    ...overrides,
  };
}

/** 一份「什么都不在跑」的宿主现场状态（`chat.getState` 的返回），问题清单由调用方给 */
function idleState(conversationId: string, questions: QuestionView[] = []): ChatState {
  const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  const usageSnapshot = {
    turn: usage,
    total: usage,
    subAgent: usage,
    rate: { value: 0, unit: "tokens_per_second", basis: "completion" } as const,
    updatedAt: "2026-11-11T00:00:00.000Z",
  };
  return {
    conversationId,
    run: {
      conversationId,
      status: "idle",
      assistantMessageId: null,
      // 空闲时是空数组：没有在跑的一轮，就没有谁的队列可排（PRD D3）
      inbox: [],
      startedAt: null,
      settledAt: null,
      generation: null,
      outcome: null,
      problem: null,
      subagents: [],
      usage: usageSnapshot,
    },
    context: { usage, handoffThreshold: 0, guardThreshold: 0, overHandoff: false, overGuard: false },
    thinking: { preset: null, levels: [], selected: null, source: "not_adjustable", params: {} },
    usage: usageSnapshot,
    questions,
    updatedAt: "2026-11-11T00:00:00.000Z",
    messages: [],
  };
}

function summary(id: string): ConversationSummary {
  return {
    id,
    workspaceId: WS,
    agentId: "agent-1",
    modelId: "model-1",
    name: `会话 ${id}`,
    messageCount: 0,
    updatedAt: "2026-11-11T00:00:00.000Z",
    // 这一段没在跑：宿主对空闲会话给的就是 null（`running` 那边同理，省略即「不是 true」）
    run: null,
  };
}

/** 永不 resolve 的 promise：把「等」固定在某个确定的位置上 */
function pending<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  setActivePinia(createPinia());
  stubDeps({ api: apiMocks, notify: messageMocks });
  vi.clearAllMocks();
  // 缺省的宿主回答：快照里没有问题、现拉也没有、侧栏里就这一段
  apiMocks.getChatState.mockImplementation((_ws: string, id: string) => Promise.resolve(idleState(id)));
  apiMocks.listQuestions.mockResolvedValue([]);
  apiMocks.listConversations.mockResolvedValue([summary(CONV)]);
});

afterEach(() => {
  resetDeps();
});

/** 打开一段对话（`select` 才是真正的「打开」：它会让 chat store 去拉快照与问题） */
async function openConversation(conversationId = CONV): Promise<void> {
  await useConversationStore().select(WS, conversationId);
}

// ==================================================================
// 一道题是怎么到界面上的
// ==================================================================

describe("question 推送 → 作答面板的数据前提", () => {
  it("整份 `QuestionView` 存进那段对话的槽位，候选顺序照宿主给的（不重排）", () => {
    const store = useChatStore();
    store.activeConversationId = CONV;
    store.ensure(CONV);
    const question = handoffQuestion();

    store.applyEvent({ conversationId: CONV, type: "question", question });

    expect(store.pendingQuestions.map((item) => item.id)).toEqual(["q1"]);
    expect(store.pendingQuestions[0]?.prompt.message).toBe("上下文快满了，要交接吗？");
    // 候选就是宿主给的顺序与原文（界面直接照数组画按钮）
    expect(store.pendingQuestions[0]?.options.map((option) => option.label.message)).toEqual([
      "自交接（接着这段继续）",
      "独立摘要",
      "不交接",
    ]);
    expect(store.pendingQuestions[0]?.options[1]?.detail?.message).toBe("把结论写成摘要，开一段新对话");
  });

  it("`blocking: true` 挡着输入区；非 blocking 的题照样能发消息", () => {
    const store = useChatStore();
    store.activeConversationId = CONV;
    store.ensure(CONV);

    store.applyEvent({ conversationId: CONV, type: "question", question: handoffQuestion({ id: "q-block" }) });
    expect(store.inputBlocked).toBe(true);

    store.applyEvent({
      conversationId: CONV,
      type: "question",
      question: handoffQuestion({
        id: "q-block",
        blocking: false,
        updatedAt: "2026-11-11T00:00:05.000Z",
      }),
    });
    // 同一道题（同 id）的新版本替换旧的那份：不再挡
    expect(store.pendingQuestions.map((item) => item.id)).toEqual(["q-block"]);
    expect(store.inputBlocked).toBe(false);
  });

  it("已经答掉 / 过期的题不再占着面板（但仍留在槽位里）", () => {
    const store = useChatStore();
    store.activeConversationId = CONV;
    store.ensure(CONV);

    store.applyEvent({
      conversationId: CONV,
      type: "question",
      question: handoffQuestion({
        state: "answered",
        blocking: false,
        answer: { value: "no_handoff", answeredAt: "2026-11-11T00:00:09.000Z", answeredBy: "别的窗口" },
        updatedAt: "2026-11-11T00:00:09.000Z",
      }),
    });

    expect(store.pendingQuestions).toEqual([]);
    expect(store.inputBlocked).toBe(false);
    expect(store.byConversation[CONV]?.questions.map((item) => item.state)).toEqual(["answered"]);
  });

  it("问题推送比快照早到：快照落地时不会把它抹掉", async () => {
    const store = useChatStore();
    const snapshot = pending<ChatState>();
    apiMocks.getChatState.mockReturnValue(snapshot.promise);

    // 打开对话（快照还在飞），此时宿主推来一道题
    const opening = openConversation();
    await Promise.resolve();
    const question = handoffQuestion({ updatedAt: "2026-11-11T00:00:07.000Z" });
    store.applyEvent({ conversationId: CONV, type: "question", question });

    // 快照落地：它里面没有这道题（拍下快照的时刻题还不存在）
    snapshot.resolve(idleState(CONV, []));
    await opening;

    expect(store.pendingQuestions.map((item) => item.id)).toEqual(["q1"]);
    expect(store.inputBlocked).toBe(true);
  });
});

// ==================================================================
// 打开对话时现拉（多端共享）
// ==================================================================

describe("打开对话时现拉问题（PRD F-I9：多端看到同一个）", () => {
  it("快照里没有、`question.list` 里有：面板照样出来（别的一端挂上的题只走这条路）", async () => {
    apiMocks.listQuestions.mockResolvedValue([handoffQuestion()]);

    await openConversation();

    // 现拉用的是主机的 `question.list`（入参只有会话 id）
    expect(apiMocks.listQuestions).toHaveBeenCalledWith(CONV);
    expect(useChatStore().pendingQuestions.map((item) => item.id)).toEqual(["q1"]);
  });

  it("现拉失败不连累「打开对话」：快照那份还在，界面不报错", async () => {
    apiMocks.getChatState.mockResolvedValue(idleState(CONV, [handoffQuestion()]));
    apiMocks.listQuestions.mockRejectedValue(new Error("这条连接刚断"));

    await expect(openConversation()).resolves.toBeUndefined();

    expect(useChatStore().pendingQuestions.map((item) => item.id)).toEqual(["q1"]);
  });

  it("打开之后**什么都不发**：没有人点候选，就不替用户作答", async () => {
    apiMocks.listQuestions.mockResolvedValue([handoffQuestion()]);

    await openConversation();
    // 快照、现拉都回来了，题还挂在 pending 上等人
    await Promise.resolve();

    expect(apiMocks.answerQuestion).not.toHaveBeenCalled();
    expect(useChatStore().pendingQuestions[0]?.state).toBe("pending");
  });
});

// ==================================================================
// 作答 → question.answer → 按 effects 走
// ==================================================================

describe("作答：`question.answer` → 按 `effects` 决定留在原地还是切会话", () => {
  beforeEach(async () => {
    apiMocks.listQuestions.mockResolvedValue([handoffQuestion()]);
    await openConversation();
    apiMocks.listQuestions.mockClear();
  });

  it("点了候选：调 `question.answer { questionId, value }`，答完题从面板上消失、留在原对话", async () => {
    apiMocks.answerQuestion.mockResolvedValue({
      question: handoffQuestion({
        state: "answered",
        blocking: false,
        answer: { value: "no_handoff", answeredAt: "2026-11-11T00:00:10.000Z", answeredBy: "conn-1" },
        updatedAt: "2026-11-11T00:00:10.000Z",
      }),
      // 选了「不交接」：宿主说没开始交接，也没有新对话
      effects: { handoffStarted: false, newConversationId: null },
    });

    await useChatStore().answerQuestion("q1", "no_handoff");

    // 提交的就是用户点的那个候选值（没有默认值、没有替用户选）
    expect(apiMocks.answerQuestion).toHaveBeenCalledWith("q1", "no_handoff");
    // 题不再是 pending：面板自己收回去，输入区也不再挡
    expect(useChatStore().pendingQuestions).toEqual([]);
    expect(useChatStore().inputBlocked).toBe(false);
    // 留在原对话
    expect(useConversationStore().activeConversationId).toBe(CONV);
    // 答完之后再拉一次（多端时别处可能又挂上了新的题）
    expect(apiMocks.listQuestions).toHaveBeenCalledWith(CONV);
  });

  it("`effects.newConversationId` 非空：切到那段新对话，并说清两件事", async () => {
    apiMocks.listConversations.mockResolvedValue([summary(CONV), summary(NEW_CONV)]);
    apiMocks.answerQuestion.mockResolvedValue({
      question: handoffQuestion({
        state: "answered",
        blocking: false,
        answer: { value: "handoff_summary", answeredAt: "2026-11-11T00:00:10.000Z", answeredBy: "conn-1" },
        updatedAt: "2026-11-11T00:00:10.000Z",
      }),
      effects: { handoffStarted: true, newConversationId: NEW_CONV },
    });

    await useChatStore().answerQuestion("q1", "handoff_summary");

    // 交接顺带开出来的新对话：先重拉侧栏（新的一段得先在列表里），再切过去
    expect(apiMocks.listConversations).toHaveBeenCalledWith(WS);
    expect(useConversationStore().activeConversationId).toBe(NEW_CONV);
    expect(useChatStore().activeConversationId).toBe(NEW_CONV);
    // 新对话的现场与问题清单也现拉了一遍（切过去看到的是它自己的那一屏）
    expect(apiMocks.getChatState).toHaveBeenCalledWith(WS, NEW_CONV);
    expect(apiMocks.listQuestions).toHaveBeenCalledWith(NEW_CONV);
    // 两句说明：迁移完成 + 新助手会先读交接文档
    expect(messageMocks.info.mock.calls.map((call) => call[0])).toEqual([
      "任务迁移完成，已开启新会话",
      "新助手会先读取交接文档",
    ]);
  });

  it("作答失败：错误抛给调用方（界面据此说一句话），题还在面板上", async () => {
    apiMocks.answerQuestion.mockRejectedValue(new Error("这段对话不存在"));

    await expect(useChatStore().answerQuestion("q1", "handoff_self")).rejects.toThrow("这段对话不存在");

    expect(useChatStore().pendingQuestions.map((item) => item.id)).toEqual(["q1"]);
  });

  it("作答成功但切不过去：说的是「没切到新会话」，不是「没提交」", async () => {
    apiMocks.answerQuestion.mockResolvedValue({
      question: handoffQuestion({ state: "answered", blocking: false }),
      effects: { handoffStarted: true, newConversationId: NEW_CONV },
    });
    // 新对话的现场拉不下来（连接在这中间断了这类）
    apiMocks.getChatState.mockImplementation((_ws: string, id: string) =>
      id === NEW_CONV ? Promise.reject(new Error("连接已断开")) : Promise.resolve(idleState(id)),
    );

    // 作答本身不抛：它在宿主那边已经成功了，失败的只是「切过去」那一步
    await expect(useChatStore().answerQuestion("q1", "handoff_self")).resolves.toBeUndefined();

    expect(messageMocks.error.mock.calls.map((call) => call[0])).toEqual([
      "作答已提交，但没能切到新会话：连接已断开",
    ]);
    // 作答那份事实没丢：原对话的槽位里题已经是 answered（切回去不会再挡着输入区）
    expect(
      useChatStore().byConversation[CONV]?.questions.map((item) => item.state),
    ).toEqual(["answered"]);
  });
});
