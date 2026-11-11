/**
 * 通知槽位的记账件用例：补看（`notice.list` / 快照的 `pendingNotices`）、确认（`notice.ack`），
 * 以及「同一条通知在两个出口之间不重复弹」。
 *
 * ## 这一层验得到什么、验不到什么
 *
 * 这一层是**纯记账**：输入是两三条协议响应，输出是推给 render 的 `notice` 事件。而「真 daemon
 * 那一侧」的两个方向由 `events.test.ts` 用真 socket 验（实时那条广播、断线重连之后的补看、
 * 打开会话从快照补看）。这里补的是那些在真链路上不好摆的姿势：`notice.ack` 到底发了哪些 id、
 * 一条都不挂时会不会白跑一趟、ack 失败会不会冒出来。
 *
 * ## 假服务端为什么要**两张**槽位表
 *
 * `notice.ack { ids }` 认**两类** id（决策 A30）：全局的（`GlobalNoticeSlot`）与会话内的
 * （`pendingNotices` 里那些）。假服务端照着真件也认两类（`ServerApp.ackNotices` 就是先查全局
 * 表、再问会话层），这样「确认之后就不该再报一遍」这半句对两条线都成立。
 */

import { describe, expect, it } from "vitest";
import type {
  GlobalNoticeSlot,
  NoticeAckParams,
  NoticeAckResult,
  NoticeListResult,
  SessionNoticeEvent,
} from "@ai-zen/agents-client";
import type { ChatStreamEvent } from "@ai-zen/desktop-shared";
import type { ProtocolCall } from "./call.js";
import { NoticeSlots } from "./noticeSlots.js";
import { noticeText } from "./notices.js";

/** 记下来的每一次调用（`method` + `params`） */
interface RecordedCall {
  method: string;
  params?: unknown;
}

/**
 * 一台**只认通知那两条方法**的假服务端：两张槽位表，`ack` 真的把命中的删掉。
 *
 * 为什么不回一个常量对象：那样「确认之后就不该再列出来」这半句没法验，而它恰恰是
 * 「显示一次就消掉」的判据。
 */
function fakeServer(
  globals: GlobalNoticeSlot[] = [],
  sessions: Record<string, SessionNoticeEvent[]> = {},
): {
  call: ProtocolCall;
  calls: RecordedCall[];
  remaining: () => GlobalNoticeSlot[];
  sessionRemaining: (sessionId: string) => SessionNoticeEvent[];
} {
  let global = [...globals];
  const session = new Map<string, SessionNoticeEvent[]>(
    Object.entries(sessions).map(([id, items]) => [id, [...items]]),
  );
  const calls: RecordedCall[] = [];
  const call = async <T>(method: string, params?: unknown): Promise<T> => {
    calls.push({ method, params });
    if (method === "notice.list") {
      return { notices: global } satisfies NoticeListResult as T;
    }
    if (method === "notice.ack") {
      const ids = (params as NoticeAckParams).ids;
      const acked: string[] = [];
      for (const id of ids) {
        const before = global.length;
        global = global.filter((slot) => slot.id !== id);
        if (global.length !== before) acked.push(id);
        for (const [sessionId, items] of session) {
          const rest = items.filter((item) => item.id !== id);
          if (rest.length === items.length) continue;
          session.set(sessionId, rest);
          acked.push(id);
        }
      }
      return { acked } as NoticeAckResult as T;
    }
    throw new Error(`假的协议服务端不认识这个方法：${method}`);
  };
  return {
    call,
    calls,
    remaining: () => global,
    sessionRemaining: (sessionId) => session.get(sessionId) ?? [],
  };
}

