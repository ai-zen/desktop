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
  EventHub,
  FileSessionStore,
  SESSION_METHODS,
  SessionManager,
  createAgentHandlers,
  createConfigHandlers,
  createSessionHandlers,
  type AgentLike,
  type CreateAgentInput,
  type MethodHandler,
  type ModelLevel,
  type SessionAnswerParams,
  type SessionAnswerResult,
  type SubAgentSnapshotParams,
  type SubAgentSnapshotResult,
} from "@ai-zen/agents-server";
import { SocketServerClient, type ClientInfo, type ServerClient } from "@ai-zen/agents-client";
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
 * core 风格的最小事件面（`events.on` / `events.off` + 一个 `fire`）：假 Agent 与假子 Agent 共用。
 *
 * `on` / `off` 是 core 的 `Agent.events` 真有的两个方法（服务端只挂这两个）；`fire` 是假件
 * 才有的那一半 —— 真件里由 core 在恰当时刻广播，这里由用例决定「什么时候推哪一片」。
 * 子 Agent 的那条流（`chunk-parsed` / `error`）与主 Agent 走同一个形状：服务端给子 Agent
 * 挂的就是这两个监听（`SessionManager` 的 `onSubStart`）。
 */
class EventBus {
  private readonly handlers = new Map<string, Set<(...args: any[]) => void>>();

  readonly events = {
    on: (event: string, handler: (...args: any[]) => void) => {
      if (!this.handlers.has(event)) this.handlers.set(event, new Set());
      this.handlers.get(event)!.add(handler);
    },
    off: (event: string, handler: (...args: any[]) => void) => {
      this.handlers.get(event)?.delete(handler);
    },
  };

  fire(event: string, ...args: unknown[]): void {
    for (const handler of this.handlers.get(event) ?? []) handler(...args);
  }
}

/**
 * 假子 Agent：一个子 Agent 能提供的最小面（`messages` + `events`）。
 *
 * 形状照抄真件的 `SubAgentLike`（`SessionManager` 从 `sub-agent-start` 的载荷里只取这两样）：
 * 服务端给它挂 `chunk-parsed` / `error` 两个监听，并在 `session.subAgent.snapshot` 里把它
 * **自己的** `messages` 原样交出去。所以这里要的正是「一个消息表 + 一条事件流」。
 */
export class FakeSubAgent extends EventBus {
  messages: AgentNS.Message[] = [];
  private messageSeq = 0;

  /**
   * 推一片增量（与主 Agent 的 `emitDelta` 同形：`chunk-parsed` 两参，第一个是那条正在拼的
   * assistant 消息，第二个才是 OpenAI 风格的 delta chunk）。
   */
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

  /** 子 Agent 出错（真件里是它自己的 `error` 事件）：服务端据此把它标成 `failed` */
  fail(error: unknown): void {
    this.fire("error", error);
  }

  /** 追加一条自己历史里的消息（子任务的用户消息 / 上一轮工具结果这类：只有快照里有） */
  pushMessage(role: AgentNS.Role, content: string): AgentNS.Message {
    const message: AgentNS.Message = { id: this.nextId(role), role, content };
    this.messages.push(message);
    return message;
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
    return `sub-${kind}_${this.messageSeq}`;
  }
}

/**
 * 假 Agent：能跑一轮的最小面。
 *
 * 用例通过 {@link emitDelta} / {@link finish} 驱动「这一轮」的进展 —— 这正是真件里 SDK
 * 事件的那几个时刻（`open` / `chunk-parsed` / `finally`）。
 */
export class FakeAgent extends EventBus implements AgentLike {
  messages: AgentNS.Message[] = [];
  /**
   * 最近一轮用量。
   *
   * 类型跟着 `AgentLike` 走（`Usage | undefined`，不再是 `unknown`）：服务端的端口已经把它
   * 声明成具名类型，假件若还写 `unknown`，`implements AgentLike` 就不成立 —— 而那个错会
   * 被推给每一个用到 `createAgent` 的地方，掩盖真正想测的东西。
   */
  lastUsage: AgentNS.Usage | undefined = undefined;
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

