/**
 * `stores/connection.ts` 的用例：面板上那两个按钮（测试连接 / 保存并重连）到底做了什么。
 *
 * 这一批没有组件测试（本仓只有 store 测试，见 `agentView.test.ts` 的口径），所以「面板的行为」
 * 全部落在 store 的三条 action 上，这里逐个咬住：
 *   - `load` 把 main 的配置读上来；
 *   - `test` **只探测**：结果进 `probe`，不落盘、不动界面上的服务端数据；
 *   - `save` **换连接**：state 换成 main 返回的那份，并把来自服务端的数据全部重拉；
 *   - `save` 失败：`saving` 放下、`settings` 一个字段都不改（不允许界面显示「已保存」）；
 *   - `resetProbe` 清空。
 *
 * 另一组是**连接状态**（`state` / `startWatching` / `reconnect` / `isReady`）—— 界面靠它决定
 * 「现在该不该说话」（窗口先出来、连接在后面，D25 / D26）。那几条的重点全在**顺序**上：
 * 起始态 main 不推，所以必须**先查一次再订阅**。
 *
 * 换掉的东西只有两处：`apis/connection`（用 `vi.mock`，不打真 IPC）与
 * `window.electronAPI`（一份假服务端 + 一对假的 `on` / `off`）。`ui` / `workspace` /
 * `conversation` 三个 store 用的是**真件** —— 「保存后到底刷新了什么」必须是可断言的，
 * 而不是一句被 mock 掉的空话。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import type {
  AgentOption,
  ConnectionState,
  ConversationSummary,
  ModelOption,
  Workspace,
} from "@ai-zen/desktop-shared";
import { useConnectionStore } from "./connection.js";
import { useConversationStore } from "./conversation.js";
import { useUiStore } from "./ui.js";
import { useWorkspaceStore } from "./workspace.js";

/** `apis/connection` 的入口（`vi.mock` 的工厂会被提升，所以用 `vi.hoisted` 拿变量） */
const mocks = vi.hoisted(() => ({
  getConnectionSettings: vi.fn(),
  saveConnectionSettings: vi.fn(),
  testConnection: vi.fn(),
  getConnectionState: vi.fn(),
  reconnectConnection: vi.fn(),
  onConnectionState: vi.fn(),
}));

vi.mock("../apis/connection.js", () => ({
  getConnectionSettings: mocks.getConnectionSettings,
  saveConnectionSettings: mocks.saveConnectionSettings,
  testConnection: mocks.testConnection,
  getConnectionState: mocks.getConnectionState,
  reconnectConnection: mocks.reconnectConnection,
  onConnectionState: mocks.onConnectionState,
}));

// 「新服务端」端上有什么：换连接之后界面显示的必须是这一份，而不是上一台留下的
const REMOTE_AGENTS: AgentOption[] = [{ id: "agent-b", name: "远端 Agent" }];
const REMOTE_MODELS: ModelOption[] = [{ id: "model-b", name: "远端模型" }];
const REMOTE_WORKSPACES: Workspace[] = [{ id: "ws-new", name: "远端工作区", cwd: "/tmp/remote" }];

/** 上一台的会话（保存前界面上挂着的东西） */
const OLD_CONVERSATION: ConversationSummary = {
  id: "conv-old",
  workspaceId: "ws-old",
  agentId: "agent-a",
  modelId: "model-a",
  name: "上一台的会话",
  messageCount: 3,
  updatedAt: "2024-01-01T00:00:00.000Z",
};

let invokeService: ReturnType<typeof vi.fn>;

/** 假的推送通道：`window.electronAPI.on` 往里登记，`pushState()` 往里发 */
type ChannelListener = (payload: unknown) => void;
/** `window.electronAPI` 上那对通用监听（preload 是 `ipcRenderer.on` / `removeListener` 的一层薄封装） */
type ChannelFn = (channel: string, callback: ChannelListener) => void;
let listeners: Record<string, ChannelListener[]> = {};
let onMock: Mock<ChannelFn>;
let offMock: Mock<ChannelFn>;

