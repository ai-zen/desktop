/**
 * **竖切（e2e）**：连接 → 项目 → 会话 → 发消息 → 流式 → 重启后补回历史。
 *
 * 这条用例不跑就跳过（`AI_ZEN_SLICE=1 pnpm test`），因为它要三样真东西：
 *
 *   1. `dist/host.mjs`（`pnpm build` 出来的那份**随包分发**的宿主，本机拉起走的就是它）；
 *   2. 一个假的 OpenAI 兼容端点（用例自己起一个 http 服务，回几条 SSE，不碰真网络）；
 *   3. 一个临时数据根（`AI_ZEN_DIR`，里面写着这个假端点与一个绑它的助手）。
 *
 * 走的是**生产路径**：`createHostLayer` → `ensureHost`（本机发现文件 / 拉起 / 握手）→ 六个
 * Service → 事件桥。所以它红了意味着「装到用户机器上跑不起来」，而不是「某个假件对不上」。
 *
 * 唯一被换掉的是模型那一端（假端点）：真端点在 CI 里既不可达也不该被计费，而这一条要验的是
 * **从发消息到流式上屏、再到重启补回**这条链，不是模型答得好不好。
 */

import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { ensureHost } from "@ai-zen/agents-client";
import type { ChatStreamEvent } from "@ai-zen/desktop-shared";
import { afterAll, describe, expect, it } from "vitest";
import { createHostLayer, type HostLayer } from "./index.js";

/** 随包分发的宿主（与本文件同包：`packages/main/dist/host.mjs`） */
const HOST_ENTRY = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "dist", "host.mjs");

const ENABLED = process.env.AI_ZEN_SLICE === "1";

