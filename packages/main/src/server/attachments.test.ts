/**
 * 附件上传编排（`attachments.ts`）与 `chat.send` 里那一段接线。
 *
 * ## 为什么不上真服务端
 *
 * 这一层要做的事只有三件：把字节交给库、把两边的账合起来、按顺序摆好。真服务端在这里只会把这三
 * 件事藏进一次网络往返里（而且「超 4 张」「单张超限」这类拒绝必须在本地就出现，真服务端反而验
 * 不到）。所以假连接直接扮演上传三段式的另外两头，把「传了几张、每张怎么走的」变成可以直接写的
 * 一行。
 *
 * ## 有几条是**故意**这么定的，别顺手「修」掉
 *
 *   · 上传失败不阻挡发送：一张都没传上去时 `conversation.send` 里就只有文字（PRD F-H7
 *     「全失败退回纯文本」），失败原因进附件的结局、逐张上屏；
 *   · 超 4 张不是「悄悄扔掉」：第 5 张起逐张带 `asset_count_exceeded` 的那句话（库按连接语言
 *     渲染好的），前 4 张照常上传；
 *   · 附件的结局里 `problem` 是**一句话**，原文搬运：界面据它上屏，不在这一层改写措辞。
 */

import type { AttachmentOutcome as WireOutcome, MethodResult, UploadTransport } from "@ai-zen/agents-client";
import { ClientError as ClientErrorValue } from "@ai-zen/agents-client";
import type { AttachmentInput, ChatStreamEvent } from "@ai-zen/desktop-shared";
import { describe, expect, it } from "vitest";
import { mergeAttachmentOutcomes, uploadAttachments } from "./attachments.js";
import type { ContractConnection } from "./contract.js";
import { ChatEventBridge } from "./events.js";
import { ServerChatService, type ServiceContext } from "./services.js";

const CONVERSATION = "conv-1";

// ==================================================================
// 假上传通道：三段式的另外两头
// ==================================================================

interface Recorded {
  method: string;
  params: unknown;
}

interface FakeTransport extends UploadTransport {
  /** 这一层发出的每一次契约调用（`asset.begin` / `asset.end` / 其它） */
  calls: Recorded[];
  /** 收到的二进制帧（一次 `sendBinary` 一条） */
  frames: Uint8Array[];
}

/**
 * 上传三段式的服务端那一半（假件）：`asset.begin` 发句柄、`asset.end` 回引用。
 *
 * 别的方名返回 `null`（= 「不归我管」），调用方据此转给真正的那个回答者。
 */
function assetServer(): (method: string, params: unknown) => unknown | null {
  let uploads = 0;
  return (method, params) => {
    if (method === "asset.begin") {
      uploads += 1;
      return { uploadId: `upload-${uploads}`, maxBytes: 20 * 1024 * 1024, receivedBytes: 0 };
    }
    if (method === "asset.end") {
      const { uploadId } = params as { uploadId: string };
      return {
        asset: {
          assetId: `asset-${uploadId}`,
          mime: "image/png",
          bytes: 4,
          name: "图.png",
          width: null,
          height: null,
        },
      };
    }
    return null;
  };
}

/**
 * 一条假的「能上传的连接」。
 *
 * `reject` 让某一次调用失败：`method` 拿到的是这一次的方法名，`params` 是那次的入参 ——
 * 「第三张图的服务端拒了」这种处方只能这样造（真服务端不会配合你按次数失败）。
 */
function fakeTransport(
  options: {
    reject?: (method: string, params: unknown) => Error | null;
    maxAssetBytes?: number;
    maxAssetsPerMessage?: number;
  } = {},
): FakeTransport {
  const calls: Recorded[] = [];
  const frames: Uint8Array[] = [];
  const asset = assetServer();

  const transport: FakeTransport = {
    calls,
    frames,
    hello: {
      limits: {
        maxAssetBytes: options.maxAssetBytes ?? 20 * 1024 * 1024,
        maxAssetsPerMessage: options.maxAssetsPerMessage ?? 4,
      },
    },
    language: "zh",
    call: (async (method: string, params: unknown) => {
      calls.push({ method, params });
      const rejection = options.reject?.(method, params);
      if (rejection) throw rejection;
      return asset(method, params) ?? {};
    }) as UploadTransport["call"],
    sendBinary: async (frame) => {
      frames.push(frame);
    },
  };
  return transport;
}

const PNG: Uint8Array = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);

function attachment(name: string, data: Uint8Array = PNG): AttachmentInput {
  return { mime: "image/png", name, data };
}

// ==================================================================
// 上传编排
// ==================================================================