/** 模拟 main 推来一条连接状态（`webContents.send("connection:state", state)`） */
function pushState(state: ConnectionState): void {
  for (const listener of [...(listeners["connection:state"] ?? [])]) listener(state);
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();

  // 假服务端：只回答「联上来的是哪台」这件事（数据随服务端变，这正是换连接要重拉的原因）
  invokeService = vi.fn(async (service: string, method: string) => {
    if (service === "agent" && method === "list") return REMOTE_AGENTS;
    if (service === "model" && method === "list") return REMOTE_MODELS;
    if (service === "workspace" && method === "list") return REMOTE_WORKSPACES;
    if (service === "conversation" && method === "list") return [];
    return [];
  });

  // 假的事件通道：preload 那对 `on` / `off` 就是一层 `ipcRenderer` 的登记 / 注销，这里照抄
  listeners = {};
  onMock = vi.fn<ChannelFn>((channel, callback) => {
    (listeners[channel] ??= []).push(callback);
  });
  offMock = vi.fn<ChannelFn>((channel, callback) => {
    listeners[channel] = (listeners[channel] ?? []).filter((item) => item !== callback);
  });

  (globalThis as unknown as { window: unknown }).window = {
    electronAPI: { invokeService, on: onMock, off: offMock },
  };

  // 订阅助手由 `on` / `off` 拼出来（与 `apis/base.ts` 的写法同一口径），
  // 于是「推送真的送到了 store 里」是可断言的，而不是一句被 mock 掉的空话。
  mocks.onConnectionState.mockImplementation((callback: (state: ConnectionState) => void) => {
    // 与 `apis/base.ts` 的 `subscribeServiceEvent` 同一层包装：payload 由通道原样带过来
    const listener: ChannelListener = (payload) => callback(payload as ConnectionState);
    onMock("connection:state", listener);
    return () => offMock("connection:state", listener);
  });
});

describe("connection store · load", () => {
  it("① 把 main 上的配置放进 state（面板打开时显示的就是盘上那一份）", async () => {
    mocks.getConnectionSettings.mockResolvedValue({
      mode: "remote",
      serverUrl: "wss://a.example/ai-zen",
      serverToken: "token-1",
    });
    const store = useConnectionStore();

    await store.load();

    expect(mocks.getConnectionSettings).toHaveBeenCalledTimes(1);
    expect(store.settings).toEqual({
      mode: "remote",
      serverUrl: "wss://a.example/ai-zen",
      serverToken: "token-1",
    });
  });
});

