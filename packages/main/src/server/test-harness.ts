/**
 * 用例脚手架（**只被 `*.test.ts` 引用，不进生产打包图**）：一个真 daemon + 一个假 Agent。
 *
 * ## 为什么是「真 daemon + 假 Agent」
 *
 * 这一层要验的是**协议映射**：方法名、参数、返回形状、事件翻译。这四件事都发生在
 * socket 的另一侧，所以 daemon 必须是真的（真端口、真帧、真 SessionManager）；而 Agent
 * 本身（SDK 的流式循环、真模型请求）与映射无关，用假件才能精确控制「一轮什么时候开始、
 * 推了哪几片增量、什么时候收尾」。这也是 `agents/packages/client/src/sessions.test.ts`
 * 的标准写法。
 *
 * ## 假件的形状必须照抄真件
 *
 * `chunk-parsed` 是**两参**（`receiver, chunk`）、第二个才是 OpenAI 风格的 delta chunk；
 * 用户消息由 `send()` 自己追加、assistant 消息由流式解析追加 —— 服务端一行都不替 Agent
 * 做这些。假件少做一步，测出来的就是想象里的服务端。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConfigService,
  Daemon,
  FileSessionStore,
  SessionManager,
  createAgentHandlers,
  createConfigHandlers,
  createSessionHandlers,
  type AgentLike,
  type ModelLevel,
} from "@ai-zen/agents-server";
import { SocketServerClient, type ClientInfo } from "@ai-zen/agents-client";
// 只要类型：`AgentNS` 在本文件里全是类型位置。里面那几个 role/status 字面量走下面的
// `as AgentNS.Role / MessageStatus` 断言（与 `events.ts` 同一口径）：依赖图里不出现
// 「main → 整个模型库」这条运行期边
import type { AgentNS } from "@ai-zen/agents-core";
import { resolveModel, type AgentDefinition, type AppConfig } from "@ai-zen/agents-sdk";
import type { ChatStreamEvent } from "@ai-zen/desktop-shared";
import { createServerLayer, type ServerLayer } from "./index.js";

/** 握手时自称的身份（与桌面端一致，只进日志与服务端回执） */
export const CLIENT_INFO: ClientInfo = { name: "@ai-zen/desktop", version: "0.0.0-test" };

/** 测试里自动标题的返回值：服务端第一轮收尾后会发 `session.titleChanged` */
export const AUTO_TITLE = "自动起的名字";

/** 配置里那个模型 id（`conversation.create` 的 `modelId` 应该等于它） */
export const MODEL_ID = "model-x";

/**
 * 消息 role / status 的字面值（`as` 断言成 core 的枚举类型）。
 *
 * 为什么不写 `AgentNS.Role.User`：那要求**值导入** agents-core，而本层刻意只要类型
 * （见上面的 import 注释）。枚举是字符串枚举，字面值就是它们自己。
 */
const USER_ROLE = "user" as AgentNS.Role;
const ASSISTANT_ROLE = "assistant" as AgentNS.Role;
const TOOL_ROLE = "tool" as AgentNS.Role;
const COMPLETED_STATUS = "completed" as AgentNS.MessageStatus;

/**
 * 假 Agent：能跑一轮的最小面。
 *
 * 用例通过 {@link emitDelta} / {@link finish} 驱动「这一轮」的进展 —— 这正是真件里 SDK
 * 事件的那几个时刻（`open` / `chunk-parsed` / `finally`）。
 */
export class FakeAgent implements AgentLike {
  messages: AgentNS.Message[] = [];
  lastUsage: unknown = undefined;
  modelLevel: ModelLevel = "agent";
  model = MODEL_ID;
  modelConfig: Record<string, unknown> = {};
  /** 服务端从定义上取「生效模型 id」（`modelIdOf`），所以这里要有 */
  definition = { modelId: MODEL_ID, messages: [] as AgentNS.Message[] };
  tools: Array<{ function?: { name?: string } }> = [];
  client = {
    chat: { completions: { create: async () => ({ choices: [{ message: { content: AUTO_TITLE } }] }) } },
  };
  scope = { cwd: "" };
  /** 被 abort 过（`session.cancel` 的唯一可观测面） */
  aborted = false;
  /** 每一轮 `send()` 的入参，供断言「发的是什么」 */
  readonly sent: unknown[] = [];

  private readonly handlers = new Map<string, Set<(...args: any[]) => void>>();
  private readonly pending: Array<() => void> = [];
  private messageSeq = 0;

  readonly events = {
    on: (event: string, handler: (...args: any[]) => void) => {
      if (!this.handlers.has(event)) this.handlers.set(event, new Set());
      this.handlers.get(event)!.add(handler);
    },
    off: (event: string, handler: (...args: any[]) => void) => {
      this.handlers.get(event)?.delete(handler);
    },
  };

