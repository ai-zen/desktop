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
import type { ConnectionSettings, ConnectionState } from "@ai-zen/desktop-shared";
import { afterEach, describe, expect, it } from "vitest";
import { startTestServer, type TestServer } from "../server/test-harness.js";
import type { ServerLayerOptions } from "../server/index.js";
import {
  ConnectionController,
  type ConnectionLayer,
  type TimerScheduler,
} from "./controller.js";

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

/** 一次尝试要怎么收场（用例按先后排好，排完了一律成功） */
type StartResult = "ok" | "fail";

/**
 * 手搓的计时器：用例自己决定「1 秒到了」，不碰 `vi.useFakeTimers()`。
 *
 * 假时间会把 `Promise` 的微任务一起接管，而这条状态机每一步都是**真 async**（每次尝试都要
 * 等一个真 promise 落定）—— 假时间一开，「等它落定」在用例里就没法写了。所以时间从外面递进
 * 控制器（`scheduler` 注入项，见 `controller.ts` 文件头），用例按号点。
 */
interface ManualTimers {
  scheduler: TimerScheduler;
  /** 还挂着的计时器延迟（按设置先后）；空数组 = 没有重试在等 */
  pending: () => number[];
  /** 挂着的计时器（拷贝：留着一会儿再点，用来验「迟到的回调也不许建层」） */
  list: () => Array<{ delayMs: number; run: () => void }>;
  /** 让最早的那个计时器到点（返回它的延迟，供断言） */
  fireNext: () => number;
}

function manualTimers(): ManualTimers {
  let seq = 0;
  const pending: Array<{ id: number; delayMs: number; run: () => void }> = [];

  return {
    // `satisfies` 而不是注解：这里要的正是「句柄是 unknown」这个宽口径（生产给 Timeout，用例给编号）
    scheduler: {
      set: (run: () => void, delayMs: number) => {
        seq += 1;
        pending.push({ id: seq, delayMs, run });
        return seq;
      },
      clear: (handle: unknown) => {
        const index = pending.findIndex((item) => item.id === handle);
        if (index >= 0) pending.splice(index, 1);
      },
    } satisfies TimerScheduler,
    pending: () => pending.map((item) => item.delayMs),
    list: () => pending.map((item) => ({ delayMs: item.delayMs, run: item.run })),
    fireNext: () => {
      const timer = pending.shift();
      if (!timer) throw new Error("没有挂起的计时器");
      timer.run();
      return timer.delayMs;
    },
  };
}

/**
 * 让挂起的异步链跑完（状态机每一步都是真 async：`layer.start()` 是一个真 promise）。
 *
 * 只推微任务不够稳：`swap` / `launch` 之间隔着几层 `await`，再给一个宏任务槽，链一定走完。
 */
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
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
  /** `onStateChange` 收到的推送（按先后）—— D23 / D24 的判据就是这个序列 */
  states: ConnectionState[];
  /** 手搓的计时器 */
  timers: ManualTimers;
  /** 安排接下来几次尝试的结果（排完了一律成功） */
  planStarts: (results: StartResult[]) => void;
  /** 让**下一个** `layer.start()` 挂住不落定；返回「放行」函数（D27 的竞态要靠它） */
  holdNextStart: () => () => void;
}

/**
 * 一个可完全控盘的控制器：假层、内存里的「盘」、可控的写入失败、可控的失败顺序、可控的时间。
 *
 * `readSettings` 返回的是内存变量（与真件的 `readSettings(aiZenDir)` 同签名），`writeSettings`
 * 先记一笔再决定成不成功 —— 「落盘失败」这件事在真盘上很难稳定复现（磁盘满、只读挂载），
 * 而它恰恰是 D18 那条顺序唯一能看见的边界。
 *
 * `hello` 缺省给一份固定的（真件来自握手回执，见 `server/index.ts` 的 `readHello`）；
 * `hello: false` 用来验「拿不到身份时填 0 / 空串」那条分支。
 */