/** 造一个全局通知槽位（真件里 id 是 UUID、`createdAt` 是登记时刻） */
function slot(
  id: string,
  code: GlobalNoticeSlot["code"],
  params?: Record<string, unknown>,
): GlobalNoticeSlot {
  return {
    id,
    level: "warn",
    code,
    ...(params !== undefined ? { params } : {}),
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

/** 造一条会话内通知（实时事件与快照里那一项是同一个形状、同一个 id） */
function sessionNotice(
  id: string,
  code: SessionNoticeEvent["code"],
  params?: Record<string, unknown>,
  sessionId = "chat_1",
): SessionNoticeEvent {
  return {
    event: "session-notice",
    id,
    sessionId,
    level: "warn",
    code,
    ...(params !== undefined ? { params } : {}),
  };
}

/** 造一个待测件 + 它推出去的全部事件 */
function harness(
  globals: GlobalNoticeSlot[] = [],
  sessions: Record<string, SessionNoticeEvent[]> = {},
): {
  slots: NoticeSlots;
  server: ReturnType<typeof fakeServer>;
  pushed: ChatStreamEvent[];
} {
  const server = fakeServer(globals, sessions);
  const pushed: ChatStreamEvent[] = [];
  const slots = new NoticeSlots({
    call: server.call,
    push: (event) => pushed.push(event),
  });
  return { slots, server, pushed };
}

/** 等 ack 那一趟（它不阻塞上屏，所以断言确认之前要先让微任务/事件循环跑完） */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("全局通知：补看与确认", () => {
  it("连接到了一条（新）连接：逐条上屏，然后按服务端给的 id 一次性确认", async () => {
    const { slots, server, pushed } = harness([
      slot("id-1", "mcpUnavailable", { name: "filesystem" }),
      slot("id-2", "storeUnavailable", { error: "磁盘只读" }),
    ]);

    await slots.sync();

    // 两条都上了屏，文案是词典出的**人话**，而且**不带** conversationId（它不属于任何会话）
    expect(pushed).toEqual([
      {
        type: "notice",
        level: "warn",
        text: noticeText("mcpUnavailable", { name: "filesystem" }),
      },
      {
        type: "notice",
        level: "warn",
        text: noticeText("storeUnavailable", { error: "磁盘只读" }),
      },
    ]);
    // 确认用的是**服务端报上来的** id，而且一趟发完
    expect(server.calls.filter((call) => call.method === "notice.ack")).toEqual([
      { method: "notice.ack", params: { ids: ["id-1", "id-2"] } },
    ]);
    // 确认之后槽位就没了：下一次连接不会再报一遍
    expect(server.remaining()).toEqual([]);
  });

  it("一条都没挂着时不发确认（省一趟往返，也不造一个空请求）", async () => {
    const { slots, server, pushed } = harness();

    await slots.sync();

    expect(pushed).toEqual([]);
    expect(server.calls.map((call) => call.method)).toEqual(["notice.list"]);
  });

  it("并发触发只查一次（start 与 onOpen 都可能叫它，同一条连接不该查两遍）", async () => {
    const { slots, server, pushed } = harness([slot("id-1", "mcpUnavailable")]);

    await Promise.all([slots.sync(), slots.sync()]);

    // 查两遍的话，会在第一次确认之前把同一条通知书上屏两次
    expect(pushed).toHaveLength(1);
    expect(server.calls.filter((call) => call.method === "notice.list")).toHaveLength(1);
  });
});

describe("实时广播：确认用的是事件自带的 id", () => {
  it("上屏立刻发生，确认只发一条 notice.ack{ids:[事件里的 id]}（**不**再查一遍列表）", async () => {
    const { slots, server, pushed } = harness([
      slot("id-1", "mcpUnavailable", { name: "filesystem" }),
    ]);

    // 服务端登记一条通知 = 存槽位 + 播一声（真件里是 `ServerApp.publishNotice`）：
    // 广播带的是**槽位自己的 id**（决策 A35），客户端据此就能确认
    slots.live({
      event: "server-notice",
      id: "id-1",
      level: "warn",
      code: "mcpUnavailable",
      params: { name: "filesystem" },
    });

    // 广播那一条**立刻**上屏（用户不该等一趟往返）
    expect(pushed).toEqual([
      {
        type: "notice",
        level: "warn",
        text: noticeText("mcpUnavailable", { name: "filesystem" }),
      },
    ]);

    await settle();
    // 确认只用事件自带的那个 id，一路上**没有** notice.list：列表当初唯一的作用是「把 id
    // 捡回来」，而广播现在自己带着它
    expect(server.calls).toEqual([
      { method: "notice.ack", params: { ids: ["id-1"] } },
    ]);
    // 确认之后槽位就没了：下一次连接（sync）不会再报一遍
    expect(server.remaining()).toEqual([]);
    expect(pushed).toHaveLength(1);
  });

  it("同一条 id 从两个出口都来（实时 + 重连后那次 list）：按 id 挡住，不弹第二遍", async () => {
    const pending = slot("id-1", "mcpUnavailable", { name: "filesystem" });
    const pushed: ChatStreamEvent[] = [];
    // 服务端那一侧确认失败过（连接刚好断过）：槽位还挂着，下一次 `sync()` 会把它再报一遍
    // —— 而这正是「双出口重复」在真事里的那条路
    const slots = new NoticeSlots({
      call: async (method) => {
        if (method === "notice.list") return { notices: [pending] } as never;
        throw new Error("client is closed");
      },
      push: (event) => pushed.push(event),
    });

    slots.live({
      event: "server-notice",
      id: pending.id,
      level: pending.level,
      code: pending.code,
      ...(pending.params !== undefined ? { params: pending.params } : {}),
    });
    await slots.sync();

    // 两个出口说的是同一条通知（同一个 UUID）：用户只该看到一次
    expect(pushed).toHaveLength(1);
  });

  it("确认失败（连接刚好断了）不往上冒：上屏照旧，槽位留给下一次连接对账", async () => {
    const pushed: ChatStreamEvent[] = [];
    const slots = new NoticeSlots({
      call: async () => {
        throw new Error("client is closed");
      },
      push: (event) => pushed.push(event),
    });

    expect(() =>
      slots.live({
        event: "server-notice",
        id: "id-1",
        level: "warn",
        code: "storeUnavailable",
      }),
    ).not.toThrow();
    await settle();

    // 用户该看到的还是看到了；没消掉的那一条由下一次 `sync()` 清掉（那是它存在的理由之一）
    expect(pushed).toHaveLength(1);
  });
});

describe("会话内通知：按 id 判断与确认（签名记账退场）", () => {
  it("快照里的 pendingNotices 逐条上屏（**带** conversationId），并按各自的 id 一趟确认", async () => {
    const pending = [
      sessionNotice("s-1", "migrationSkipped"),
      sessionNotice("s-2", "persistFailed", { error: "磁盘只读" }),
    ];
    const { slots, server, pushed } = harness([], { chat_1: pending });

    slots.pending("chat_1", pending);
    await settle();

    expect(pushed).toEqual([
      {
        conversationId: "chat_1",
        type: "notice",
        level: "warn",
        text: noticeText("migrationSkipped"),
      },
      {
        conversationId: "chat_1",
        type: "notice",
        level: "warn",
        text: noticeText("persistFailed", { error: "磁盘只读" }),
      },
    ]);
    // 两类 id 走同一条方法（决策 A30）：一个 ack 把快照里那两条一起确认掉
    expect(server.calls).toEqual([
      { method: "notice.ack", params: { ids: ["s-1", "s-2"] } },
    ]);
    // 确认之后快照不会再报它（槽位没了）
    expect(server.sessionRemaining("chat_1")).toEqual([]);
  });

  it("实时那条上屏之后按事件自带的 id 确认（打开会话时那次快照因此不再报它）", async () => {
    const notice = sessionNotice("s-1", "handoffPath", { path: "/tmp/交接.md" });
    const { slots, server, pushed } = harness([], { chat_1: [notice] });

    // 实时那条先到……
    slots.session(notice, "chat_1");
    expect(pushed).toHaveLength(1);
    await settle();
    expect(server.calls).toEqual([
      { method: "notice.ack", params: { ids: ["s-1"] } },
    ]);

    // ……随后快照才到，但槽位已经被消掉：服务端报上来的就是空的那份
    slots.pending("chat_1", server.sessionRemaining("chat_1"));
    await settle();
    expect(pushed).toHaveLength(1);
  });

  it("同一条 id 从两个出口都来：只弹一次（按 id 判断，不是按签名）", async () => {
    const notice = sessionNotice("s-1", "migrationDegraded", {
      requested: "self",
      mode: "summary",
    });
    const { slots, server, pushed } = harness([], { chat_1: [notice] });

    // 实时的与快照里的是**同一条**（同一个 id）：一起到、顺序也说不准
    slots.session(notice, "chat_1");
    slots.pending("chat_1", [notice]);
    slots.session(notice, "chat_1");
    await settle();

    expect(pushed).toHaveLength(1);
    // 确认照发（重复确认一个已经不存在的 id 只是不出现在 `acked` 里，不是错误）
    expect(server.sessionRemaining("chat_1")).toEqual([]);
  });

  it("code 与 params 都相同但 id 不同：是**两条**通知，各弹一次", async () => {
    const pending = [
      sessionNotice("s-1", "handoffPath", { path: "/tmp/a.md" }),
      sessionNotice("s-2", "handoffPath", { path: "/tmp/a.md" }),
    ];
    const { slots, pushed } = harness([], { chat_1: pending });

    slots.pending("chat_1", pending);
    await settle();

    // 按「会话 + code + params」记账的话这里只剩一条：用户会少看到一次「交接文档落在哪」
    // （两次交接可以落到同一个路径上），而那正是上一轮那张签名表站不住的地方
    expect(pushed).toHaveLength(2);
  });

  it("两段会话互不影响（同一句话在两个会话里各弹一次）", async () => {
    const inFirst = sessionNotice("s-1", "migrationSkipped", undefined, "chat_1");
    const inSecond = sessionNotice("s-2", "migrationSkipped", undefined, "chat_2");
    const { slots, server, pushed } = harness([], {
      chat_1: [inFirst],
      chat_2: [inSecond],
    });

    slots.pending("chat_1", [inFirst]);
    slots.pending("chat_2", [inSecond]);
    await settle();

    expect(pushed).toEqual([
      {
        conversationId: "chat_1",
        type: "notice",
        level: "warn",
        text: noticeText("migrationSkipped"),
      },
      {
        conversationId: "chat_2",
        type: "notice",
        level: "warn",
        text: noticeText("migrationSkipped"),
      },
    ]);
    // 确认各发各的（两段会话两条 uuid），两张表都清空了
    expect(server.calls).toEqual([
      { method: "notice.ack", params: { ids: ["s-1"] } },
      { method: "notice.ack", params: { ids: ["s-2"] } },
    ]);
    expect(server.sessionRemaining("chat_1")).toEqual([]);
    expect(server.sessionRemaining("chat_2")).toEqual([]);
  });
});