describe("connection store · test", () => {
  it("② 成功 → probe 是 ok 那一支，protocol / version / elapsedMs 原样透出", async () => {
    mocks.testConnection.mockResolvedValue({
      ok: true,
      protocol: 3,
      version: "0.1.0-alpha.0",
      elapsedMs: 12,
    });
    const store = useConnectionStore();

    await store.test({ serverUrl: "wss://a.example/ai-zen", serverToken: "token-1" });

    expect(mocks.testConnection).toHaveBeenCalledWith({
      serverUrl: "wss://a.example/ai-zen",
      serverToken: "token-1",
    });
    expect(store.probe).toEqual({
      ok: true,
      protocol: 3,
      version: "0.1.0-alpha.0",
      elapsedMs: 12,
    });
    expect(store.testing).toBe(false);
  });

  it("② 失败 → probe 是 ok:false 那一支，message 就是给人看的那句话", async () => {
    mocks.testConnection.mockResolvedValue({
      ok: false,
      message: "凭证被拒绝：远端不接受这个 token",
    });
    const store = useConnectionStore();

    await store.test({ serverUrl: "wss://b.example/ai-zen" });

    expect(store.probe).toEqual({
      ok: false,
      message: "凭证被拒绝：远端不接受这个 token",
    });
    expect(store.testing).toBe(false);
  });

  it("② 再测一次会先清掉上一次的结果（不在「正在测」的那几秒里挂着旧结论）", async () => {
    let release: (probe: unknown) => void = () => {};
    mocks.testConnection.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const store = useConnectionStore();
    store.probe = { ok: true, protocol: 3, version: "0.1.0-alpha.0", elapsedMs: 12 };

    const pending = store.test({ serverUrl: "wss://c.example/ai-zen" });
    expect(store.probe).toBeNull();
    expect(store.testing).toBe(true);

    release({ ok: false, message: "连不上" });
    await pending;

    expect(store.probe).toEqual({ ok: false, message: "连不上" });
    expect(store.testing).toBe(false);
  });

  it("② 只探测：不落盘、也不刷新界面（当前会话与列表一动不动）", async () => {
    mocks.testConnection.mockResolvedValue({
      ok: true,
      protocol: 3,
      version: "0.1.0-alpha.0",
      elapsedMs: 12,
    });
    const store = useConnectionStore();
    const uiStore = useUiStore();
    const loadOptions = vi.spyOn(uiStore, "loadOptions");
    const workspaceLoad = vi.spyOn(useWorkspaceStore(), "load");
    const conversationStore = useConversationStore();
    conversationStore.activeConversationId = "conv-old";

    await store.test({ serverUrl: "wss://a.example/ai-zen" });

    expect(mocks.saveConnectionSettings).not.toHaveBeenCalled();
    expect(loadOptions).not.toHaveBeenCalled();
    expect(workspaceLoad).not.toHaveBeenCalled();
    expect(conversationStore.activeConversationId).toBe("conv-old");
  });
});

describe("connection store · save", () => {
  /** 造一份「保存前」的界面：还是上一台机器的数据，且正开着它的会话 */
  function primeWithOldServer(): void {
    const store = useConnectionStore();
    const uiStore = useUiStore();
    const workspaceStore = useWorkspaceStore();
    const conversationStore = useConversationStore();

    store.settings = { mode: "local" };
    uiStore.agents = [{ id: "agent-a", name: "本地 Agent" }];
    uiStore.models = [{ id: "model-a", name: "本地模型" }];
    workspaceStore.workspaces = [{ id: "ws-old", name: "旧工作区", cwd: "/tmp/old" }];
    workspaceStore.activeWorkspaceId = "ws-old";
    conversationStore.byWorkspace = { "ws-old": [OLD_CONVERSATION] };
    conversationStore.currentWorkspaceId = "ws-old";
    conversationStore.activeConversationId = "conv-old";
  }

  it("③ 成功 → state 换成 main 返回的那份，且界面上的服务端数据全部重拉", async () => {
    const next = { mode: "remote" as const, serverUrl: "wss://a.example/ai-zen" };
    mocks.saveConnectionSettings.mockResolvedValue({ settings: next });
    primeWithOldServer();

    const uiStore = useUiStore();
    const workspaceStore = useWorkspaceStore();
    const conversationStore = useConversationStore();
    const store = useConnectionStore();
    const loadOptions = vi.spyOn(uiStore, "loadOptions");
    const workspaceLoad = vi.spyOn(workspaceStore, "load");

    await store.save(next);

    // main 收到的是用户填的那一份（原样，不加不减）
    expect(mocks.saveConnectionSettings).toHaveBeenCalledWith(next);
    // state 用的是 main 回来的 `{ settings }`（不是本地那份乐观值）
    expect(store.settings).toEqual(next);
    expect(store.saving).toBe(false);

    // 刷新确实发生了（ui 选项 + 工作区/会话）
    expect(loadOptions).toHaveBeenCalledTimes(1);
    expect(workspaceLoad).toHaveBeenCalledTimes(1);

    // Agent / 模型 / 工作区换成了新服务端的那一份
    expect(uiStore.agents).toEqual(REMOTE_AGENTS);
    expect(uiStore.models).toEqual(REMOTE_MODELS);
    expect(workspaceStore.workspaces).toEqual(REMOTE_WORKSPACES);
    expect(workspaceStore.activeWorkspaceId).toBe("ws-new");

    // 会话列表真的重拉了；当前会话切回「无」；上一台的缓存不再占着位置
    expect(invokeService).toHaveBeenCalledWith("conversation", "list", "ws-new");
    expect(conversationStore.currentWorkspaceId).toBe("ws-new");
    expect(conversationStore.activeConversationId).toBe("");
    expect(conversationStore.byWorkspace["ws-old"]).toBeUndefined();
  });

  it("③ 保存成功后清掉旧的探测结果（它说的是换之前那条链路）", async () => {
    const next = { mode: "remote" as const, serverUrl: "wss://a.example/ai-zen" };
    mocks.saveConnectionSettings.mockResolvedValue({ settings: next });
    const store = useConnectionStore();
    store.probe = { ok: true, protocol: 3, version: "0.1.0-alpha.0", elapsedMs: 12 };

    await store.save(next);

    expect(store.probe).toBeNull();
  });

  it("④ 失败 → 抛回给界面、saving 放下、settings 一个字段都不改、也不刷新", async () => {
    mocks.saveConnectionSettings.mockRejectedValue(new Error("落盘失败：`connection.json` 写不进去"));
    primeWithOldServer();

    const uiStore = useUiStore();
    const workspaceStore = useWorkspaceStore();
    const conversationStore = useConversationStore();
    const store = useConnectionStore();
    store.settings = { mode: "local" };
    const loadOptions = vi.spyOn(uiStore, "loadOptions");
    const workspaceLoad = vi.spyOn(workspaceStore, "load");

    await expect(
      store.save({ mode: "remote", serverUrl: "wss://bad.example/ai-zen" }),
    ).rejects.toThrow("落盘失败");

    // 界面不许显示「已保存」：saving 必须放下
    expect(store.saving).toBe(false);
    // 配置也没被改坏（还是保存前 main 上那份）
    expect(store.settings).toEqual({ mode: "local" });
    // 连接没换，界面上的数据就还是上一台的那份，一次刷新都不该发生
    expect(loadOptions).not.toHaveBeenCalled();
    expect(workspaceLoad).not.toHaveBeenCalled();
    expect(uiStore.agents).toEqual([{ id: "agent-a", name: "本地 Agent" }]);
    expect(conversationStore.activeConversationId).toBe("conv-old");
  });
});