function harness(options: { settings?: ConnectionSettings | null; hello?: boolean } = {}): Harness {
  const layers: FakeLayer[] = [];
  const trace: string[] = [];
  const writes: ConnectionSettings[] = [];
  const logs: string[] = [];
  const states: ConnectionState[] = [];
  const timers = manualTimers();
  // `null` = **没配过**（首启）；`undefined` = 用例没指定，给一个「已配过本地」的底
  let stored: ConnectionSettings | null =
    options.settings === null ? null : (options.settings ?? { mode: "local" });
  let failing = false;
  let plan: StartResult[] = [];
  let gate: { promise: Promise<void>; release: () => void } | null = null;

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
        ...(options.hello === false
          ? {}
          : { hello: () => ({ protocol: 3, version: "0.0.0-test" }) }),
        start: async () => {
          layer.starts += 1;
          trace.push("start");
          const waiting = gate;
          gate = null;
          if (waiting) await waiting.promise;
          if (plan.shift() === "fail") {
            trace.push("start:fail");
            throw new Error("连不上（用例造的）");
          }
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
    onStateChange: (state) => {
      states.push(state);
    },
    scheduler: timers.scheduler,
  });

  return {
    controller,
    layers,
    trace,
    writes,
    logs,
    states,
    timers,
    failNextWrite: () => {
      failing = true;
    },
    planStarts: (results) => {
      plan = [...results];
    },
    holdNextStart: () => {
      let release!: () => void;
      const promise = new Promise<void>((resolve) => {
        release = resolve;
      });
      gate = { promise, release };
      return release;
    },
  };
}

/**
 * 取状态的 `label`（四态里只有三态有它）。
 *
 * `unset` 没有 label —— 它是「还没选」而不是「正在连某台」，硬给它一个词只会让界面多一处
 * 需要解释的东西。用例里要断 label 就过这个助手，窄化一次就够。
 */
function labelOfState(state: ConnectionState): string | undefined {
  return "label" in state ? state.label : undefined;
}

describe("没配过（unset）：不猜默认值，把选择权交回用户", () => {
  it("start() 不建层、不连、也不推（起始态与 state() 一致）", async () => {
    const h = harness({ settings: null });
    await h.controller.start();

    // 一层都没建：没配过就不该握任何手
    expect(h.layers).toHaveLength(0);
    expect(h.states).toEqual([]);
    expect(await h.controller.state()).toEqual({ status: "unset" });
  });

  it("start() **之前**问 state() 也是 unset（窗口比连接先出来）", async () => {
    const h = harness({ settings: null });
    expect(await h.controller.state()).toEqual({ status: "unset" });
  });

  it("get() 给的是**表单默认值**（local），不是「盘上有这一份」", async () => {
    const h = harness({ settings: null });
    expect(await h.controller.get()).toEqual({ mode: "local" });
  });

  it("reconnect() 在没配过时回到 unset，不发一轮空尝试", async () => {
    const h = harness({ settings: null });
    await h.controller.start();
    expect(await h.controller.reconnect()).toEqual({ status: "unset" });
    expect(h.layers).toHaveLength(0);
  });

  it("首启后在面板上存一次 → 从 unset 变成 connected（用户真的选了）", async () => {
    const h = harness({ settings: null });
    await h.controller.start();

    await h.controller.save({ mode: "local" });
    expect(h.writes).toEqual([{ mode: "local" }]);
    expect(h.layers).toHaveLength(1);
    expect(h.states.at(-1)!.status).toBe("ready");
  });
});

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

// ==================================================================
// 连接状态机（D23）+ 有限重试（D24）
// ==================================================================

/**
 * 这一组全部用假层 + 手搓计时器：状态机的判据是**状态序列**与**建了几层**，两者都只有
 * 「计数器 + 一条推送序列」能看见。真 daemon 反倒验不了「第 2 次重试成功」—— 它不会配合
 * 你失败两次。
 */