describe.runIf(ENABLED)("竖切：连接 → 项目 → 会话 → 发消息 → 流式 → 重启补拉", () => {
  const cleanup: Array<() => Promise<void> | void> = [];

  afterAll(async () => {
    for (const step of cleanup.reverse()) await step();
  });

  it("一条竖切跑通", { timeout: 180_000 }, async () => {
    expect(existsSync(HOST_ENTRY), `先 pnpm build 出 ${HOST_ENTRY}`).toBe(true);

    // ---- 1. 假的 OpenAI 兼容端点（流式回两片正文 + 用量的收尾片）------------------
    const llm = await startMockModel();
    cleanup.push(() => llm.stop());
    log(`假模型端点：http://127.0.0.1:${llm.port}/v1`);

    // ---- 2. 临时数据根：一句配置 + 一个绑定了那个模型的助手 -----------------------
    const dataRoot = await mkdtemp(join(tmpdir(), "aiz-slice-"));
    cleanup.push(() => rm(dataRoot, { recursive: true, force: true }));
    await writeConfig(dataRoot, llm.port);
    log(`数据根：${dataRoot}`);

    // ---- 3. 第一段：连上本地宿主（没有就拉起 dist/host.mjs）------------------
    const first = collect();
    let layer: HostLayer = createHostLayer({
      aiZenDir: dataRoot,
      clientInfo: { name: "@ai-zen/desktop", version: "0.0.0-slice" },
      defaultCwd: () => dataRoot,
      push: first.push,
      hostEntry: HOST_ENTRY,
      log: log,
    });
    cleanup.push(() => layer.dispose());

    await layer.start();
    log(`✓ 已连上（握手：${JSON.stringify(layer.hello())}）`);
    // 拉起之后要杀掉的 pid 从发现文件里读（`ensureHost` 刚写完它）
    const facts = JSON.parse(await readFile(join(dataRoot, "run", "host.json"), "utf8")) as {
      pid: number;
    };
    cleanup.push(() => {
      try {
        process.kill(facts.pid);
      } catch {
        // 已经退了
      }
    });

    // ---- 4. 项目列表 / 建项目 -----------------------------------------------------
    const projectCwd = join(dataRoot, "项目");
    await mkdir(projectCwd, { recursive: true });
    const workspace = (await layer.manager.invokeService("workspace", "create", "竖切项目", projectCwd)) as {
      id: string;
      name: string;
      folder: { cwd: string; exists: boolean };
    };
    log(`✓ workspace.create → ${workspace.id} ${workspace.name} ${workspace.folder.cwd}`);
    const projects = (await layer.manager.invokeService("workspace", "list")) as Array<{ id: string }>;
    expect(projects.map((item) => item.id)).toContain(workspace.id);

    // ---- 5. 助手列表（必须看到用例写进数据根的那个）------------------------------
    const agents = (await layer.manager.invokeService("agent", "list")) as Array<{ id: string; name: string }>;
    log(`✓ agent.list → ${agents.map((agent) => agent.id).join("、")}`);
    expect(agents.map((agent) => agent.id)).toContain("mock-agent");

    // ---- 6. 会话列表（新建之前是空的）/ 新建会话 ---------------------------------
    const before = (await layer.manager.invokeService("conversation", "list", workspace.id)) as unknown[];
    expect(before).toEqual([]);
    const conversation = (await layer.manager.invokeService(
      "conversation",
      "create",
      workspace.id,
      "mock-agent",
    )) as { id: string; model: { modelId: string; name: string; vision: boolean; source: string } };
    log(`✓ conversation.create → ${conversation.id}（模型 ${conversation.model.modelId}）`);
    // 模型整块是宿主给的那份（id / 名字 / 能不能看图 / 谁定的），不只是 id
    expect(conversation.model).toEqual({
      modelId: "mock-model",
      name: "假模型",
      vision: false,
      source: "agent",
    });
    // 刚建出来的是**草稿**：宿主要等第一条用户消息才落库（R56 / F-C2「没有用户消息就不写」），
    // 所以此刻它不在侧栏列表里。这不是 bug，是那一条决定的形状。
    const stillEmpty = (await layer.manager.invokeService("conversation", "list", workspace.id)) as unknown[];
    expect(stillEmpty).toEqual([]);
    log("✓ conversation.list：草稿阶段不列（等第一条消息落库）");

    // ---- 7. 发消息 → 流式 --------------------------------------------------------
    first.clear();
    await layer.manager.invokeService("chat", "send", workspace.id, conversation.id, "介绍一下你自己");
    await first.waitFor((event) => event.type === "done", 90_000);

    const types = first.events.map((event) => event.type);
    log(`✓ 事件序列：${types.join(" → ")}`);
    // 先「进入流式态」，随后上屏那条用户消息 —— 它要回宿主取一次（带图那句在库里是内容段
    // 数组），所以中间可能夹着一条 `run.state` 的六态推送
    expect(types[0]).toBe("start");
    const userEvent = first.events.find(
      (event): event is Extract<ChatStreamEvent, { type: "user" }> => event.type === "user",
    );
    if (!userEvent) throw new Error("没有收到 user 事件");
    // 上屏的是 core 的 `AgentNS.Message` 本体（角色 / 内容 / id 都在里面），不是一句字符串
    expect(userEvent.message.role).toBe("user");
    expect(textOf(userEvent.message)).toContain("介绍一下你自己");
    // 流式：至少有两条 message（正文一片一片长出来），而且内容在变长
    const streamed = first.events.filter(
      (event): event is Extract<ChatStreamEvent, { type: "message" }> => event.type === "message",
    );
    expect(streamed.length).toBeGreaterThanOrEqual(2);
    log(`✓ 流式片段：${streamed.map((event) => JSON.stringify(event.message.content)).join(" ")}`);
    // 六态：至少经过「在输出」
    const phases = first.events.flatMap((event) => (event.type === "stream" ? [event.phase] : []));
    log(`✓ 六态：${phases.join(" → ")}`);
    expect(phases.some((phase) => phase !== null)).toBe(true);

    const done = first.events.find(
      (event): event is Extract<ChatStreamEvent, { type: "done" }> => event.type === "done",
    );
    if (!done) throw new Error("没有收到 done");
    const texts = done.messages.map(textOf);
    log(`✓ done：${done.messages.length} 条消息 → ${texts.map((text) => JSON.stringify(text)).join(" ")}`);
    expect(texts.join("")).toContain("你好");
    expect(texts.join("")).toContain("世界");
    // 用户那句在历史里，且是宿主给的那条（不是客户端编的）：宿主会把自己注入的
    // 「当前目录」那一段一起写进去（F-D9），所以这里只看它包含用户敲的字
    expect(texts[0]).toContain("介绍一下你自己");

    // 落库之后它才出现在侧栏列表里（R56 / F-C2）
    const listed = (await layer.manager.invokeService("conversation", "list", workspace.id)) as Array<{
      id: string;
      messageCount: number;
      name: string;
    }>;
    log(`✓ conversation.list → ${JSON.stringify(listed.map((item) => [item.name, item.messageCount]))}`);
    expect(listed.map((item) => item.id)).toEqual([conversation.id]);
    expect(listed[0]?.messageCount).toBeGreaterThanOrEqual(2);

    // ---- 8. 重启：关掉这一层，再照 run/host.json 连回来 ------------------------
    layer.dispose();
    const second = collect();
    layer = createHostLayer({
      aiZenDir: dataRoot,
      clientInfo: { name: "@ai-zen/desktop", version: "0.0.0-slice" },
      defaultCwd: () => dataRoot,
      push: second.push,
      hostEntry: HOST_ENTRY,
      log: log,
    });
    await layer.start();
    log("✓ 重启后已按 run/host.json 连回同一个宿主（没有重复拉起）");

    const restored = (await layer.manager.invokeService(
      "chat",
      "getState",
      workspace.id,
      conversation.id,
    )) as {
      messages: Array<{ id: string; content?: unknown }>;
      run: { status: string };
      context: { usage: { total_tokens: number }; handoffThreshold: number };
      thinking: { selected: string | null };
      usage: { total: { total_tokens: number } };
      questions: unknown[];
    };
    log(
      `✓ conversation.state + message.list → ${restored.messages.length} 条历史，run.status=${restored.run.status}：` +
        restored.messages.map(textOf).map((text) => JSON.stringify(text)).join(" "),
    );
    // 除了消息，宿主那份现场状态也整份回来了（状态栏要的上下文 / 思考 / 用量都在里面）
    log(
      `✓ 现场事实：上下文 ${restored.context.usage.total_tokens}/${restored.context.handoffThreshold} token，` +
        `思考档位=${restored.thinking.selected}，累计用量=${restored.usage.total.total_tokens}，` +
        `问题 ${restored.questions.length} 条`,
    );
    expect(restored.messages.map(textOf).join("")).toContain("世界");
    // 这一轮早就结束了：`run.status` 回到 `idle`（「在不在跑」就是读它）
    expect(restored.run.status).toBe("idle");
    // 上下文两条阈值也在（状态栏那一格按它算百分比）
    expect(restored.context.handoffThreshold).toBeGreaterThan(0);

    // ---- 9. 断线补拉的那一半：`message.list({ after })` -------------------------
    // 重连之后客户端库就是靠这一步把「本地最后一条」之后的内容补回来（L5 / A12）。
    // `after` 命中的那条**本身**也在结果里，而且内容是宿主最新的 —— 所以流式中那条是替换、
    // 不是又追加一条。
    const anchor = restored.messages[0]?.id ?? "";
    const { client } = await ensureHost({
      dataRoot,
      clientInfo: { name: "@ai-zen/desktop-slice", version: "0.0.0-slice" },
      settings: { mode: "local" },
      language: "zh",
    });
    cleanup.push(() => client.close());
    const resumed = await client.resume(conversation.id, anchor);
    log(
      `✓ message.list({ after }) → mode=${resumed.mode} anchor=${resumed.anchor === anchor} ` +
        `${resumed.messages.length} 条`,
    );
    expect(resumed.mode).toBe("anchor");
    expect(resumed.anchor).toBe(anchor);
    expect(resumed.messages[0]?.id).toBe(anchor);
    expect(resumed.messages.map(textOf).join("")).toContain("世界");

    layer.dispose();
    log("✓ 竖切全部通过");
  });
});

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function log(message: string): void {
  // 用例的输出就是交付报告里的那份证据：`vitest run` 会把它打出来
  console.log(message);
}