describe("uploadAttachments：render 的字节 → 服务端的 assetId", () => {
  it("两张图：每张各走一遍三段式，回来的 index 是它在用户那批里的位置", async () => {
    const transport = fakeTransport();

    const upload = await uploadAttachments(transport, CONVERSATION, [
      attachment("第一张.png"),
      attachment("第二张.png"),
    ]);

    expect(upload.failures).toEqual([]);
    expect(upload.assets).toEqual([
      { index: 0, assetId: "asset-upload-1", name: "图.png" },
      { index: 1, assetId: "asset-upload-2", name: "图.png" },
    ]);
    // `asset.begin` 带上了归属（素材行按对话挂外键）与自称的 MIME
    expect(transport.calls[0]).toMatchObject({
      method: "asset.begin",
      params: { purpose: "message_image", mime: "image/png", bytes: 4, conversationId: CONVERSATION },
    });
    expect(transport.calls.map((call) => call.method)).toEqual([
      "asset.begin",
      "asset.end",
      "asset.begin",
      "asset.end",
    ]);
    // 字节走的是二进制帧（不进 JSON）
    expect(transport.frames).toHaveLength(2);
  });

  it("第 5 张不静默丢：它进 failures，带库按连接语言渲染的那句话，前 4 张照传", async () => {
    const transport = fakeTransport();

    const upload = await uploadAttachments(
      transport,
      CONVERSATION,
      [1, 2, 3, 4, 5].map((n) => attachment(`第${n}张.png`)),
    );

    expect(upload.assets.map((asset) => asset.index)).toEqual([0, 1, 2, 3]);
    expect(upload.failures).toEqual([
      { index: 4, name: "第5张.png", message: "一条消息最多 4 张图片" },
    ]);
    // 一次 `asset.end` 都没为第 5 张发生（它连 begin 都没走到）
    expect(transport.calls.filter((call) => call.method === "asset.begin")).toHaveLength(4);
  });

  it("服务端拒了其中一张：只有那张失败，剩下的继续（一句失败不连累其它）", async () => {
    const transport = fakeTransport({
      reject: (method, params) => {
        // 第二次 `asset.end` 被服务端拒（比如它那块盘满了）
        const isSecondEnd =
          method === "asset.end" &&
          (params as { uploadId: string }).uploadId === "upload-2";
        return isSecondEnd ? new ClientErrorValue("internal", "服务端内部出错了，细节写进日志里了。") : null;
      },
    });

    const upload = await uploadAttachments(transport, CONVERSATION, [
      attachment("好的一张.png"),
      attachment("被拒的一张.png"),
      attachment("另一张.png"),
    ]);

    expect(upload.assets.map((asset) => asset.index)).toEqual([0, 2]);
    expect(upload.failures).toEqual([
      { index: 1, name: "被拒的一张.png", message: "服务端内部出错了，细节写进日志里了。" },
    ]);
  });

  it("空的一批：一个字节都不发，也不产生任何账", async () => {
    const transport = fakeTransport();
    const upload = await uploadAttachments(transport, CONVERSATION, []);
    expect(upload).toEqual({ assets: [], failures: [] });
    expect(transport.calls).toEqual([]);
  });
});

// ==================================================================
// 两边的账合一
// ==================================================================

describe("mergeAttachmentOutcomes：上传阶段 + 服务端结局 → 逐张上屏的那一份", () => {
  const wire = (assetId: string, deliveredAs: WireOutcome["deliveredAs"], problem: WireOutcome["problem"]): WireOutcome => ({
    assetId,
    deliveredAs,
    section: null,
    problem,
  });

  const problem = (message: string): WireOutcome["problem"] => ({
    code: "message.imageAsText",
    messageKey: "message.imageAsText",
    params: {},
    message,
  });

  it("顺序 = 用户摆放的顺序：没传上去的那张插回它原来的位置", async () => {
    const merged = mergeAttachmentOutcomes(
      {
        assets: [
          { index: 0, assetId: "a1", name: "一.png" },
          { index: 2, assetId: "a2", name: "三.png" },
        ],
        failures: [{ index: 1, name: "二.png", message: "图片太大（24 MB），超过单张 20 MB 的上限" }],
      },
      [
        wire("a1", "file_reference", null),
        wire("a2", "dropped", problem("三.png 没能发出去，这条消息里没有它。")),
      ],
    );

    expect(merged).toEqual([
      { assetId: "a1", deliveredAs: "file_reference", problem: null, name: "一.png" },
      {
        assetId: "",
        deliveredAs: "dropped",
        problem: "图片太大（24 MB），超过单张 20 MB 的上限",
        name: "二.png",
      },
      { assetId: "a2", deliveredAs: "dropped", problem: "三.png 没能发出去，这条消息里没有它。", name: "三.png" },
    ]);
  });

  it("服务端没为某个 assetId 说结局：不编（不拿一句「已发送」顶上去）", () => {
    const merged = mergeAttachmentOutcomes(
      { assets: [{ index: 0, assetId: "a1", name: "一.png" }], failures: [] },
      [],
    );
    expect(merged).toEqual([]);
  });
});

// ==================================================================
// chat.send：接线（IPC 形状 → 上传 → conversation.send → 事件）
// ==================================================================

interface Harness {
  ctx: ServiceContext;
  /** 这一层发出的每一次契约调用（含上传的 `asset.*`） */
  calls: Recorded[];
  /** 推给 render 的事件 */
  events: ChatStreamEvent[];
}

/**
 * 一条「本人既当连接又当上传通道」的假件。
 *
 * `chat.send` 同时用到两样能力：`call`（契约方法）与 `sendBinary`（上传分片）。所以这里把它们装在
 * 同一个对象上 —— 真的 `Client` 也是这么给的。
 */
