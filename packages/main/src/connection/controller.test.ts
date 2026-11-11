/**
 * `ConnectionController` 用例：**换层的顺序**（D18）与**试连的语义**（D19）。
 *
 * ## 为什么用假层 + 计数器，而不是真 daemon
 *
 * 「保存之后立刻重建连接」这件事的证据不是「连上了没有」，而是**旧层被怎么处理、新层什么时候
 * 被建**：旧层必须 `dispose()` 恰好一次（否则两台服务端的事件会一起推到 `chat:push`，消息串
 * 台），新层必须 `start()`（否则 `events.watch` 没订阅，界面安静地不动），而且**落盘失败时
 * 旧层一次都不许被 dispose**（否则界面显示远程、实际什么都没连着）。
 *
 * 这三个判据都只有「计数器 + 事件序列」能看见。真 daemon 反倒是噪声：它会让「旧层关没关」与
 * 「socket 断没断」混在一起。
 *
 * ## D18 的顺序怎么写进用例
 *
 * `harness()` 把四件事实按发生顺序记进 `trace`（`write` / `dispose` / `create` / `start`）：
 * 「先落盘 → 再 dispose 旧层 → 再建 → 再 start」于是就成了一条可以直接断言的字符串序列。
 * 另有一条用例让落盘失败，断言 `dispose` 一次都没被调用 —— 反向验证（把顺序倒过来）见交付
 * 报告：倒过来之后正是这条会红。
 *
 * ## 试连为什么要用真 daemon
 *
 * `test()` 里没有一行是本仓的协议实现：地址交给 `parseServerUrl`、凭证交给 `resolveToken`、
 * 握手交给 `SocketServerClient.connect`、报错交给 `explainUnauthorized`。把它换成假件，测出来
 * 的就是「我假装的握手」。所以这一组照 `test-harness.ts` 起一台真 daemon（真端口、真凭证、
 * 真协议版本 3）。
 */

import { resolveToken } from "@ai-zen/agents-client";
import type { ConnectionSettings } from "@ai-zen/desktop-shared";
import { afterEach, describe, expect, it } from "vitest";
import { startTestServer, type TestServer } from "../server/test-harness.js";
import type { ServerLayerOptions } from "../server/index.js";
import { ConnectionController, type ConnectionLayer } from "./controller.js";

/** 用户会填的那种地址（带子路径的 `wss://`：`parseServerUrl` 认得的四种之一） */
const REMOTE_URL = "wss://ai-zen.example.com/ai-zen";
/** 一眼能认出来的凭证：用它断言「日志里没有它」（D22） */
const TOKEN = "dGhpcy1pcy1hLXRva2VuLW5ldmVyLWxvZ2dlZA";

// ==================================================================
// 假层 + 记账（换层那一组）
// ==================================================================

/** 假层：被 start 几次、被 dispose 几次，以及「建它的时候收到了什么」 */
interface FakeLayer extends ConnectionLayer {
  /** `createLayer` 收到的入参（`local` 模式下 `serverUrl` / `serverToken` 必须是 `undefined`） */
  settings: ServerLayerOptions;
  starts: number;
  disposes: number;
}

interface Harness {
  controller: ConnectionController;
  /** 建过的层（按先后）；最后一个是「当前那层」 */
  layers: FakeLayer[];
  /** 「落盘 / dispose / 建 / start」的事件序列 —— D18 的顺序就是这条序列 */
  trace: string[];
  /** 成功落盘的那几份（按先后） */
  writes: ConnectionSettings[];
  /** 让**下一次**落盘失败（用例造一个「磁盘写不进去」） */
  failNextWrite: () => void;
  /** 日志（断言凭证没进去） */
  logs: string[];
}

/**
 * 一个可完全控盘的控制器：假层、内存里的「盘」、可控的写入失败。
 *
 * `readSettings` 返回的是内存变量（与真件的 `readSettings(aiZenDir)` 同签名），`writeSettings`
 * 先记一笔再决定成不成功 —— 「落盘失败」这件事在真盘上很难稳定复现（磁盘满、只读挂载），
 * 而它恰恰是 D18 那条顺序唯一能看见的边界。
 */
