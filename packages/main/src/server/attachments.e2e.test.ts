/**
 * **附件竖切（e2e）**：一张图从「render 递过来的字节」走到 `assets/` 里的文件，再走到气泡上那句
 * 服务端渲染的结局文案。
 *
 * 与 `slice.e2e.test.ts` 同口径、同样不跑就跳过（`AI_ZEN_SLICE=1 pnpm test`）：要 `dist/server.mjs`
 * （随包分发的那份服务端）、一个假的 OpenAI 兼容端点、一个临时数据根。走的是**生产路径**：
 * `createServerLayer` → `ensureService…`（本机发现文件 / 拉起 / 握手）→ 六个 Service → 上传三段式
 * → 事件桥。
 *
 * ## 它钉住的三件事
 *
 *   1. **新对话的第一条就带图能传上去**：`conversation.create` 只发一个 id（草稿，R56），落库发生
 *      在 `asset.begin`（服务端拿这条连接的语言把隐藏的 cwd 消息一起写进去）—— 所以这里用的就是
 *      刚建出来的那段对话，不先发一句纯文本做绕路；
 *   2. **`assets/` 下真的出现文件**：字节数与输入一致，超 4 张的那一张逐张给一句话（不静默丢）；
 *   3. **结局文案来自服务端**：假模型没有视觉能力，服务端把图退化成文字（`text_fallback`），那句话
 *      按连接语言（中文）渲染好推出 —— 界面上显示的就是它，客户端不另写一份。
 */

import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import type { ChatStreamEvent } from "@ai-zen/desktop-shared";
import { afterAll, describe, expect, it } from "vitest";
import { createServerLayer, type ServerLayer } from "./index.js";

/** 随包分发的服务端（与本文件同包：`packages/main/dist/server.mjs`） */
const SERVER_ENTRY = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "dist", "server.mjs");

const ENABLED = process.env.AI_ZEN_SLICE === "1";

/** 一张真的 1×1 PNG（70 字节）：字节数能对上，服务端才能按 `image/png` 落盘 */
const PNG_BYTES = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
    "base64",
  ),
);