/** 一条消息的正文（core 的 `content` 可能是字符串，也可能是内容段数组） */
function textOf(message: { content?: unknown }): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((section) => (section as { text?: string }).text ?? "").join("");
  }
  return "";
}

/** 收集推给 render 的事件，并能等某一条出现 */
function collect(): {
  events: ChatStreamEvent[];
  push: (event: ChatStreamEvent) => void;
  clear: () => void;
  waitFor: (predicate: (event: ChatStreamEvent) => boolean, timeoutMs: number) => Promise<void>;
} {
  const events: ChatStreamEvent[] = [];
  return {
    events,
    // 收下时拍一张快照：`message` 事件里那条消息对象在后续增量里会被就地改写（core 的
    // `applyChunk` 就是就地改），而 render 那边收到的是一份**序列化过的拷贝**（IPC 结构化克隆）。
    // 用 `structuredClone` 收，验的才是 render 真正看到的东西。
    push: (event) => events.push(structuredClone(event)),
    clear: () => events.splice(0),
    waitFor: async (predicate, timeoutMs) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (events.some(predicate)) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error(`等事件超时（${timeoutMs}ms）：已收到 ${events.map((event) => event.type).join("、")}`);
    },
  };
}

/**
 * 一个假的 OpenAI 兼容端点：只回 `/chat/completions` 的流式两片正文。
 *
 * 形状按 openai 的 chunk 来（`choices[0].delta`），因为宿主那边正是原样把 delta 转成 `message.delta`
 * 推出去的 —— 这样一来「流式上屏」验的就是真链路，而不是我造的一个近路。
 */