describe("connection store · resetProbe", () => {
  it("⑤ 清空探测结果", () => {
    const store = useConnectionStore();
    store.probe = { ok: false, message: "连不上" };

    store.resetProbe();

    expect(store.probe).toBeNull();
  });
});

// ==================== 连接状态（D23 / D26） ====================

/** 三态里各取一个样本（字段就是 shared 的 `ConnectionState`，这里只挑最典型的） */
const CONNECTING_FIRST: ConnectionState = { status: "connecting", label: "本机服务端", attempt: 0 };
const CONNECTING_RETRY: ConnectionState = {
  status: "connecting",
  label: "wss://a.example/ai-zen",
  attempt: 2,
  nextRetryInMs: 2000,
};
const READY: ConnectionState = {
  status: "ready",
  label: "本机服务端",
  protocol: 3,
  version: "0.1.0-alpha.0",
};
const ERROR: ConnectionState = {
  status: "error",
  label: "wss://a.example/ai-zen",
  message: "连不上（已重试 3 次仍未连上）",
};

describe("connection store · loadState", () => {
  it("⑥ 把 main 的状态放进 state（查一次当前值）", async () => {
    mocks.getConnectionState.mockResolvedValue(READY);
    const store = useConnectionStore();
    // 起始态：还没查到
    expect(store.state).toBeNull();

    await store.loadState();

    expect(mocks.getConnectionState).toHaveBeenCalledTimes(1);
    expect(store.state).toEqual(READY);
  });
});