function harness(options: { settings?: ConnectionSettings } = {}): Harness {
  const layers: FakeLayer[] = [];
  const trace: string[] = [];
  const writes: ConnectionSettings[] = [];
  const logs: string[] = [];
  let stored: ConnectionSettings = options.settings ?? { mode: "local" };
  let failing = false;

  const controller = new ConnectionController({
    aiZenDir: "/tmp/aiz-desktop-controller",
    clientInfo: { name: "@ai-zen/desktop", version: "0.0.0-test" },
    defaultCwd: () => "/tmp",
    push: () => {},
    createLayer: (settings) => {
      trace.push("create");
      const layer: FakeLayer = {
        settings,
        starts: 0,
        disposes: 0,
        // 真件的 `manager` 就是 `ServicesManager`；这里只要形状对（IPC 转发那条路）
        manager: { invokeService: async (service, method) => `${service}.${method}` },
        start: async () => {
          layer.starts += 1;
          trace.push("start");
        },
        dispose: () => {
          layer.disposes += 1;
          trace.push("dispose");
        },
      };
      layers.push(layer);
      return layer;
    },
    readSettings: async () => stored,
    writeSettings: async (settings) => {
      trace.push("write");
      if (failing) throw new Error("磁盘写不进去（用例造的）");
      writes.push(settings);
      stored = settings;
    },
    log: (message) => {
      logs.push(message);
    },
  });

  return {
    controller,
    layers,
    trace,
    writes,
    logs,
    failNextWrite: () => {
      failing = true;
    },
  };
}