async function startMockModel(): Promise<{ port: number; stop: () => Promise<void> }> {
  const host: HttpServer = createHttpServer((request, response) => {
    if (!request.url?.endsWith("/chat/completions")) {
      response.writeHead(404).end();
      return;
    }
    let body = "";
    request.on("data", (chunk) => {
      body += String(chunk);
    });
    request.on("end", () => {
      const streaming = body.includes('"stream":true');
      if (!streaming) {
        // 非流式（自动取名之类）：回一份最小的完整响应
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            id: "chatcmpl-mock",
            object: "chat.completion",
            created: 1,
            model: "mock-model",
            choices: [{ index: 0, message: { role: "assistant", content: "标题" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
          }),
        );
        return;
      }
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
        `data: ${JSON.stringify({
          id: "chatcmpl-mock",
          object: "chat.completion.chunk",
          created: 1,
          model: "mock-model",
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`;
      response.write(chunk({ role: "assistant", content: "你好" }));
      response.write(chunk({ content: "，世界" }));
      response.write(chunk({}, "stop"));
      response.write(
        `data: ${JSON.stringify({
          id: "chatcmpl-mock",
          object: "chat.completion.chunk",
          created: 1,
          model: "mock-model",
          choices: [],
          usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
        })}\n\n`,
      );
      response.write("data: [DONE]\n\n");
      response.end();
    });
  });

  await new Promise<void>((resolve) => host.listen(0, "127.0.0.1", resolve));
  const port = (host.address() as AddressInfo).port;
  return {
    port,
    stop: () => new Promise<void>((resolve) => host.close(() => resolve())),
  };
}

/** 写 `config.json`（一个假端点 + 一个绑它的模型）与 `agents/mock-agent.json` */
async function writeConfig(dataRoot: string, port: number): Promise<void> {
  await writeFile(
    join(dataRoot, "config.json"),
    JSON.stringify(
      {
        endpoints: [
          {
            id: "mock-endpoint",
            name: "假端点",
            baseUrl: `http://127.0.0.1:${port}/v1`,
            apiKey: "sk-mock",
          },
        ],
        models: [
          {
            id: "mock-model",
            name: "假模型",
            endpointId: "mock-endpoint",
            modelName: "mock-model",
            tokenThresholds: { handoff: 100_000, guard: 200_000 },
            custom: true,
          },
        ],
        defaultModel: "mock-model",
        defaultAgent: "mock-agent",
        // 关掉自动取名：它会多打一次模型（这次竖切不验它）
        autoTitle: false,
        language: "zh",
      },
      null,
      2,
    ),
  );
  await mkdir(join(dataRoot, "agents"), { recursive: true });
  await writeFile(
    join(dataRoot, "agents", "mock-agent.json"),
    JSON.stringify(
      {
        id: "mock-agent",
        name: "竖切助手",
        messages: [{ id: "m-system", role: "system", content: "你是一个测试助手" }],
        modelId: "mock-model",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        custom: true,
      },
      null,
      2,
    ),
  );
}