describe("连接状态机（D23）：三态的推送序列", () => {
  it("首次就成功：只推一条 ready（带服务端自报的协议版本与版本串）", async () => {
    const h = harness();

    await h.controller.start();

    // 起始态（connecting / attempt 0）不推：它就是 `state()` 在此之前给出的那一份
    expect(h.states).toEqual([
      { status: "ready", label: "本机服务端", protocol: 3, version: "0.0.0-test" },
    ]);
    expect(await h.controller.state()).toEqual(h.states[0]);
  });

  it("拿不到服务端身份时：ready 里填 0 / 空串（连上了但不知道哪一版）", async () => {
    const h = harness({ hello: false });

    await h.controller.start();

    expect(h.states).toEqual([
      { status: "ready", label: "本机服务端", protocol: 0, version: "" },
    ]);
  });

  it("首次失败 → 三次退避重试 → error：每一步的状态都推出来", async () => {
    const h = harness();
    h.planStarts(["fail", "fail", "fail", "fail"]);

    await h.controller.start(); // 第 1 次尝试失败 → 等 1s

    expect(h.states).toEqual([
      { status: "connecting", label: "本机服务端", attempt: 1, nextRetryInMs: 1000 },
    ]);
    expect(h.timers.pending()).toEqual([1000]);

    expect(h.timers.fireNext()).toBe(1000);
    await flush();
    expect(h.states[1]).toEqual({
      status: "connecting",
      label: "本机服务端",
      attempt: 2,
      nextRetryInMs: 2000,
    });
    expect(h.timers.pending()).toEqual([2000]);

    expect(h.timers.fireNext()).toBe(2000);
    await flush();
    expect(h.states[2]).toEqual({
      status: "connecting",
      label: "本机服务端",
      attempt: 3,
      nextRetryInMs: 5000,
    });
    expect(h.timers.pending()).toEqual([5000]);

    expect(h.timers.fireNext()).toBe(5000);
    await flush();

    // 三次重试用完：终态 error（带人话 message），且不再排计时器
    expect(h.states).toHaveLength(4);
    const last = h.states[3]!;
    expect(last.status).toBe("error");
    if (last.status !== "error") throw new Error("第四次失败之后应当是 error");
    expect(last.label).toBe("本机服务端");
    expect(last.message).toContain("连不上（用例造的）");
    expect(last.message).toContain("已重试 3 次");
    expect(h.timers.pending()).toEqual([]);
    // 一共 1 + 3 次尝试，每一次都建了一层（重试不是「再 start 一次」，见 D24）
    expect(h.layers).toHaveLength(4);
  });

  it("第 2 次重试成功：最终 ready，且每次都重建（3 层，前两层各 dispose 一次）", async () => {
    const h = harness();
    h.planStarts(["fail", "fail"]);

    await h.controller.start();
    h.timers.fireNext();
    await flush();
    h.timers.fireNext();
    await flush();

    expect(h.states.at(-1)).toEqual({
      status: "ready",
      label: "本机服务端",
      protocol: 3,
      version: "0.0.0-test",
    });
    // 每次尝试都是一层新的：第 3 层连上，前两层都收摊了
    expect(h.layers).toHaveLength(3);
    expect(h.layers[0]!.disposes).toBe(1);
    expect(h.layers[1]!.disposes).toBe(1);
    expect(h.layers[2]!.disposes).toBe(0);
    expect(h.layers[2]!.starts).toBe(1);
    expect(h.controller.layer()).toBe(h.layers[2]);
    expect(h.timers.pending()).toEqual([]);
  });

  it("dispose() 之后：计时器被清掉，迟到的回调也不许再建层", async () => {
    const h = harness();
    h.planStarts(["fail"]);
    await h.controller.start();
    expect(h.timers.pending()).toEqual([1000]);

    // 留一份旧回调（模拟「某处漏了 clear」时它还是被点了起来）
    const scheduled = h.timers.list();
    const before = h.layers.length;

    h.controller.dispose();

    // 收摊必须清掉挂起的计时器：进程要退了，一个还挂着的 setTimeout 会把事件循环撑着
    expect(h.timers.pending()).toEqual([]);

    scheduled[0]!.run();
    await flush();
    // 换代之后迟到的回调连层都不许碰（否则会拿旧配置把刚收摊的连接又建回来）
    expect(h.layers).toHaveLength(before);
  });

  it("reconnect()：从 error 回到 connecting(attempt 0)，attempt 归零后重新数", async () => {
    const h = harness();
    h.planStarts(["fail", "fail", "fail", "fail", "fail"]);
    await h.controller.start();
    h.timers.fireNext();
    await flush();
    h.timers.fireNext();
    await flush();
    h.timers.fireNext();
    await flush();
    expect(h.states.at(-1)?.status).toBe("error");
    const layersBefore = h.layers.length;

    const state = await h.controller.reconnect();

    // 立刻回到「首次尝试中」：attempt 归零，不是接着上一次的 4 数下去
    expect(state).toEqual({ status: "connecting", label: "本机服务端", attempt: 0 });
    // 这一条必须**推**出去（`error` 是终态，用户点了「重连」得立刻看到它在动）。
    // 断言「在这一串里」而不是「最后一条」：这一轮的重试就在后台跑着，它可能已经抢先落了一步
    expect(h.states).toContainEqual(state);

    await flush();
    // 这一轮自己的退避是从 1000 重新开始的（第 1 次重试）
    expect(h.states.at(-1)).toEqual({
      status: "connecting",
      label: "本机服务端",
      attempt: 1,
      nextRetryInMs: 1000,
    });
    expect(h.timers.pending()).toEqual([1000]);
    // 而且真的又试了一层
    expect(h.layers.length).toBe(layersBefore + 1);
  });

  it("reconnect() 取消挂起的计时器：旧那一轮的重试不会再把连接拽回旧配置", async () => {
    const h = harness();
    h.planStarts(["fail", "fail"]);
    await h.controller.start();
    expect(h.timers.pending()).toEqual([1000]);
    // 留一份旧那一轮的计时器（验「迟到的回调」）
    const stale = h.timers.list();

    const state = await h.controller.reconnect();
    expect(state).toEqual({ status: "connecting", label: "本机服务端", attempt: 0 });
    await flush();

    // 新一轮自己失败了，于是自己排了一个 1000ms（不是旧那个被留下来的）
    expect(h.states.at(-1)).toEqual({
      status: "connecting",
      label: "本机服务端",
      attempt: 1,
      nextRetryInMs: 1000,
    });
    expect(h.timers.pending()).toEqual([1000]);

    const before = h.layers.length;
    stale[0]!.run();
    await flush();
    // 旧那一次的计时器即便被点起来，也不许再建层（换代了）
    expect(h.layers).toHaveLength(before);
  });

  it("start() 之前查状态：connecting(0)，label 按盘上那份配置算（窗口比连接先出来）", async () => {
    const h = harness({ settings: { mode: "remote", serverUrl: REMOTE_URL } });

    expect(await h.controller.state()).toEqual({
      status: "connecting",
      label: REMOTE_URL,
      attempt: 0,
    });
    // 查询不推东西：状态没变过，推一遍只是噪声
    expect(h.states).toEqual([]);
  });
});