describe("保存设置：换层（D18）", () => {
  it("save 成功：旧层 dispose 恰好一次、新层 start 一次、layer() 是新层", async () => {
    const h = harness();
    await h.controller.start();
    const old = h.layers[0]!;
    expect(old.starts).toBe(1);

    const { settings } = await h.controller.save({ mode: "remote", serverUrl: REMOTE_URL });

    expect(settings).toEqual({ mode: "remote", serverUrl: REMOTE_URL });
    // 旧层收摊恰好一次（多一次 = 有人重复 dispose；零次 = 两条连接同时活着，事件会串台）
    expect(old.disposes).toBe(1);
    expect(h.layers).toHaveLength(2);
    const next = h.layers[1]!;
    expect(next.starts).toBe(1);
    // 之后每一次 IPC 都必须打到**新**层上，不能还指着旧的
    expect(h.controller.layer()).toBe(next);
  });

  it("顺序固定「先落盘 → dispose → 建 → start」", async () => {
    const h = harness();
    await h.controller.start();
    // 启动那一段：建 → start（没有落盘、也没有旧的可以 dispose）
    expect(h.trace).toEqual(["create", "start"]);

    await h.controller.save({ mode: "remote", serverUrl: REMOTE_URL });

    // 这条序列就是 D18 的原文：write 在最前，dispose 在 create/start 之前
    expect(h.trace.slice(2)).toEqual(["write", "dispose", "create", "start"]);
  });

  it("落盘失败：dispose 一次都不许被调用（连接一个字段都没动）", async () => {
    const h = harness();
    await h.controller.start();
    const old = h.layers[0]!;
    h.failNextWrite();

    await expect(
      h.controller.save({ mode: "remote", serverUrl: REMOTE_URL }),
    ).rejects.toThrow(/磁盘写不进去/);

    // 落盘失败 ⇒ 不许动连接：否则界面上写着「远程」，实际还连着本地那条
    expect(old.disposes).toBe(0);
    expect(old.starts).toBe(1);
    // 没有建第二层，当前连接还是原来那一层
    expect(h.layers).toHaveLength(1);
    expect(h.controller.layer()).toBe(old);
    // 也没有落盘成功的那一份
    expect(h.writes).toEqual([]);
  });

  it("非法 serverUrl：抛人话、不落盘、不动连接", async () => {
    const h = harness();
    await h.controller.start();
    const old = h.layers[0]!;

    await expect(
      h.controller.save({ mode: "remote", serverUrl: "这不是地址" }),
    ).rejects.toThrow(/不是合法的服务端地址/);

    // 校验在落盘之前：`trace` 里连 write 都不该出现
    expect(h.trace).toEqual(["create", "start"]);
    expect(h.writes).toEqual([]);
    expect(old.disposes).toBe(0);
    expect(h.controller.layer()).toBe(old);
  });

  it("local ↔ remote 来回切两次：每次都真的换层（绝不复用旧层）", async () => {
    const h = harness();
    await h.controller.start(); // 第 1 层：本地

    await h.controller.save({ mode: "remote", serverUrl: REMOTE_URL, serverToken: TOKEN }); // 第 2 层
    await h.controller.save({ mode: "local" }); // 第 3 层
    await h.controller.save({ mode: "remote", serverUrl: REMOTE_URL }); // 第 4 层

    expect(h.layers).toHaveLength(4);
    // 前 3 层各被 start 一次、dispose 恰好一次（越早的越早收摊，谁都没被落下）
    for (const layer of h.layers.slice(0, 3)) {
      expect(layer.starts).toBe(1);
      expect(layer.disposes).toBe(1);
    }
    // 最后一层连着、且没被关过
    const last = h.layers[3]!;
    expect(last.starts).toBe(1);
    expect(last.disposes).toBe(0);
    expect(h.controller.layer()).toBe(last);

    // 换层是**重建**，不是改字段：`local` 那一层的两个值必须是 `undefined`（不是空串）
    expect(h.layers[1]!.settings.serverUrl).toBe(REMOTE_URL);
    expect(h.layers[1]!.settings.serverToken).toBe(TOKEN);
    expect(h.layers[2]!.settings.serverUrl).toBeUndefined();
    expect(h.layers[2]!.settings.serverToken).toBeUndefined();
    // 同一份远程配置再来一次，仍然建的是**新**层
    expect(h.layers[3]!.settings.serverUrl).toBe(REMOTE_URL);
  });

  it("日志只说模式与地址，凭证一个字都不出现（D22）", async () => {
    const h = harness();
    await h.controller.start();

    await h.controller.save({ mode: "remote", serverUrl: REMOTE_URL, serverToken: TOKEN });

    const text = h.logs.join("\n");
    // 地址要说得出来（排查「我连的是谁」是第一条信息）
    expect(text).toContain(REMOTE_URL);
    // 凭证绝不进任何会被 `cat` / 贴进 issue 的东西
    expect(text).not.toContain(TOKEN);
  });

  it("dispose 之后 layer() 抛人话（不再持有任何连接）", async () => {
    const h = harness();
    await h.controller.start();
    const old = h.layers[0]!;

    h.controller.dispose();

    expect(old.disposes).toBe(1);
    expect(() => h.controller.layer()).toThrow(/连接尚未建立/);
  });
});

// ==================================================================
// 试连（真 daemon）
// ==================================================================

let server: TestServer | null = null;

afterEach(async () => {
  if (server) await server.stop();
  server = null;
});

/**
 * 一个**只做试连**的控制器：不建层、不落盘。
 *
 * 那两个注入项故意写成抛错：`test()` 一旦去建层或落盘，用例当场就红 —— D19 的「不落盘、不
 * 影响当前连接」因此在结构上被钉住，而不只是「我没在代码里看到」。
 */
function probeOnly(aiZenDir: string): ConnectionController {
  return new ConnectionController({
    aiZenDir,
    clientInfo: { name: "@ai-zen/desktop", version: "0.0.0-test" },
    defaultCwd: () => aiZenDir,
    push: () => {},
    createLayer: () => {
      throw new Error("测试连接不该建层");
    },
    readSettings: async () => ({ mode: "local" }),
    writeSettings: async () => {
      throw new Error("测试连接不该落盘");
    },
  });
}