describe("connection store · startWatching", () => {
  it("⑦ 先查一次再订阅（起始态 main 不推，先听再查会漏掉中间那次变化）", async () => {
    mocks.getConnectionState.mockResolvedValue(CONNECTING_FIRST);
    const store = useConnectionStore();

    const stop = await store.startWatching();

    // 两条都发生了，各恰好一次
    expect(mocks.getConnectionState).toHaveBeenCalledTimes(1);
    expect(mocks.onConnectionState).toHaveBeenCalledTimes(1);
    // **顺序**才是这条用例的重点：查询在前、订阅在后
    expect(mocks.getConnectionState.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.onConnectionState.mock.invocationCallOrder[0],
    );
    // 订阅落在与查询同名的通道上
    expect(onMock).toHaveBeenCalledWith("connection:state", expect.any(Function));
    // 查询的结果已经进 state（不是等推送才有东西）
    expect(store.state).toEqual(CONNECTING_FIRST);

    stop();
  });

  it("⑧ 推送到来时 state 被更新；取消订阅后不再更新", async () => {
    mocks.getConnectionState.mockResolvedValue(CONNECTING_FIRST);
    const store = useConnectionStore();
    const stop = await store.startWatching();

    // 重试等待中
    pushState(CONNECTING_RETRY);
    expect(store.state).toEqual(CONNECTING_RETRY);

    // 连上 / 连不上，推送说了算
    pushState(READY);
    expect(store.state).toEqual(READY);

    stop();
    expect(offMock).toHaveBeenCalledWith("connection:state", expect.any(Function));

    pushState(ERROR);
    expect(store.state).toEqual(READY);
    expect(mocks.getConnectionState).toHaveBeenCalledTimes(1);
  });
});

describe("connection store · reconnect", () => {
  it("⑨ 调 api，并把返回的那一刻状态放进 state（之后的变化靠推送）", async () => {
    mocks.reconnectConnection.mockResolvedValue(CONNECTING_FIRST);
    const store = useConnectionStore();
    store.state = ERROR;

    await store.reconnect();

    expect(mocks.reconnectConnection).toHaveBeenCalledTimes(1);
    // main 返回的是「进入 connecting 之后的那一瞬」：界面据此立刻从错误条切回转圈
    expect(store.state).toEqual(CONNECTING_FIRST);
    expect(store.reconnecting).toBe(false);
  });

  it("⑨ 重连之后推送继续更新 state（重试计数 / 最终结果都来自 main）", async () => {
    mocks.getConnectionState.mockResolvedValue(ERROR);
    mocks.reconnectConnection.mockResolvedValue(CONNECTING_FIRST);
    const store = useConnectionStore();
    const stop = await store.startWatching();

    await store.reconnect();
    expect(store.state).toEqual(CONNECTING_FIRST);

    pushState(CONNECTING_RETRY);
    expect(store.state).toEqual(CONNECTING_RETRY);

    pushState(READY);
    expect(store.state).toEqual(READY);

    stop();
  });

  it("⑨ 重连进行中 reconnecting 为 true、失败时照样放下（不把按钮留在转圈里）", async () => {
    let release: (state: ConnectionState) => void = () => {};
    mocks.reconnectConnection.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const store = useConnectionStore();

    const pending = store.reconnect();
    expect(store.reconnecting).toBe(true);

    release(CONNECTING_FIRST);
    await pending;
    expect(store.reconnecting).toBe(false);

    mocks.reconnectConnection.mockRejectedValue(new Error("IPC 挂了"));
    await expect(store.reconnect()).rejects.toThrow("IPC 挂了");
    expect(store.reconnecting).toBe(false);
  });
});

describe("connection store · isReady", () => {
  it("⑩ 只在 ready 时为 true（含 state === null 这个「还没查到」）", () => {
    const store = useConnectionStore();

    // 还没查到：不许当成「已就绪」（界面那时什么都还没开始拉）
    expect(store.state).toBeNull();
    expect(store.isReady).toBe(false);

    store.state = CONNECTING_FIRST;
    expect(store.isReady).toBe(false);

    store.state = CONNECTING_RETRY;
    expect(store.isReady).toBe(false);

    store.state = ERROR;
    expect(store.isReady).toBe(false);

    store.state = READY;
    expect(store.isReady).toBe(true);
  });
});