  private readonly pending: Array<() => void> = [];
  private messageSeq = 0;

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

  /**
   * 推一片工具调用（真件的形状，见 core 的 `Agent.parseStreamData`）。
   *
   * 与 {@link emitDelta} 同一个套路：**先改 receiver，再 fire 同一片 delta**。两处细节照抄
   * core，否则测出来的就是想象里的服务端：
   *
   *   - 服务端读的是**第一个参数**（`receiver.tool_calls[index]`），不是 chunk —— 组装态在
   *     receiver 上，chunk 只是这一片原始数据；
   *   - 参数是**累积**的：首片带 `index` / `id` / `name`，之后只带参数片段，core 往
   *     `function.arguments` 后面接。所以这里也接，而不是覆盖。
   */
  emitToolCall(chunk: { index?: number; id?: string; name?: string; arguments?: string }): void {
    const index = chunk.index ?? 0;
    const receiver = this.streamingMessage();
    receiver.tool_calls ??= [];
    receiver.tool_calls[index] ??= { index, function: { name: "", arguments: "" } };
    const call = receiver.tool_calls[index]!;
    if (chunk.id) call.id = chunk.id;
    if (chunk.name) call.function!.name = chunk.name;
    if (chunk.arguments) {
      call.function!.arguments = `${call.function?.arguments ?? ""}${chunk.arguments}`;
    }
    this.fire("chunk-parsed", receiver, {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index,
                ...(chunk.id ? { id: chunk.id } : {}),
                function: {
                  ...(chunk.name ? { name: chunk.name } : {}),
                  ...(chunk.arguments ? { arguments: chunk.arguments } : {}),
                },
              },
            ],
          },
        },
      ],
    });
  }

  /**
   * 往消息里塞一条工具结果（只有服务端才知道的东西）。
   *
   * 两种用法：单独用 = 验「收尾那次快照把它补齐」；配合 {@link endToolCall} = 验「工具跑完
   * 那一刻就上屏」（服务端那一刻才推 `session.messageAppended`）。
   */
  pushToolResult(content: string, name?: string): AgentNS.Message {
    const message: AgentNS.Message = {
      id: this.nextId("tool"),
      role: TOOL_ROLE,
      content,
      tool_call_id: "call_1",
      ...(name ? { name } : {}),
      status: COMPLETED_STATUS,
    };
    this.messages.push(message);
    return message;
  }

  /**
   * 一个工具跑完了：把 core 那一刻的 `tool-call-end` 发出去（服务端据此推工具结果）。
   *
   * 形状照抄真件的 `markResult`（`packages/core/src/Agent.ts`，载荷类型
   * `AgentNS.ToolCallEndContext`）：**三个字段** `{ agent, toolCall, result }`，而且
   * `result.status` 在 fire **之前**就已经翻成终态。两处都不能省：
   *
   *   - 服务端推 `session.messageAppended` 的判据是「这条消息定型了吗」
   *     （`FINISHED_STATUSES`），先 fire 后翻状态就等于让用例造一个真件里不存在的时序；
   *   - `result` 就是刚定型的那条消息**本身**，服务端推上线时直接搬它（不重新包装）。
   *     用例传的就是 {@link pushToolResult} 返回的那个对象 —— 它已经进了 `messages`，
   *     与真件里「执行前先 append、跑完就地翻终态」是同一个位置。
   *
   * 为什么 `toolCall` 只填 `id` / `type` / `function.name`：`markResult` 把**任务本身**
   * （`PendingTask.function`）递出去，这里没有真调用的入参可填，而服务端今天不读它 ——
   * 但字段形状不能省，否则将来有人真的去读 `event.toolCall` 时，用例仍然是绿的。
   */
  endToolCall(message: AgentNS.Message, status: AgentNS.MessageStatus = COMPLETED_STATUS): void {
    message.status = status;
    this.fire("tool-call-end", {
      agent: this,
      toolCall: {
        id: message.tool_call_id,
        type: "function",
        function: { name: message.name },
      },
      result: message,
    });
  }

  /**
   * 一个子 Agent 开工（真件的 `sub-agent-start`）。
   *
   * 载荷就是 core 的 `SubAgentContext` 里服务端真正读的那两样：`{ agent, subAgent }`
   * （`SessionManager` 的 `onSubStart` 只解构 `subAgent`）。真件里这个对象还带
   * `toolCallContext`，但服务端一个字段都不从那里取 —— 在这里编一个半截的上下文，只会让
   * 「假件比真件多的东西」变成下一个人要猜的负担。
   */
  startSubAgent(subAgent: FakeSubAgent = new FakeSubAgent()): FakeSubAgent {
    this.fire("sub-agent-start", { agent: this, subAgent });
    return subAgent;
  }

  /** 一个子 Agent 跑完了（真件的 `sub-agent-end`，SDK 在子 Agent 收尾时广播） */
  endSubAgent(subAgent: FakeSubAgent): void {
    this.fire("sub-agent-end", { agent: this, subAgent });
  }

  /** 本轮结束（真件的 `finally`）；`session.settleTurn` 由它触发 */
  finish(): void {
    this.fire("finally");
    this.pending.shift()?.();
  }

  /** 本轮出错（真件的 `error`）：服务端据此把 `session.turnEnd` 标成 `ok:false` */
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
  /**
   * **最近一次**交给会话层装配的假 Agent（= 最后一段会话那个）。
   *
   * 只开一段会话的用例都用它；要同时驱动两段会话的用例读 {@link agents}（见
   * `TestServerOptions.freshAgentPerSession`）。
   */
  agent: FakeAgent;
  /**
   * 每次 `createAgent` 交给会话层的那台假件（按先后）。
   *
   * 缺省共用同一台（`agents[i]` 都是同一个对象）—— 只开一段会话时那就是全部；
   * `freshAgentPerSession` 打开时每段会话一台，于是「谁在说话」这件事在服务端就不会混。
   */
  agents: FakeAgent[];
  daemon: Daemon;
  /** 门面：`invokeService` 的动态分发入口 */
  layer: ServerLayer;
  /** 门面推给 render 的全部事件（按到达顺序） */
  pushed: ChatStreamEvent[];
  /**
   * 会话层交给 Agent 装配的入参（每次 `createAgent` 一条，按先后）。
   *
   * 里面有 `resolveMode`：真件里 SDK 的自动迁移插件在上下文到阈值时调它，服务端因此向
   * 客户端提问（`session.question`）。假 Agent 不会自己跑到那一步，用例只能从这里取那**
   * 一个函数**来发起提问 —— 见 `events.test.ts` 的 `askHandoffMode`。
   */
  agentInputs: CreateAgentInput[];
  /** `session.answer` 的**入参**记录（服务端 handler 里记的：这是「客户端真的答了」的证据） */
  answerCalls: SessionAnswerParams[];
  /** `session.answer` 的**回执**（`answered:false` = 来晚了；抛错的那次不会进这里） */
  answerResults: SessionAnswerResult[];
  /**
   * `session.subAgent.snapshot` 的**入参**记录（每次调用一条，按先后）。
   *
   * 「`started` 一到就去拉一次快照」在客户端那一侧只有一个往返可看，屏幕上什么都没变 ——
   * 所以判据只能是「服务端确实收到过这条请求」。
   */
  subAgentSnapshotCalls: SubAgentSnapshotParams[];
  /** 走原始协议（准备数据 / 验服务端侧事实时用，例如 `saveAs`、`snapshot`） */
  call: <T>(method: string, params?: unknown) => Promise<T>;
  /**
   * 把服务端**重启一次**：在一个**新的**监听实例上重新起一遍（同一个 `aiZenDir`、同一份
   * 业务状态），发现文件跟着换成新端口。
   *
   * 为什么不是 `stop()` 再 `start()` 同一个 `Daemon`：`stop()` 之后那个实例的 `stopping`
   * 已经落定（它是单飞闸门），再 `stop()` 会拿到一个「已经停了」的旧 promise，于是第二次
   * 收摊是空操作 —— 测试进程里留一个还在监听的 socket。换一个实例既干净，也真的就是
   * 「重启」：新进程、新端口、新发现文件，而 `SessionManager` / `ConfigService`（业务状态）
   * 由本脚手架持有、跟着活下来。
   *
   * 用例拿它复现那个审计确认过的真 bug：daemon 重启后桌面端还能不能自己长回来。
   */
  restart: () => Promise<void>;
  /**
   * 服务端的事件出口（会话事件与服务端通知共用这一条线）。
   *
   * 为什么脚手架要把它递出来：**服务端通知今天没有生产者**。协议里那两个 code
   * （`mcpUnavailable` / `storeUnavailable`）由组装根在发现 MCP / 存档不可用时发，而这件事
   * 在桌面端与 `agents` 的服务端入口里都还没接上。真件里这一行是 `hub.publish({ event:
   * SERVER_EVENTS.notice, … })`（见 `SessionManager` 的 `notice()` 注释：「服务端通知不归这里
   * 管 —— 那是服务本身的事，由组装根直接往 hub 里发」），而本脚手架**就是**那个组装根（它
   * 自己也 `new SessionManager` 并注入 hub）。所以用例在这里发一条，走的是真链路：hub → 真
   * socket → 桌面端的事件翻译；没有替任何一侧演动作。
   */
  hub: EventHub;
  stop: () => Promise<void>;
}