  /** 真件在 `send()` 里追加 user 消息；这里照做，否则快照里看不到用户说的话 */
  send(input: unknown): Promise<unknown> {
    this.sent.push(input);
    this.messages.push({
      id: this.nextId("user"),
      role: USER_ROLE,
      content: input as AgentNS.MessageContent,
    });
    return new Promise<unknown>((resolve) => this.pending.push(() => resolve([])));
  }

  abort(): void {
    this.aborted = true;
  }

  use(_plugin: unknown): void {}

  fire(event: string, ...args: unknown[]): void {
    for (const handler of this.handlers.get(event) ?? []) handler(...args);
  }

  /** 推一片增量（真件的形状：`chunk-parsed` 两参，第二个才是 delta chunk） */
  emitDelta(text: string, reasoning = ""): void {
    const receiver = this.streamingMessage();
    receiver.content = `${receiver.content ?? ""}${text}`;
    if (reasoning) receiver.reasoning_content = `${receiver.reasoning_content ?? ""}${reasoning}`;
    this.fire("chunk-parsed", receiver, {
      choices: [
        {
          delta: {
            ...(text ? { content: text } : {}),
            ...(reasoning ? { reasoning_content: reasoning } : {}),
          },
        },
      ],
    });
  }

  /** 往消息里塞一条工具结果（只有服务端才知道的东西，用例用它验「收尾补快照」） */
  pushToolResult(content: string): AgentNS.Message {
    const message: AgentNS.Message = {
      id: this.nextId("tool"),
      role: TOOL_ROLE,
      content,
      tool_call_id: "call_1",
      status: COMPLETED_STATUS,
    };
    this.messages.push(message);
    return message;
  }

  /** 本轮结束（真件的 `finally`）；`session.settleTurn` 由它触发 */
  finish(): void {
    this.fire("finally");
    this.pending.shift()?.();
  }

  /** 本轮出错（真件的 `error`）：服务端据此把 `turn.end` 标成 `ok:false` */
  fail(error: unknown): void {
    this.fire("error", error);
  }

  private streamingMessage(): AgentNS.Message {
    const last = this.messages[this.messages.length - 1];
    if (last?.role === ASSISTANT_ROLE) return last;
    const message: AgentNS.Message = {
      id: this.nextId("assistant"),
      role: ASSISTANT_ROLE,
      content: "",
    };
    this.messages.push(message);
    return message;
  }

  private nextId(kind: string): string {
    this.messageSeq += 1;
    return `${kind}_${this.messageSeq}`;
  }
}

export interface TestServer {
  /** 临时配置根（daemon 的 `aiZenDir`、工作区存档、config.json、agents/ 都在它下面） */
  dir: string;
  /** 用例里当工作目录用的那个目录（真的存在） */
  projectDir: string;
  agent: FakeAgent;
  daemon: Daemon;
  /** 门面：`invokeService` 的动态分发入口 */
  layer: ServerLayer;
  /** 门面推给 render 的全部事件（按到达顺序） */
  pushed: ChatStreamEvent[];
  /** 走原始协议（准备数据 / 验服务端侧事实时用，例如 `saveAs`、`snapshot`） */
  call: <T>(method: string, params?: unknown) => Promise<T>;
  stop: () => Promise<void>;
}

export interface TestServerOptions {
  /**
   * 注入自动标题（缺省不注入 = 服务端不做自动标题）。
   *
   * 它与被测的映射无关，而且是在 `turn.end` **之后**异步跑的后台动作；不测标题的用例
   * 开着它，就会在拆服务端时与那次写档撞上（服务端会对着已经关掉的会话推通知）。
   */
  autoTitle?: boolean;
}

/**
 * 起一个测试用服务端并让门面连上去。
 *
 * 每个用例各起一个（临时目录 + `port: 0`），互不共享发现文件与存档 —— 用例之间没有
 * "上一个留下的环境"这种隐性状态。
 */
