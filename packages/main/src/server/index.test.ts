/**
 * `createServerLayer` 用例：**组装**这件事本身。
 *
 * 它不验握手、也不验拉起进程（那两件事在客户端库里，有自己的用例）。这里要钉的是本文件那二十行
 * 的判断：
 *
 *   · 有显式地址 ⇒ 递给 `ensureServer` 的是 `mode: "remote"`（**只连不拉起**那条路）；
 *   · 没有 ⇒ `mode: "local"`（发现文件 + 本机凭证 + 需要时拉起随包分发的那份）；
 *   · 握手回执里的协议版本是字符串，界面要的是数字（`helloOf` 那张映射）；
 *   · `dispose()` 之后 `manager` 不能再发请求（连接已经关了，不该还发得出去）；
 *   · `invokeService` 的六个键真的是 render 的调用面（转发到契约方法名上）。
 */

import type { Client, EnsureServerOptions, EnsureServerResult, ServerHelloResult } from "@ai-zen/agents-client";
import { describe, expect, it } from "vitest";
import type { ChatStreamEvent } from "@ai-zen/desktop-shared";
import { createServerLayer } from "./index.js";

const HELLO: ServerHelloResult = {
  language: "zh" as ServerHelloResult["language"],
  serverVersion: "0.1.0-alpha.0",
  protocolVersion: "1",
  startedAt: "2026-01-01T00:00:00.000Z",
  capabilities: ["F-C1"],
  limits: { maxAssetBytes: 20 * 1024 * 1024, maxAssetsPerMessage: 4 },
};

interface Harness {
  layer: ReturnType<typeof createServerLayer>;
  /** `ensureServer` 收到的入参 */
  ensureCalls: EnsureServerOptions[];
  /** 这一层发出去的契约调用 */
  calls: Array<{ method: string; params: unknown }>;
  /** 拉起服务端被调了几次 */
  spawns: () => number;
  /** 连接被关了吗 */
  closed: () => boolean;
  events: ChatStreamEvent[];
}

function harness(
  options: { serverUrl?: string; serverToken?: string; hello?: ServerHelloResult | null } = {},
): Harness {
  const ensureCalls: EnsureServerOptions[] = [];
  const calls: Array<{ method: string; params: unknown }> = [];
  const state = { spawns: 0, closed: false, events: [] as ChatStreamEvent[] };

  const client = {
    hello: options.hello === undefined ? HELLO : options.hello,
    call: async (method: string, params: unknown) => {
      calls.push({ method, params });
      if (method === "workspace.list") return { workspaces: [] };
      return {};
    },
    subscribe: () => () => {},
    onClose: () => () => {},
    onResume: () => () => {},
    resume: async (conversationId: string) => ({ conversationId }),
    track: () => {},
    untrack: () => {},
    reconnect: async () => {},
    close: async () => {
      state.closed = true;
    },
  } as unknown as Client;

  const layer = createServerLayer({
    aiZenDir: "/tmp/aiz-desktop-layer",
    clientInfo: { name: "@ai-zen/desktop", version: "0.0.0-test" },
    defaultCwd: () => "/home/user/Desktop",
    push: (event) => state.events.push(event),
    ...(options.serverUrl ? { serverUrl: options.serverUrl } : {}),
    ...(options.serverToken ? { serverToken: options.serverToken } : {}),
    spawnServer: async () => {
      state.spawns += 1;
    },
    log: () => {},
    // 换成假的：这一个动作才是真 I/O（读发现文件 / 拉起 / 握手），组装逻辑不该被它拖住
    ensure: async (ensureOptions: EnsureServerOptions): Promise<EnsureServerResult> => {
      ensureCalls.push(ensureOptions);
      return {
        client,
        target: { host: "127.0.0.1", port: 8790 },
        started: false,
        explicit: Boolean(ensureOptions.settings && ensureOptions.settings.mode === "remote"),
        dataRoot: ensureOptions.dataRoot ?? "",
      };
    },
  });

  return {
    layer,
    ensureCalls,
    calls,
    spawns: () => state.spawns,
    closed: () => state.closed,
    events: state.events,
  };
}