describe.runIf(ENABLED)("附件竖切：字节 → assets/ → 气泡上那句结局", () => {
  const cleanup: Array<() => Promise<void> | void> = [];

  afterAll(async () => {
    for (const step of cleanup.reverse()) await step();
  });

  it("新对话的第一条就带图：传进 assets/、结局文案由服务端给", { timeout: 180_000 }, async () => {
    expect(existsSync(SERVER_ENTRY), `先 pnpm build 出 ${SERVER_ENTRY}`).toBe(true);

    const llm = await startMockModel();
    cleanup.push(() => llm.stop());
    log(`假模型端点：http://127.0.0.1:${llm.port}/v1（这个模型没有视觉能力，图片会被服务端退化成文字）`);

    const dataRoot = await mkdtemp(join(tmpdir(), "aiz-assets-"));
    cleanup.push(() => rm(dataRoot, { recursive: true, force: true }));
    await writeConfig(dataRoot, llm.port);
    log(`数据根：${dataRoot}`);

    const events = collect();
    const layer: ServerLayer = createServerLayer({
      aiZenDir: dataRoot,
      clientInfo: { name: "@ai-zen/desktop", version: "0.0.0-assets" },
      defaultCwd: () => dataRoot,
      push: events.push,
      serverEntry: SERVER_ENTRY,
      log: log,
    });
    cleanup.push(() => layer.dispose());

    await layer.start();
    log(`✓ 已连上（握手：${JSON.stringify(layer.hello())}）`);
    const facts = JSON.parse(await readFile(join(dataRoot, "run", "server.json"), "utf8")) as { pid: number };
    cleanup.push(() => {
      try {
        process.kill(facts.pid);
      } catch {
        // 已经退了
      }
    });

    // ---- 项目 + 会话（新建出来的是草稿：首次 send 才落库）-------------------------
    const projectCwd = join(dataRoot, "项目");
    await mkdir(projectCwd, { recursive: true });
    const workspace = (await layer.manager.invokeService("workspace", "create", "附件项目", projectCwd)) as {
      id: string;
    };
    const conversation = (await layer.manager.invokeService(
      "conversation",
      "create",
      workspace.id,
      "mock-agent",
    )) as { id: string };
    log(`✓ workspace.conversation → ${conversation.id}（刚建出来是草稿：首次 send 才落库）`);
    const beforeSend = (await layer.manager.invokeService("conversation", "list", workspace.id)) as unknown[];
    log(`✓ 发送之前侧栏里的对话数：${beforeSend.length}（草稿不列）`);
    expect(beforeSend).toEqual([]);

    // ---- 1. 新对话第一条就带一张图 -------------------------------------------
    events.clear();
    await layer.manager.invokeService("chat", "send", workspace.id, conversation.id, "这条是新对话的第一条，带一张图", [
      { mime: "image/png", name: "剪贴板图.png", data: PNG_BYTES },
    ]);
    await events.waitFor((event) => event.type === "done", 90_000);

    const draftOutcomes = attachmentsOf(events.events);
    log(`✓ 这一轮的事件：${events.events.map((event) => event.type).join(" → ")}`);
    log(`✓ 这一轮的附件结局：${JSON.stringify(draftOutcomes)}`);
    expect(draftOutcomes).toHaveLength(1);
    expect(draftOutcomes[0]?.deliveredAs).toBe("text_fallback");
    // `problem` 是服务端那份结构化原因（码 + 参数 + 已渲染的那句）：界面读 `message` 上屏
    expect(draftOutcomes[0]?.problem?.message ?? "").toContain("看不了图片");
    expect(draftOutcomes[0]?.problem?.message ?? "").toContain("剪贴板图.png");
    expect(draftOutcomes[0]?.problem?.code).toBeTruthy();
    log(`✓ 气泡上要显示的那句话（服务端渲染好的原文）：${JSON.stringify(draftOutcomes[0]?.problem)}`);

    const firstFiles = await listAssets(dataRoot);
    log(`✓ assets/ → ${JSON.stringify(firstFiles)}`);
    expect(firstFiles).toHaveLength(1);
    const stored = await stat(join(dataRoot, "assets", firstFiles[0] ?? ""));
    log(`✓ 落盘字节数：${stored.size}（输入 ${PNG_BYTES.byteLength}）`);
    expect(stored.size).toBe(PNG_BYTES.byteLength);

    // 上传把它落了库：带图的第一轮之后，这段对话已经进了侧栏列表
    const afterSend = (await layer.manager.invokeService("conversation", "list", workspace.id)) as Array<{ id: string }>;
    log(`✓ 这一轮之后侧栏里的对话：${JSON.stringify(afterSend.map((item) => item.id))}`);
    expect(afterSend.map((item) => item.id)).toContain(conversation.id);

    // ---- 2. 一次五张：前 4 张传上去，第 5 张逐张给一句话 -----------------------
    events.clear();
    await layer.manager.invokeService("chat", "send", workspace.id, conversation.id, "一次五张图", [
      ...Array.from({ length: 5 }, (_unused, index) => ({
        mime: "image/png",
        name: `第${index + 1}张.png`,
        data: PNG_BYTES,
      })),
    ]);
    await events.waitFor((event) => event.type === "done", 90_000);

    const outcomes = attachmentsOf(events.events);
    log(`✓ 五张图那一轮的附件结局：${JSON.stringify(outcomes)}`);
    expect(outcomes).toHaveLength(5);
    expect(outcomes.slice(0, 4).map((outcome) => outcome.deliveredAs)).toEqual([
      "text_fallback",
      "text_fallback",
      "text_fallback",
      "text_fallback",
    ]);
    // 第 5 张连 `asset.begin` 都没走到：它的那句话来自客户端库（与界面同一套措辞）
    expect(outcomes[4]?.deliveredAs).toBe("dropped");
    expect(outcomes[4]?.problem?.message ?? "").toContain("最多 4 张图片");
    expect(outcomes[4]?.name).toBe("第5张.png");

    const files = await listAssets(dataRoot);
    log(`✓ 两轮之后 assets/ 里的文件数：${files.length}（同一份字节只落一份，PRD F-H8 的全局去重）`);
    expect(files).toHaveLength(1);

    // ---- 3. 那条用户消息在历史里的样子（重开会话时气泡读的就是它）-----------------
    const state = (await layer.manager.invokeService("chat", "getState", workspace.id, conversation.id)) as {
      messages: Array<{ id: string; role: unknown; content?: unknown }>;
    };
    const lastUser = [...state.messages].reverse().find((message) => message.role === "user");
    log(`✓ 落库后的用户消息内容（节选）：${JSON.stringify(textOf(lastUser ?? {}).slice(0, 160))}`);
    expect(textOf(lastUser ?? {})).toContain("一次五张图");

    log("✓ 附件竖切全部通过");
  });
});

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function log(message: string): void {
  // 用例的输出就是交付报告里的那份证据：`vitest run` 会把它打出来
  console.log(message);
}

/** 事件流里 `attachments` 事件携带的那一种结局（拍平后逐个看） */
type OutcomeView = Extract<ChatStreamEvent, { type: "attachments" }>["attachments"][number];

/** 事件流里所有 `attachments` 事件的附件结局（拍平） */
function attachmentsOf(events: readonly ChatStreamEvent[]): OutcomeView[] {
  const collected: OutcomeView[] = [];
  for (const event of events) {
    if (event.type === "attachments") collected.push(...event.attachments);
  }
  return collected;
}

/** 数据根下 `assets/` 里的正式文件（`*.part` 是上传中的临时文件，不算） */
async function listAssets(dataRoot: string): Promise<string[]> {
  const dir = join(dataRoot, "assets");
  try {
    const names = await readdir(dir);
    return names.filter((name) => !name.startsWith(".")).sort();
  } catch {
    return [];
  }
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
    // 收下时拍一张快照：render 那边收到的是结构化克隆过的拷贝，用 `structuredClone` 收才与它一致
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

/** 一个假的 OpenAI 兼容端点：回一片正文就收尾（附件用例只关心这一轮能跑完） */
async function startMockModel(): Promise<{ port: number; stop: () => Promise<void> }> {
  const server: HttpServer = createHttpServer((request, response) => {
    if (!request.url?.endsWith("/chat/completions")) {
      response.writeHead(404).end();
      return;
    }
    let body = "";
    request.on("data", (chunk) => {
      body += String(chunk);
    });
    request.on("end", () => {
      if (!body.includes('"stream":true')) {
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
      response.write(chunk({ role: "assistant", content: "收到了" }));
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

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
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
            // 没有视觉能力：服务端会把图片退化成文字，于是气泡上有一句它渲染好的原因
            custom: true,
          },
        ],
        defaultModel: "mock-model",
        defaultAgent: "mock-agent",
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
        name: "附件助手",
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