export async function startTestServer(options: TestServerOptions = {}): Promise<TestServer> {
  const dir = mkdtempSync(join(tmpdir(), "aiz-desktop-main-"));
  const projectDir = join(dir, "proj");
  mkdirSync(projectDir, { recursive: true });
  seedConfig(dir);

  // 先造配置服务：下面的存档条目解析器要用它读定义与全局兜底（顺序不能反）
  const config = new ConfigService({
    configFile: join(dir, "config.json"),
    agentsDir: join(dir, "agents"),
    subAgentsDir: join(dir, "sub-agents"),
    globalMcpFile: join(dir, "mcp.json"),
    workspacesRoot: join(dir, "workspaces"),
  });

  const agent = new FakeAgent();
  let seq = 0;
  const manager = new SessionManager({
    // 假件必须照抄真件这一处：SDK 的 `createAgent` 递给 Agent 的是**解析之后**的定义
    // （三级里赢了的那一档已经写进 `definition.modelId`，`modelLevel` 说清是哪一档）。
    // 服务端的 `SessionListEntry.effectiveModelId` 正是从这里取的（`modelIdOf`），
    // 假件不跟着入参走，「有会话级覆盖」就永远测不出覆盖值
    createAgent: async (input) => {
      agent.definition.modelId = input.modelId ?? MODEL_ID;
      agent.modelLevel = input.modelId ? "session" : "agent";
      return agent;
    },
    nextSessionId: () => `chat_${++seq}`,
    storeFor: (workspaceId) =>
      new FileSessionStore({ rootDir: join(dir, "workspaces", workspaceId) }),
    // 真件由组装根注入（`createAutoTitle`）；这里只验「服务端起了名之后客户端怎么翻」
    ...(options.autoTitle ? { autoTitle: async () => AUTO_TITLE } : {}),
    // 存档条目的生效模型：照抄组装根（`agents` 仓的 `cli.ts`）那一份。不注入的话，存档
    // 条目的 `effectiveModelId` 永远被省略 —— 那会把「侧栏对历史会话显示模型」这条路
    // 测成一个假现象（真实部署里它是有的）
    resolveSessionModel: async ({ agentId, sessionModelId }) => {
      const definition = (await config.getAgent({ id: agentId })).agent as AgentDefinition | null;
      // 定义已删：与 `createAgent` 同一口径（它也认为这段会话装不起来）。抛而不是退到
      // 全局兜底 —— 一条指着已删定义的存档没有「生效模型」可言
      if (!definition) throw new Error(`Agent "${agentId}" not found`);
      const { config: appConfig } = await config.get();
      const resolved = resolveModel({
        sessionModelId,
        agentModelId: definition.modelId,
        defaultModel: (appConfig as AppConfig).defaultModel,
      });
      if (!resolved) throw new Error(`Agent "${agentId}" has no model bound`);
      return resolved;
    },
  });

  const daemon = new Daemon({
    aiZenDir: dir,
    port: 0,
    version: "0.0.0-test",
    handlers: {
      ...createSessionHandlers({
        manager,
        workspacesRoot: join(dir, "workspaces"),
        defaultWorkspacePath: projectDir,
      }),
      ...createAgentHandlers({
        // 只有 `agent.model.set` 用它（写定义 + 清思考参数）；这一阶段没有 render 面
        // 调它，用例也不需要它真去改定义，所以给一个记录用的最小实现
        factory: { setModel: async ({ agentId, modelId }) => ({ agentId, modelId }) },
        config,
      }),
      ...createConfigHandlers({ config }),
    },
  });
  await daemon.start();

  const client = await SocketServerClient.connect({
    address: { host: "127.0.0.1", port: daemon.port },
    client: CLIENT_INFO,
  });
  const pushed: ChatStreamEvent[] = [];
  const layer = createServerLayer({
    aiZenDir: dir,
    clientInfo: CLIENT_INFO,
    defaultCwd: () => projectDir,
    push: (event) => pushed.push(event),
    client,
  });
  await layer.start();

  return {
    dir,
    projectDir,
    agent,
    daemon,
    layer,
    pushed,
    call: async <T>(method: string, params?: unknown) => await client.call<T>(method, params),
    stop: async () => {
      layer.dispose();
      client.close();
      manager.dispose();
      await daemon.stop("test teardown");
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * 轮询到条件成立（**不用固定 sleep**：等待时长取决于机器，写死一个数字只会在慢机器上
 * 间歇红、在快机器上空等）。
 *
 * 支持异步判据：「等侧栏看到 running」本来就要再问一次服务端，写成同步函数会让用例
 * 拿一个永远为真的 Promise 当结果（那就等于没等）。
 */
export async function waitFor<T>(
  check: () => T | undefined | false | Promise<T | undefined | false>,
  what: string,
): Promise<T> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`等待超时：${what}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/** 造一份最小配置 + 两个 Agent 定义（入口 Agent 与子 Agent 各一份，验"只列入口"） */
function seedConfig(dir: string): void {
  mkdirSync(join(dir, "agents"), { recursive: true });
  mkdirSync(join(dir, "sub-agents"), { recursive: true });
  writeFileSync(
    join(dir, "config.json"),
    JSON.stringify({
      endpoints: [
        { id: "e1", name: "端点一", baseUrl: "http://127.0.0.1:9/v1", apiKey: "key-1" },
        { id: "e2", name: "端点二", baseUrl: "http://127.0.0.1:9/v2", apiKey: "key-2" },
      ],
      models: [{ id: MODEL_ID, name: "模型 X", endpointId: "e1", tokenThresholds: { handoff: 1, guard: 2 } }],
      defaultModel: MODEL_ID,
      defaultAgent: "default",
      version: 4,
    }),
  );
  writeFileSync(
    join(dir, "agents", "default.json"),
    JSON.stringify({
      id: "default",
      name: "默认助手",
      description: "入口 Agent",
      modelId: MODEL_ID,
      messages: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }),
  );
  writeFileSync(
    join(dir, "sub-agents", "helper.json"),
    JSON.stringify({
      id: "helper",
      name: "帮手",
      description: "子 Agent",
      function: { name: "call_helper" },
      messages: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }),
  );
}