describe("state 的 label（D23）与凭证（D22）", () => {
  it("本地是本机服务端、远程是那个地址；label 与日志都不含凭证", async () => {
    const h = harness();
    await h.controller.start();
    expect(h.states.at(-1)!.status).toBe("ready");
    expect(labelOfState(h.states.at(-1)!)).toBe("本机服务端");

    await h.controller.save({ mode: "remote", serverUrl: REMOTE_URL, serverToken: TOKEN });

    const remote = h.states.at(-1)!;
    expect(remote.status).toBe("ready");
    // 地址要原样显示（render 不自己拼地址，也不猜模式）
    expect(labelOfState(remote)).toBe(REMOTE_URL);
    expect(labelOfState(remote)).not.toContain(TOKEN);
    expect(h.logs.join("\n")).not.toContain(TOKEN);

    // 失败那一支同样：`message` 会被推到界面上、也会进日志，它同样不许带凭证
    h.planStarts(["fail"]);
    await h.controller
      .save({ mode: "remote", serverUrl: REMOTE_URL, serverToken: TOKEN })
      .catch(() => {});
    const pushed = JSON.stringify(h.states);
    expect(pushed).not.toContain(TOKEN);
    expect(h.logs.join("\n")).not.toContain(TOKEN);
  });

  it("地址里带 userinfo（wss://user:secret@host）也不许进 label 与日志", async () => {
    const h = harness();

    await h.controller.save({
      mode: "remote",
      serverUrl: "wss://user:secret@ai-zen.example.com/ai-zen",
    });

    const state = await h.controller.state();
    // 地址照显示，但 userinfo 那一截（写在这里的钥匙）必须消失
    expect(labelOfState(state)).toBe("wss://ai-zen.example.com/ai-zen");
    expect(labelOfState(state)).not.toContain("secret");
    expect(h.logs.join("\n")).not.toContain("secret");
  });
});