/** 真 daemon 那条地址（`startTestServer()` 用 `port: 0`，端口在一次启动里是固定的） */
function addressOf(target: TestServer): string {
  return `ws://127.0.0.1:${target.daemon.port}`;
}

/** 服务端启动时写在 `<dir>/run/token` 里的那把钥匙（走客户端包那一个解析点） */
async function tokenOf(target: TestServer): Promise<string> {
  const { token } = await resolveToken({ aiZenDir: target.dir });
  if (!token) throw new Error("测试服务端没有落下凭证文件");
  return token;
}

describe("测试连接（connection:test，D19）", () => {
  it("地址 + 凭证都对：ok、协议版本是 3、版本串来自服务端自报", async () => {
    server = await startTestServer();

    const probe = await probeOnly(server.dir).test({
      serverUrl: addressOf(server),
      serverToken: await tokenOf(server),
    });

    expect(probe.ok).toBe(true);
    // 收窄给下面几条断言用（失败时上面那条已经红了，这里只是为了让 TS 认得出成功那一支）
    if (!probe.ok) throw new Error(`试连应当成功，却是：${probe.message}`);
    expect(probe.protocol).toBe(3);
    // 用例不写死版本号：它必须来自服务端 `hello` 的回执（`0.0.0-test` 是脚手架自报的那一个）
    expect(probe.version).toBe("0.0.0-test");
    expect(probe.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it("不填凭证：退回本机 <aiZenDir>/run/token 也能连上（D9 的本地兜底）", async () => {
    server = await startTestServer();

    // 候选值里**没有** token：这一次能进门只可能来自本机那份凭证文件
    const probe = await probeOnly(server.dir).test({ serverUrl: addressOf(server) });

    expect(probe.ok).toBe(true);
  });

  it("凭证不对：ok:false、message 是人话、且不抛", async () => {
    server = await startTestServer();

    const probe = await probeOnly(server.dir).test({
      serverUrl: addressOf(server),
      serverToken: "not-the-key-at-all",
    });

    expect(probe.ok).toBe(false);
    if (probe.ok) throw new Error("错凭证不该连上");
    // `unauthorized` 已被 `explainUnauthorized` 翻成对症的那句话（措辞只在客户端包一处）
    expect(probe.message).toMatch(/unauthorized/);
    expect(probe.message).toMatch(/凭证/);
    // 凭证串本身永不回显：这句话会被贴进 issue / 日志
    expect(probe.message).not.toContain("not-the-key-at-all");
  });

  it("非法地址：ok:false、不抛（连一次都不尝试）", async () => {
    const probe = await probeOnly("/tmp/aiz-desktop-probe").test({
      serverUrl: "这不是地址",
    });

    expect(probe.ok).toBe(false);
    if (probe.ok) throw new Error("非法地址不该连上");
    // 由客户端包的 `parseServerUrl` 给出的那一句（带原始串）
    expect(probe.message).toMatch(/不是合法的服务端地址/);
  });

  it("空地址：同样 ok:false、不抛（面板里刚清空就点了测试）", async () => {
    const probe = await probeOnly("/tmp/aiz-desktop-probe").test({ serverUrl: "" });

    expect(probe.ok).toBe(false);
    if (probe.ok) throw new Error("空地址不该连上");
    expect(probe.message).toMatch(/不是合法的服务端地址/);
  });

  it("试连不落盘、也不动当前连接", async () => {
    server = await startTestServer();
    const h = harness();
    await h.controller.start();
    const current = h.layers[0]!;
    // 试连之前先记下序列长度：之后这一段必须一点都没长（没有 write / dispose / create / start）
    const before = h.trace.length;

    const probe = await h.controller.test({
      serverUrl: addressOf(server),
      serverToken: await tokenOf(server),
    });

    expect(probe.ok).toBe(true);
    expect(h.trace.slice(before)).toEqual([]);
    expect(h.writes).toEqual([]);
    expect(h.layers).toHaveLength(1);
    expect(current.disposes).toBe(0);
    expect(h.controller.layer()).toBe(current);
  });
});