export interface TestServerOptions {
  /**
   * 注入自动标题（缺省不注入 = 服务端不做自动标题）。
   *
   * 它与被测的映射无关，而且是在 `session.turnEnd` **之后**异步跑的后台动作；不测标题的用例
   * 开着它，就会在拆服务端时与那次写档撞上（服务端会对着已经关掉的会话推通知）。
   */
  autoTitle?: boolean;
  /**
   * 等客户端回答 `session.question` 的时限（缺省是服务端的 5 分钟）。
   *
   * 用例把它**调大**才有意义：提问方在几毫秒内就回来了，说明答案来自客户端而不是超时兜底。
   * 调小则用来「让一个答失败的问题自己收场」，用例不必等。
   */
  askTimeoutMs?: number;
  /**
   * 让 `session.answer` 抛错（返回那个错，不返回就不抛）。
   *
   * 用它在**确定性**的时机复现「回答失败」：真事里那种失败（会话刚被收掉）取决于
   * 「客户端答得快还是会话关得快」，写成竞态就不再是判据。
   */
  failAnswerWith?: () => Error;
  /**
   * 让 `session.subAgent.snapshot` 的**回程**变慢：返回一个 promise，用例自己决定何时放行。
   *
   * 用它确定地复现真事里那条竞态：快照的往返可能比第一批增量还慢（子任务越小越明显）。
   * 请求**那一刻**的结果先取出来并定格（真件里那一帧就是那一刻的副本），只是送回客户端的
   * 时间被人为推后 —— 于是「先推增量、快照后到且更短」这件事一定会发生，不用凑时序。
   */
  holdSubAgentSnapshot?: () => Promise<void>;
  /**
   * 每段会话各配一台假 Agent（缺省共用一台）。
   *
   * 什么时候需要它：同时驱动**两段会话**的用例（并发 / 互不串台）。共用一台的话，两段
   * 会话在服务端就听着同一条 `chunk-parsed` —— 一条增量会被推成两条事件（各带一个
   * `sessionId`），于是「客户端把两段会话搞混了」与「检查脚手架把一台 Agent 给了两段会话」
   * 长得一模一样。真件里每段会话一个 Agent（`createAgent` 一次一个），所以这也更接近真件。
   */
  freshAgentPerSession?: boolean;
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

