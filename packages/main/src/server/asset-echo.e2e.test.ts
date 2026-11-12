/**
 * **图片回显竖切（e2e）**：发一条带图消息 → 重开这段对话 → 按段上的素材引用把字节取回来。
 *
 * 与 `slice.e2e.test.ts` / `attachments.e2e.test.ts` 同口径、同样不跑就跳过（`AI_ZEN_SLICE=1`）：
 * 要 `dist/server.mjs`（随包分发的那份服务端）、一个假的 OpenAI 兼容端点、一个临时数据根。走的
 * 是**生产路径**：`createServerLayer` → `ensureServer`（本机发现文件 / 拉起 / 握手）→ 六个 Service
 * → 三段式上传 → `chat.getState`（重开时 render 读的就是它）→ `chat.getAsset`。
 *
 * ## 它钉住的三件事（W13-B 的桌面侧契约）
 *
 *   1. **消息里只有段上的素材引用**：重开对话拿到的 `image_url` 段，`url` 是空串、带 `__asset_id`
 *      —— 没有 `asset://`、没有 base64、没有 `assets/` 下的绝对路径；
 *   2. **按 id 能把字节取回来**：`thumb` / `original` 两档都回同一份字节，与发上去的那张逐字节相等
 *      （服务端这一波两档等同原图，PRD F-H8）；
 *   3. **取回的这一份是「重开之后」的**：先关掉这一层、按 `run/server.json` 连回来再取 —— 气泡里
 *      的图因此不是「这一轮缓存在内存里的产物」，而是从 `assets/` 里重新读出来的。
 */

import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

describe.runIf(ENABLED)("图片回显竖切：发图 → 重开 → 按素材 id 取回字节", () => {
  const cleanup: Array<() => Promise<void> | void> = [];

  afterAll(async () => {
    for (const step of cleanup.reverse()) await step();
  });

  it("重开对话之后仍能从 assets/ 取回那一张", { timeout: 180_000 }, async () => {
    expect(existsSync(SERVER_ENTRY), `先 pnpm build 出 ${SERVER_ENTRY}`).toBe(true);

    const llm = await startMockModel();
    cleanup.push(() => llm.stop());
    log(`假模型端点：http://127.0.0.1:${llm.port}/v1（这个模型没有视觉能力，图片会被服务端退化成文字）`);

    const dataRoot = await mkdtemp(join(tmpdir(), "aiz-echo-"));
    cleanup.push(() => rm(dataRoot, { recursive: true, force: true }));
    await writeConfig(dataRoot, llm.port);
    log(`数据根：${dataRoot}`);

    const events = collect();
    let layer: ServerLayer = createServerLayer({
      aiZenDir: dataRoot,
      clientInfo: { name: "@ai-zen/desktop", version: "0.0.0-echo" },
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

    // ---- 1. 项目 + 会话 + 一条带图的消息 ---------------------------------------
    const projectCwd = join(dataRoot, "项目");
    await mkdir(projectCwd, { recursive: true });
    const workspace = (await layer.manager.invokeService("workspace", "create", "回显项目", projectCwd)) as {
      id: string;
    };
    const conversation = (await layer.manager.invokeService(
      "conversation",
      "create",
      workspace.id,
      "mock-agent",
    )) as { id: string };

    events.clear();
    await layer.manager.invokeService("chat", "send", workspace.id, conversation.id, "这条带一张图", [
      { mime: "image/png", name: "剪贴板图.png", data: PNG_BYTES },
    ]);
    await events.waitFor((event) => event.type === "done", 90_000);
    log(`✓ 发完了：${events.events.map((event) => event.type).join(" → ")}`);

    // ---- 2. 关掉这一层，再按 run/server.json 连回来（= 重开 App / 重开对话）-------
    layer.dispose();
    layer = createServerLayer({
      aiZenDir: dataRoot,
      clientInfo: { name: "@ai-zen/desktop", version: "0.0.0-echo" },
      defaultCwd: () => dataRoot,
      push: () => {},
      serverEntry: SERVER_ENTRY,
      log: log,
    });
    await layer.start();
    log("✓ 重开之后已按 run/server.json 连回同一个服务端");

    const state = (await layer.manager.invokeService(
      "chat",
      "getState",
      workspace.id,
      conversation.id,
    )) as { messages: Array<{ id: string; role: unknown; content?: unknown }> };
    const lastUser = [...state.messages].reverse().find((message) => message.role === "user");
    const sections = sectionsOf(lastUser?.content);
    log(`✓ 重开之后这条用户消息的段：${JSON.stringify(sections)}`);
    const imageSection = sections.find((section) => section.type === "image_url");
    if (!imageSection) throw new Error("这条用户消息里没有 image_url 段");

    // 段上只有本地扩展字段：真字段（`url`）是空的，没有任何假 scheme / base64 / 绝对路径
    expect(imageSection.image_url?.url).toBe("");
    expect(typeof imageSection.__asset_id).toBe("string");
    expect(JSON.stringify(imageSection)).not.toContain("asset://");
    expect(JSON.stringify(imageSection)).not.toContain("data:");
    expect(JSON.stringify(imageSection)).not.toContain(dataRoot);
    const assetId = imageSection.__asset_id ?? "";
    log(`✓ 段上的素材引用：__asset_id=${assetId}（url 为空串，没有 base64 / 绝对路径）`);

    // ---- 3. 按 id 取字节（气泡要显示的两档）-------------------------------------
    for (const variant of ["thumb", "original"] as const) {
      const content = (await layer.manager.invokeService("chat", "getAsset", assetId, variant)) as {
        mime: string;
        bytes: Uint8Array;
      };
      log(
        `✓ asset.get(${variant}) → ${content.mime}，${content.bytes.byteLength} 字节` +
          `（发上去的是 ${PNG_BYTES.byteLength} 字节，PngSignature=${Array.from(content.bytes.slice(0, 4)).join(",")}）`,
      );
      expect(content.mime).toBe("image/png");
      expect(Array.from(content.bytes)).toEqual(Array.from(PNG_BYTES));
    }

    layer.dispose();
    log("✓ 图片回显竖切全部通过");
  });
});

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function log(message: string): void {
  // 用例的输出就是交付报告里的那份证据：`vitest run` 会把它打出来
  console.log(message);
}

/** 消息内容段（字符串正文 / 没有内容时是空数组） */
interface SectionView {
  type?: string;
  __asset_id?: string;
  image_url?: { url?: string };
}

function sectionsOf(content: unknown): SectionView[] {
  if (!Array.isArray(content)) return [];
  return content as SectionView[];
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

/** 一个假的 OpenAI 兼容端点：只回 `/chat/completions` 的流式两片正文 */
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
      const streaming = body.includes('"stream":true');
      if (!streaming) {
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
      response.write(chunk({ role: "assistant", content: "看到" }));
      response.write(chunk({ content: "这张图了" }));
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
            custom: true,
          },
        ],
        defaultModel: "mock-model",
        defaultAgent: "mock-agent",
        // 关掉自动取名：它会多打一次模型（这条竖切不验它）
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
        name: "回显助手",
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