describe("组装：本地还是远程", () => {
  it("没有显式地址 ⇒ `mode: \"local\"`（发现文件 + 本机凭证；需要时拉起）", async () => {
    const h = harness();

    await h.layer.start();

    expect(h.ensureCalls).toHaveLength(1);
    expect(h.ensureCalls[0]?.settings).toEqual({ mode: "local" });
    // 数据根原样交下去（发现文件 <数据根>/run/server.json 就在它下面）
    expect(h.ensureCalls[0]?.dataRoot).toBe("/tmp/aiz-desktop-layer");
    // 服务端入口给的是随包分发的那份（不是从 node_modules 里现解析）
    expect(h.ensureCalls[0]?.serverEntry).toMatch(/server\.mjs$/);
  });

  it("有显式地址 ⇒ `mode: \"remote\"`（只连不拉起，那条路库里压根不会调 spawnServer）", async () => {
    const h = harness({ serverUrl: "wss://ai-zen.example.com/ai-zen", serverToken: "tok" });

    await h.layer.start();

    expect(h.ensureCalls[0]?.settings).toEqual({
      mode: "remote",
      url: "wss://ai-zen.example.com/ai-zen",
      token: "tok",
    });
    // 组装层一次都没拉：显式地址这条路由 `ensureServer` 保证
    expect(h.spawns()).toBe(0);
  });

  it("显式地址但没给凭证：不塞一个空串进去（空串在库里是「显式给了个空值」）", async () => {
    const h = harness({ serverUrl: "wss://ai-zen.example.com/ai-zen" });

    await h.layer.start();

    expect(h.ensureCalls[0]?.settings).toEqual({
      mode: "remote",
      url: "wss://ai-zen.example.com/ai-zen",
    });
  });
});

describe("握手回执 → ready 里那两位", () => {
  it("协议版本是字符串 \"1\"，界面要数字 1；版本串原样", async () => {
    const h = harness();
    await h.layer.start();

    expect(h.layer.hello()).toEqual({ protocol: 1, version: "0.1.0-alpha.0" });
  });

  it("拿不到握手身份时是 `null`（连上了但不知道哪一版，比编一个数字诚实）", async () => {
    const h = harness({ hello: null });
    await h.layer.start();

    expect(h.layer.hello()).toBeNull();
  });
});

describe("IPC 转发", () => {
  it("`invokeService('workspace','list')` 打到契约的 `workspace.list` 上", async () => {
    const h = harness();
    await h.layer.start();

    const result = await h.layer.manager.invokeService("workspace", "list");

    expect(result).toEqual([]);
    expect(h.calls[0]).toEqual({ method: "workspace.list", params: {} });
  });

  it("还没连上时发请求：抛一句能看懂的错（不是发到一条不存在的连接上）", async () => {
    const h = harness();

    await expect(h.layer.manager.invokeService("workspace", "list")).rejects.toThrow(/还没连上服务端/);
    expect(h.calls).toEqual([]);
  });

  it("未知服务 / 未知方法：报出具体的键名（静默返回 undefined 只会更难查）", async () => {
    const h = harness();
    await h.layer.start();

    await expect(h.layer.manager.invokeService("nope", "list")).rejects.toThrow(/未知服务: nope/);
    await expect(h.layer.manager.invokeService("workspace", "nope")).rejects.toThrow(
      /服务 workspace 无方法: nope/,
    );
  });
});

describe("收摊", () => {
  it("dispose 之后连接被关掉，再发请求只能得到「还没连上」", async () => {
    const h = harness();
    await h.layer.start();

    h.layer.dispose();
    // `close()` 是异步的；`dispose` 只负责把它交出去
    await Promise.resolve();

    expect(h.closed()).toBe(true);
    expect(h.layer.hello()).toBeNull();
    await expect(h.layer.manager.invokeService("workspace", "list")).rejects.toThrow(/还没连上服务端/);
  });
});