  /** 缺省那台「所有会话共用」的假 Agent（`freshAgentPerSession` 时不用它） */
  const sharedAgent = new FakeAgent();
  /** 每次装配交出去的那台（按先后；缺省全是 `sharedAgent`） */
  const agents: FakeAgent[] = [];
  let seq = 0;
  /** 会话层的事件出口（注入进去，用例才能发全局通知，见 `TestServer.hub`） */
  const hub = new EventHub();
  /** 会话层每次交给 Agent 装配的入参（含 `resolveMode`，见 `TestServer.agentInputs`） */
  const agentInputs: CreateAgentInput[] = [];
  const answerCalls: SessionAnswerParams[] = [];
  const answerResults: SessionAnswerResult[] = [];
  const subAgentSnapshotCalls: SubAgentSnapshotParams[] = [];
  const manager = new SessionManager({
    // 组装根会传自己的 hub，这样**全局通知**也走同一条推送线（见 `SessionManagerOptions.hub`）
    hub,
    // 假件必须照抄真件这一处：SDK 的 `createAgent` 递给 Agent 的是**解析之后**的定义
    // （三级里赢了的那一档已经写进 `definition.modelId`，`modelLevel` 说清是哪一档）。
    // 服务端的 `SessionListEntry.effectiveModelId` 正是从这里取的（`modelIdOf`），
    // 假件不跟着入参走，「有会话级覆盖」就永远测不出覆盖值
    createAgent: async (input) => {
      agentInputs.push(input);
      const agent = options.freshAgentPerSession ? new FakeAgent() : sharedAgent;
      agent.definition.modelId = input.modelId ?? MODEL_ID;
      agent.modelLevel = input.modelId ? "session" : "agent";
      agents.push(agent);
      return agent;
    },
    nextSessionId: () => `chat_${++seq}`,
    ...(options.askTimeoutMs !== undefined ? { askTimeoutMs: options.askTimeoutMs } : {}),
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

  const handlers: Record<string, MethodHandler> = {
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
  };

  /**
   * 在服务端这一侧记下 `session.answer`（并可选地弄坏它）。
   *
   * 为什么记在这里而不是看提问方的返回值：「跳过」的兜底值也是 `null`，光看
   * `askHandoffMode` 回来的是 `null` 分辨不出「客户端答了」与「等到超时了」。**服务端
   * 收到过这条请求**（`answerCalls`）且**认领了它**（`answered: true`）才是那个判据。
   */
  const answerHandler = handlers[SESSION_METHODS.answer]!;
  handlers[SESSION_METHODS.answer] = async (params, connection) => {
    answerCalls.push(params as SessionAnswerParams);
    const failure = options.failAnswerWith?.();
    if (failure) throw failure;
    const result = (await answerHandler(params, connection)) as SessionAnswerResult;
    answerResults.push(result);
    return result;
  };

  /**
   * 子 Agent 快照：记下入参，并可选择地把**回程**推迟到用例放行（见 `holdSubAgentSnapshot`）。
   *
   * 结果先取出来再 `structuredClone` 定格：真件里这一帧就是「服务端处理请求那一刻」的副本
   * （`messages` 数组当场复制、立刻序列化上线），之后子 Agent 继续吐字也不会让它变。用例把
   * 回程推后之后，这个定格才真的能被观察到（否则慢下来的那一帧会带去更长的新内容）。
   */
  const subAgentSnapshotHandler = handlers[SESSION_METHODS.subAgentSnapshot]!;
  handlers[SESSION_METHODS.subAgentSnapshot] = async (params, connection) => {
    subAgentSnapshotCalls.push(params as SubAgentSnapshotParams);
    const result = structuredClone(
      await subAgentSnapshotHandler(params, connection),
    ) as SubAgentSnapshotResult;
    if (options.holdSubAgentSnapshot) await options.holdSubAgentSnapshot();
    return result;
  };

  /**
   * 当前那个监听实例（`restart()` 之后会换成新的一个，所以这里是 `let` + getter）。
   *
   * 用例读它多半是为了看 `port` / `connectionCount` 这类「服务端那一侧」的事实。
   */
  let daemon = new Daemon({
    aiZenDir: dir,
    port: 0,
    version: "0.0.0-test",
    handlers,
  });
  await daemon.start();

  /**
   * 走原始协议的那条连接（`TestServer.call` 用）。
   *
   * 它**不订阅事件**，只发请求，所以「断了就重建」在这里就是两行：发现 `closed` 就重连一次。
   *
   * 为什么它把着**第二条**连接：桌面端那一条由 `createServerLayer` 自己扫发现文件建（见下），
   * 而验证方要直接问服务端一些「客户端不该知道的事」（`session.saveAs` 的原始回执、存档里
   * 那份 `updatedAt` …）。两条连接互不干涉：事件只推给 watch 过的那一条。
   */
  let probe: ServerClient | null = null;
  const probeClient = async (): Promise<ServerClient> => {
    if (probe && !probe.closed) return probe;
    probe = await SocketServerClient.connect({
      address: { host: "127.0.0.1", port: daemon.port },
      client: CLIENT_INFO,
    });
    return probe;
  };

  const pushed: ChatStreamEvent[] = [];
  /**
   * 门面自己扫发现文件（`<dir>/run/server.json`）连上来 —— 与桌面端走的是**同一条**路。
   *
   * 为什么不再注入一条现成的连接：注进去的连接只会被用一辈子（`ServerConnection` 对注入的
   * 那一条不重建），于是「daemon 重启之后自己长回来」这条路在用例里永远是假的。走发现文件
   * 之后，`restart()` 换掉端口，门面下一次取用时自然连到新的那个 —— 被测的正是生产里那一条。
   */
  const layer = createServerLayer({
    aiZenDir: dir,
    clientInfo: CLIENT_INFO,
    defaultCwd: () => projectDir,
    push: (event) => pushed.push(event),
  });
  await layer.start();

  return {
    dir,
    projectDir,
    get agent() {
      // 还没装配过任何会话时给那台「共用」的：用例常常先往它身上塞预设消息
      // （`server.agent.messages = [...]`）再建会话，而那台就是接下来要交出去的那台
      return agents[agents.length - 1] ?? sharedAgent;
    },
    agents,
    get daemon() {
      return daemon;
    },
    layer,
    pushed,
    agentInputs,
    answerCalls,
    answerResults,
    subAgentSnapshotCalls,
    call: async <T>(method: string, params?: unknown) =>
      await (await probeClient()).call<T>(method, params),
    hub,
    restart: async () => {
      await daemon.stop("test restart");
      /**
       * 先等**客户端这一侧**把断开通知处理完，再起新 daemon。
       *
       * 两个 socket（`probe` 与桌面端那条）是在同一个 `stop()` 里被一起 destroy 的，所以
       * `probe.closed` 变真，就意味着这一轮事件循环里两条 socket 的 close 都已经送到了。
       * 不先等这一步的话，用例可能在「已经断了但还没告诉任何人」的那一瞬发请求 —— 那会写进
       * 一条对端已不在的 socket（不报错、也没有回音），用例于是得等一个往返超时。那是
       * 测试特有的噪声，不是被测行为（真窗口里用户此刻也不会发请求）。
       */
      await waitFor(
        () => (probe === null || probe.closed ? true : undefined),
        "客户端这一侧发现连接已断",
      );
      probe?.close();
      probe = null;
      daemon = new Daemon({ aiZenDir: dir, port: 0, version: "0.0.0-test", handlers });
      await daemon.start();
    },
    stop: async () => {
      layer.dispose();
      probe?.close();
      probe = null;
      manager.dispose();
      // hub 是外面传的（`ownsHub === false`），`manager.dispose()` 不会清它
      hub.clear();
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
  /**
   * 最多等多久（缺省 5s）。
   *
   * 之所以可调：默认值与 vitest 的用例时限（也是 5s）撞在一起，超时就变成一句没头没尾的
   * `Test timed out in 5000ms`。需要「失败的时候能看出在等什么」的用例传一个**更短**的
   * 时限（例如 3s），于是红的时候报的是 `等待超时：<what>`。它是个**上界**，不是 sleep。
   */
  timeoutMs = 5_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
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