function harness(
  reply: (method: string, params: unknown) => unknown,
  options: { reject?: (method: string, params: unknown) => Error | null } = {},
): Harness {
  const upload = fakeTransport(options);
  const calls = upload.calls;
  const asset = assetServer();
  const connection = {
    hello: upload.hello ?? null,
    language: upload.language,
    call: (async (method: string, params: unknown) => {
      calls.push({ method, params });
      const rejection = options.reject?.(method, params);
      if (rejection) throw rejection;
      // `asset.*` 由上传那半边回答，其余交给每个用例自己的 `reply`
      return asset(method, params) ?? reply(method, params);
    }) as ContractConnection["call"],
    sendBinary: upload.sendBinary,
    subscribe: () => () => {},
    onClose: () => () => {},
    onResume: () => () => {},
    resume: async (conversationId: string) => ({ conversationId }),
    track: () => {},
    untrack: () => {},
    reconnect: async () => {},
    close: async () => {},
  } as unknown as ContractConnection;

  const events: ChatStreamEvent[] = [];
  const bridge = new ChatEventBridge({
    call: connection.call,
    push: (event) => events.push(event),
    log: () => {},
  });

  return {
    calls,
    events,
    ctx: {
      call: connection.call,
      connection: () => connection,
      events: bridge,
      defaultCwd: () => "/home/user/Desktop",
    },
  };
}

const accepted = (attachments: WireOutcome[] = []) => ({
  userMessageId: "m-user",
  assistantMessageId: "m-assistant",
  attachments,
  acceptedAt: "2026-01-01T00:00:00.000Z",
});

describe("chat.send：附件从 IPC 走到 conversation.send", () => {
  it("带一张图：先传上去，再把 assetIds 放进 input（形状与服务端契约一致）", async () => {
    const h = harness(() => accepted([
      {
        assetId: "asset-upload-1",
        deliveredAs: "file_reference",
        section: null,
        problem: null,
      },
    ]));

    await new ServerChatService(h.ctx).send("ws-1", CONVERSATION, "看看这张", [attachment("图.png")]);

    expect(h.calls.map((call) => call.method)).toEqual([
      "asset.begin",
      "asset.end",
      "conversation.send",
    ]);
    expect(h.calls.at(-1)).toEqual({
      method: "conversation.send",
      params: { conversationId: CONVERSATION, input: { content: "看看这张", assetIds: ["asset-upload-1"] } },
    });
    // 事件：user + start（受理即回显）→ attachments（这一轮的结局）
    expect(h.events).toEqual([
      { conversationId: CONVERSATION, type: "user", id: "m-user", content: "看看这张" },
      { conversationId: CONVERSATION, type: "start" },
      {
        conversationId: CONVERSATION,
        type: "attachments",
        userMessageId: "m-user",
        attachments: [
          { assetId: "asset-upload-1", deliveredAs: "file_reference", problem: null, name: "图.png" },
        ],
      },
    ]);
  });

  it("没带附件：`input` 里连 `assetIds` 这个键都不出现（纯文本那条路一个字没变）", async () => {
    const h = harness(() => accepted());

    await new ServerChatService(h.ctx).send("ws-1", CONVERSATION, "你好");

    expect(h.calls).toEqual([
      { method: "conversation.send", params: { conversationId: CONVERSATION, input: { content: "你好" } } },
    ]);
    // 一条空的 attachments 事件都不发（没附件的那一轮没有这件事）
    expect(h.events.map((event) => event.type)).toEqual(["user", "start"]);
  });

  it("一张都没传上去：文字照发（全失败退回纯文本），失败逐张上屏", async () => {
    const h = harness(() => accepted(), {
      reject: (method) =>
        method === "asset.end"
          ? new ClientErrorValue("internal", "服务端内部出错了，细节写进日志里了。")
          : null,
    });

    await new ServerChatService(h.ctx).send("ws-1", CONVERSATION, "这张图你看看", [
      attachment("草稿里的一张.png"),
    ]);

    expect(h.calls.at(-1)).toEqual({
      method: "conversation.send",
      params: { conversationId: CONVERSATION, input: { content: "这张图你看看" } },
    });
    const outcome = h.events.find((event) => event.type === "attachments");
    if (outcome?.type !== "attachments") throw new Error("应当推一条 attachments");
    expect(outcome.attachments).toEqual([
      {
        assetId: "",
        deliveredAs: "dropped",
        problem: "服务端内部出错了，细节写进日志里了。",
        name: "草稿里的一张.png",
      },
    ]);
  });

  it("上传之后发送被拒（question_pending）：推 error，不推 attachments（这一轮没受理）", async () => {
    const h = harness(() => accepted(), {
      reject: (method) =>
        method === "conversation.send"
          ? new ClientErrorValue("question_pending", "这个问题还没回答，这段对话暂时不能发消息")
          : null,
    });

    await new ServerChatService(h.ctx).send("ws-1", CONVERSATION, "你好", [attachment("图.png")]);

    expect(h.events.map((event) => event.type)).toEqual(["error"]);
  });
});
