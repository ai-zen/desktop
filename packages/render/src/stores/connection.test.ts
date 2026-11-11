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
 * 换掉的东西只有两处：`apis/connection`（用 `vi.mock`，不打真 IPC）与
 * `window.electronAPI.invokeService`（一份假服务端）。`ui` / `workspace` / `conversation`
 * 三个 store 用的是**真件** —— 「保存后到底刷新了什么」必须是可断言的，而不是一句被 mock 掉的空话。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import type { AgentOption, ConversationSummary, ModelOption, Workspace } from "@ai-zen/desktop-shared";
import { useConnectionStore } from "./connection.js";
import { useConversationStore } from "./conversation.js";
import { useUiStore } from "./ui.js";
import { useWorkspaceStore } from "./workspace.js";

/** `apis/connection` 的三个入口（`vi.mock` 的工厂会被提升，所以用 `vi.hoisted` 拿变量） */
const mocks = vi.hoisted(() => ({
  getConnectionSettings: vi.fn(),
  saveConnectionSettings: vi.fn(),
  testConnection: vi.fn(),
}));

vi.mock("../apis/connection.js", () => ({
  getConnectionSettings: mocks.getConnectionSettings,
  saveConnectionSettings: mocks.saveConnectionSettings,
  testConnection: mocks.testConnection,
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
  (globalThis as unknown as { window: unknown }).window = {
    electronAPI: { invokeService },
  };
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