// ==================================================================
// 竞态与「已保存但连不上」（D27）
// ==================================================================

describe("保存与重试的竞态（D27）", () => {
  it("start() 还在飞时 save()：先等它落定，再换层", async () => {
    const h = harness();
    const release = h.holdNextStart();

    const starting = h.controller.start();
    await flush();
    expect(h.layers).toHaveLength(1);

    const saving = h.controller.save({ mode: "remote", serverUrl: REMOTE_URL });
    await flush();

    // 第一轮还挂着：save 一步都不许走（没落盘、没换层）——
    // 否则两条尝试会抢同一层，先建的那条谁也 dispose 不了
    expect(h.writes).toEqual([]);
    expect(h.layers).toHaveLength(1);
    expect(h.trace).toEqual(["create", "start"]);

    release();
    await starting;
    await saving;

    // 落定之后才换层：write 在 dispose / create 之前（D18 的顺序照旧）
    expect(h.writes).toEqual([{ mode: "remote", serverUrl: REMOTE_URL }]);
    expect(h.layers).toHaveLength(2);
    expect(h.trace).toEqual(["create", "start", "write", "dispose", "create", "start"]);
  });

  it("save() 取消挂起的重试计时器：换完层它不会再去连旧配置", async () => {
    const h = harness();
    h.planStarts(["fail"]); // 首次失败 → 进入 1000ms 的重试等待
    await h.controller.start();
    expect(h.timers.pending()).toEqual([1000]);
    const scheduled = h.timers.list();

    await h.controller.save({ mode: "remote", serverUrl: REMOTE_URL });

    // 计时器被清掉（否则到点它会拿着**旧配置**再连一次）
    expect(h.timers.pending()).toEqual([]);
    expect(h.layers).toHaveLength(2);
    expect(h.layers[0]!.disposes).toBe(1);
    expect(h.layers[1]!.settings.serverUrl).toBe(REMOTE_URL);

    // 哪怕那个旧回调还是被点起来了，也不许再建第三层（换代了）
    scheduled[0]!.run();
    await flush();
    expect(h.layers).toHaveLength(2);
  });

  it("save() 落盘成功但连不上：说清「已保存 + 连不上」，状态是 connecting（不是 error）", async () => {
    const h = harness();
    await h.controller.start(); // 先连上（ready）
    h.planStarts(["fail"]); // 换过去的那一份连不上

    const error: unknown = await h.controller
      .save({ mode: "remote", serverUrl: REMOTE_URL, serverToken: TOKEN })
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(Error);
    const text = (error as Error).message;
    // 两件事必须同时说清：盘上已经改了（不许显示成「保存失败」），而这一份连不上
    expect(text).toContain("连接配置已保存");
    expect(text).toContain("连不上");
    expect(text).toContain(REMOTE_URL);
    // 原因里不许出现凭证
    expect(text).not.toContain(TOKEN);

    // 状态是 connecting（后台按 D24 重试），不是 error：用户还什么都没做错
    const state = await h.controller.state();
    expect(state).toEqual({
      status: "connecting",
      label: REMOTE_URL,
      attempt: 1,
      nextRetryInMs: 1000,
    });
    expect(h.timers.pending()).toEqual([1000]);
  });
});
