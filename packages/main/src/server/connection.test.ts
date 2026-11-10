/**
 * 连接重建用例：**daemon 重启之后，桌面端自己长回来**。
 *
 * ## 这一组盯的是那个真 bug
 *
 * 旧实现把连接缓存在 `pending ??=` 里，**建成之后再也不复查 `closed`**，于是
 * daemon 重启一次，那个进程就**永久失能** —— 之后每一次 IPC 都撞在一条已经 destroy 的
 * socket 上（`client is closed, cannot call …`），而界面上看起来只是「没反应」：没有重连、
 * 没有提示、也没有错误可看。
 *
 * 修法不是在本仓加一段重连，而是换成包里那一个（`@ai-zen/agents-client` 的
 * `transport/connection.ts`）：它每次取用都判活、断了重建、并且在重建的连接上重新订阅事件。
 * 断开那一刻 `socket-server-client` 会 `listeners.clear()` 并把 `closed` 置真（见
 * `packages/client/src/socket-server-client.ts` 的 `failAll`），所以重挂监听是重建的必要一步。
 *
 * ## 为什么必须用真 daemon
 *
 * 被测的三件事全在真件里：socket 的断开通知什么时候到、发现文件（`run/server.json`）指向
 * 新端口、以及「重新订阅 + 重挂监听」之后事件还照常到达。任何一处换成假件，
 * 测出来的就是「我假装的断开」与「我假装的推送」—— 而这恰恰是这条 bug 当初没被抓住的原因。
 *
 * ## 两条断言的形状
 *
 * 1. 重启后**一次 IPC 调用能成功**（而不是永久的 `client is closed`）；
 * 2. 重建之后**事件流仍在**（推一条事件，`chat:push` 那头能收到）。
 *
 * 用 `server-notice` 当第 2 条的探针：它不绑任何会话（不需要先开会话、也不会被会话状态
 * 搅乱），而且是真链路 —— `EventHub` → 真 socket → `events.ts` 的翻译 → `chat:push`。
 */

import { afterEach, describe, expect, it } from "vitest";
import { SERVER_EVENTS } from "@ai-zen/agents-client";
import type { Conversation, ConversationSummary, Workspace } from "@ai-zen/desktop-shared";
import { noticeText } from "./notices.js";
import { startTestServer, waitFor, type TestServer } from "./test-harness.js";

let server: TestServer | null = null;

afterEach(async () => {
  if (server) await server.stop();
  server = null;
});

/** render 真实走的那条路：`window.electronAPI.invokeService(service, method, ...args)` */
async function invoke<T>(service: string, method: string, ...args: unknown[]): Promise<T> {
  if (!server) throw new Error("用例还没起服务端");
  return (await server.layer.manager.invokeService(service, method, ...args)) as T;
}

/** 开一个工作区 + 一段会话（`live` 的会话活在脚手架的 `SessionManager` 里，重启后照旧在） */
async function openWorkspace(): Promise<{ workspaceId: string; conversationId: string }> {
  const workspace = await invoke<Workspace>("workspace", "create", "", server!.projectDir);
  const conversation = await invoke<Conversation>("conversation", "create", workspace.id, "default");
  return { workspaceId: workspace.id, conversationId: conversation.id };
}

/** 侧栏那份清单的 id（`conversation.list` 是**一步 IPC**，`workspace.list` 也是 —— 同一分发面） */
async function listIds(workspaceId: string): Promise<string[]> {
  const listed = await invoke<ConversationSummary[]>("conversation", "list", workspaceId);
  return listed.map((item) => item.id);
}

describe("连接：daemon 重启之后", () => {
  it("一次 IPC 调用能成功（而不是永久的 client is closed）", async () => {
    server = await startTestServer();
    const { workspaceId, conversationId } = await openWorkspace();
    // 重启之前这条路是通的：后面那次成功才说明「重建」，而不是「本来就没连上」
    expect(await listIds(workspaceId)).toEqual([conversationId]);

    await server.restart();

    /**
     * 这里**轮询到成功**而不是断言「第一次调用就成功」：断线通知是异步的（socket 的 close
     * 事件），在它到达之前 `client()` 手上那条连接看起来还活着 —— 那是同一个竞态的另一面，
     * 不是「客户端有没有能力恢复」这件事。旧实现在这里永远好不了：缓存永不复查 `closed`，
     * 每一次调用都失败，`waitFor` 五秒后抛错。
     */
    const listed = await waitFor(
      async () => {
        try {
          return await listIds(workspaceId);
        } catch {
          // 还没接上：下一次轮询再试（不 sleep、不猜时长）
          return undefined;
        }
      },
      "daemon 重启之后的一次 IPC 调用",
      // 比 vitest 的用例时限（5s）短：红的时候要报「在等什么」，而不是一句
      // `Test timed out in 5000ms`
      3_000,
    );

    // 会话还在（业务状态归服务端，连接只是入口）
    expect(listed).toEqual([conversationId]);

    // 接回来的是**一条能用的**连接，不是「碰巧这一次成了」：紧接着再调一次，照样成功
    expect(await listIds(workspaceId)).toEqual([conversationId]);
  });

  it("重建之后事件流仍在（推一条 server-notice，chat:push 那头收得到）", async () => {
    server = await startTestServer();
    const { workspaceId, conversationId } = await openWorkspace();
    expect(await listIds(workspaceId)).toEqual([conversationId]);

    await server.restart();

    // 先触发一次重建，等它接上（重建由「下一次取用」驱动，见包里 `ServerConnection.client()`）
    await waitFor(
      async () => {
        try {
          return (await listIds(workspaceId))[0] === conversationId ? true : undefined;
        } catch {
          return undefined;
        }
      },
      "连接重建",
      3_000,
    );

    /**
     * 重建之后**必须重新订阅**：`events.watch` 是连接级的（服务端按连接登记推送），
     * 而客户端在断开那一刻会把监听表清空。少了这一步，新连接能发请求、却一个事件也收不到
     * —— 症状是界面安静地不动（这条 bug 与上一条是同一次事故的两半）。
     *
     * 探针用 `server-notice`：它不绑会话，`EventHub` 一 publish，所有在 watch 的连接都该
     * 收到一份。
     */
    server.hub.publish({
      event: SERVER_EVENTS.notice,
      level: "warn",
      code: "mcpUnavailable",
      params: { name: "filesystem" },
    });

    const notice = await waitFor(
      () => server!.pushed.find((event) => event.type === "notice"),
      "重建之后的那个事件",
      3_000,
    );
    expect(notice).toEqual({
      type: "notice",
      level: "warn",
      text: noticeText("mcpUnavailable", { name: "filesystem" }),
    });
  });
});
