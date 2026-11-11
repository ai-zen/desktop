/**
 * `conversation store` 的 `select()` 与 `create()`：**开一段会话是会发生的事，不是一句发射**。
 *
 * 这一条锁的是「失败能不能传到能说人话的那一层」：
 *
 *   - `select()` 以前是个同步函数，里面 `useChatStore().activate()` 的 promise 没人接。那条
 *     promise 会抛（会话在盘上已被删、连接断了），而抛出去之后什么都没发生 —— 界面上留下
 *     「左边选中了、右边空白」，那和「这段会话本来就没有消息」长得一模一样。
 *   - `create()` 以前顺手在末尾 `select()`，于是「建成了但打开失败」会被调用方一律说成
 *     「新建失败」，用户再点一次「创建」就多出一段重复的会话。现在建与开是两步，
 *     这里只验「create 不再偷偷打开」。
 *
 * 为什么敢在 node 环境里直接调 store：`stores/*.ts` 的模块级 import（element-plus / pinia /
 * apis）在 vitest 的 node 环境下能正常加载（apis 层对 `window.electronAPI` 是惰性访问）。
 * 唯一被换掉的是 `apis/index.js`（不打真 IPC），`chat` / `workspace` 两个 store 用**真件**
 * —— 被测条件恰恰是「conversation store 有没有把它俩接对」，mock 掉等于把条件也 mock 了。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import type { ConversationSummary } from "@ai-zen/desktop-shared";
import { useChatStore } from "./chat.js";
import { useConversationStore } from "./conversation.js";

/** `apis/index.js` 的入口（`vi.mock` 的工厂会被提升，所以用 `vi.hoisted` 拿变量） */
const apiMocks = vi.hoisted(() => ({
  listConversations: vi.fn(),
  createConversation: vi.fn(),
  removeConversation: vi.fn(),
  renameConversation: vi.fn(),
  setConversationModel: vi.fn(),
  getChatState: vi.fn(),
}));

// 只给本文件用得到的那几个键：模块是按命名空间用的（`api.xxx`），用不到的键留着 undefined
// 不会在 import 期炸，只会在真被调用时才炸 —— 而真被调用就说明这条用例测到了它不该测的路径。
vi.mock("../apis/index.js", () => ({
  listConversations: apiMocks.listConversations,
  createConversation: apiMocks.createConversation,
  removeConversation: apiMocks.removeConversation,
  renameConversation: apiMocks.renameConversation,
  setConversationModel: apiMocks.setConversationModel,
  getChatState: apiMocks.getChatState,
}));

const WS = "ws-1";
const CONV = "conv-1";

function summary(id: string): ConversationSummary {
  return {
    id,
    workspaceId: WS,
    agentId: "agent-1",
    modelId: "model-1",
    name: `会话 ${id}`,
    messageCount: 0,
    updatedAt: "2026-11-11T00:00:00.000Z",
  };
}

/** 永不 resolve 的 promise：用来把「等」这件事钉在某个确定的位置上 */
function pending<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
});

describe("select", () => {
  it("要等 chat store 把快照拿到才 resolve（activate 不再是没人接的 promise）", async () => {
    const state = pending<{ messages: []; streaming: boolean }>();
    apiMocks.getChatState.mockReturnValue(state.promise);

    const conversation = useConversationStore();
    const chat = useChatStore();

    let settled = false;
    const selecting = conversation.select(WS, CONV).then(() => {
      settled = true;
    });

    // 视角是**立刻**切过去的（用户点了就该当场高亮），等的只是消息
    expect(chat.activeConversationId).toBe(CONV);
    expect(conversation.activeConversationId).toBe(CONV);
    expect(conversation.currentWorkspaceId).toBe(WS);

    // 快照还没回来：select 不能提前 resolve
    await Promise.resolve();
    expect(settled).toBe(false);

    state.resolve({ messages: [], streaming: false });
    await selecting;
    expect(settled).toBe(true);
  });

  it("activate 失败时把错误抛给调用方，且选中态不回滚", async () => {
    apiMocks.getChatState.mockRejectedValue(new Error("连接已断开"));

    const conversation = useConversationStore();

    // 以前这条 rejection 没人接：`select()` 同步返回，界面只剩「选中了、空白」
    await expect(conversation.select(WS, CONV)).rejects.toThrow("连接已断开");

    // 选中态留在用户点的那一段：回滚等于替他换一段会话，而「没读出来」用一句话说更准
    expect(conversation.activeConversationId).toBe(CONV);
    expect(conversation.currentWorkspaceId).toBe(WS);
  });

  it('select(ws, "") 只是取消激活：一个请求都不发', async () => {
    const conversation = useConversationStore();
    const chat = useChatStore();
    chat.activeConversationId = CONV;

    await conversation.select(WS, "");

    expect(chat.activeConversationId).toBe("");
    expect(conversation.activeConversationId).toBe("");
    expect(apiMocks.getChatState).not.toHaveBeenCalled();
  });
});

describe("create", () => {
  it("只建 + 刷新列表，不顺手打开（打开是调用方的下一件事）", async () => {
    apiMocks.createConversation.mockResolvedValue({ id: CONV });
    apiMocks.listConversations.mockResolvedValue([summary(CONV)]);

    const conversation = useConversationStore();
    const created = await conversation.create(WS, "agent-1");

    expect(created).toEqual({ id: CONV });
    expect(conversation.listOf(WS).map((c) => c.id)).toEqual([CONV]);
    // 建好了不等于打开了：这一步要是偷偷 activate，调用方就没法把「建成了但打不开」单独说清
    expect(conversation.activeConversationId).toBe("");
    expect(apiMocks.getChatState).not.toHaveBeenCalled();
  });

  it("建失败时原样抛（调用方负责加「新建对话失败」这句主语）", async () => {
    apiMocks.createConversation.mockRejectedValue(new Error("工作空间不存在"));

    const conversation = useConversationStore();

    await expect(conversation.create(WS, "agent-1")).rejects.toThrow("工作空间不存在");
    expect(apiMocks.listConversations).not.toHaveBeenCalled();
  });
});

describe("load", () => {
  it("激活的会话不在新列表里就清空，且这一步不碰服务端", async () => {
    apiMocks.listConversations.mockResolvedValue([summary(CONV)]);

    const conversation = useConversationStore();
    conversation.activeConversationId = "gone";

    await conversation.load(WS);

    expect(conversation.activeConversationId).toBe("");
    expect(conversation.currentWorkspaceId).toBe(WS);
    // 清空走的是 deactivate（同步），不是「去打开一个空 id」
    expect(apiMocks.getChatState).not.toHaveBeenCalled();
  });

  it("激活的会话还在列表里就保持选中", async () => {
    apiMocks.listConversations.mockResolvedValue([summary(CONV)]);

    const conversation = useConversationStore();
    conversation.activeConversationId = CONV;

    await conversation.load(WS);

    expect(conversation.activeConversationId).toBe(CONV);
    expect(apiMocks.getChatState).not.toHaveBeenCalled();
  });
});
