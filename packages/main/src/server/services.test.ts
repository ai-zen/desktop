/**
 * 六个 Service 用例：**render 要的形状 ↔ 契约方法**这两头对不对得上。
 *
 * 每个方法都只有一件事要做（翻译），所以这里的用例也就是一句话一条：给一份契约出参，断言
 * render 拿到的那份、以及发出去的那个方法名与入参。真服务端在这里只会有噪声 —— 它会把这层
 * 唯一要验的东西（字段名、参数名、降级到哪一步）藏进一次网络往返里。
 *
 * 有几条是**故意**这么定的，别顺手「修」掉：
 *   · `model.list` 只给能用的（下拉框里选一个不可用的，发出去必然失败）；
 *   · `agent.list` 不列子 Agent（它们不是「开一段对话」的入口）；
 *   · `config.update` 里端点密钥**只在真的改了时才写**（框里显示的是掩码，原样回写会把掩码当密钥）。
 */

import { AgentNS } from "@ai-zen/agents-core";
import type { ConversationState as WireConversationState, RunState } from "@ai-zen/agents-client";
import { ClientError as ClientErrorValue } from "@ai-zen/agents-client";
import type { ChatStreamEvent } from "@ai-zen/desktop-shared";
import { describe, expect, it } from "vitest";
import type { ContractConnection } from "./contract.js";
import { ChatEventBridge } from "./events.js";
import {
  ServerAgentService,
  ServerChatService,
  ServerConfigService,
  ServerConversationService,
  ServerModelService,
  ServerWorkspaceService,
  type ServiceContext,
} from "./services.js";

const CONVERSATION = "conv-1";
const WORKSPACE = "ws-1";

// ==================================================================
// 假连接 + 收事件的篮子
// ==================================================================

interface Recorded {
  method: string;
  params: unknown;
}

interface Harness {
  ctx: ServiceContext;
  /** 这一层发出去的每一次请求 */
  calls: Recorded[];
  /** 推给 render 的事件 */
  events: ChatStreamEvent[];
  /** `track` 记下的锚点 */
  tracked: Map<string, string | undefined>;
}

function harness(reply: (method: string, params: unknown) => unknown = () => ({})): Harness {
  const calls: Recorded[] = [];
  const tracked = new Map<string, string | undefined>();
  const connection = {
    hello: null,
    call: async (method: string, params: unknown) => {
      calls.push({ method, params });
      return reply(method, params);
    },
    subscribe: () => () => {},
    onClose: () => () => {},
    onResume: () => () => {},
    resume: async (conversationId: string) => ({ conversationId }),
    track: (conversationId: string, anchor?: string) => {
      tracked.set(conversationId, anchor);
    },
    untrack: (conversationId: string) => {
      tracked.delete(conversationId);
    },
    reconnect: async () => {},
    close: async () => {},
  } as unknown as ContractConnection;

  const events: ChatStreamEvent[] = [];
  const bridge = new ChatEventBridge({
    // 收尾 / 改名那几条这里用不到；`chat` 那组只用 beginTurn / pushError
    call: connection.call,
    push: (event) => events.push(event),
    log: () => {},
  });

  return {
    calls,
    events,
    tracked,
    ctx: {
      call: connection.call,
      connection: () => connection,
      events: bridge,
      defaultCwd: () => "/home/user/Desktop",
    },
  };
}

const zeroUsage: AgentNS.Usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

function wireConversationState(run: Partial<RunState> = {}): WireConversationState {
  return {
    conversationId: CONVERSATION,
    run: {
      conversationId: CONVERSATION,
      status: "idle",
      assistantMessageId: null,
      startedAt: null,
      settledAt: null,
      generation: null,
      outcome: null,
      problem: null,
      subagents: [],
      usage: {
        turn: zeroUsage,
        total: zeroUsage,
        subAgent: zeroUsage,
        rate: { value: 0, unit: "tokens_per_second", basis: "completion" },
        updatedAt: "a",
      },
      ...run,
    },
    context: { usage: zeroUsage, handoffThreshold: 0, guardThreshold: 0, overHandoff: false, overGuard: false },
    thinking: { preset: null, levels: [], selected: null, source: "not_adjustable", params: {} },
    usage: {
      turn: zeroUsage,
      total: zeroUsage,
      subAgent: zeroUsage,
      rate: { value: 0, unit: "tokens_per_second", basis: "completion" },
      updatedAt: "a",
    },
    questions: [],
    statusBlocks: [],
    updatedAt: "a",
  };
}

// ==================================================================
// workspace
// ==================================================================

describe("workspace", () => {
  it("list：`folder` 整块搬（路径 + 还在不在，不只取 cwd）", async () => {
    const h = harness(() => ({
      workspaces: [
        { id: "ws-1", name: "我的项目", folder: { cwd: "/code/a", exists: true } },
        { id: "ws-2", name: "已删除目录", folder: { cwd: "/code/b", exists: false } },
      ],
    }));

    const workspaces = await new ServerWorkspaceService(h.ctx).list();

    expect(workspaces).toEqual([
      { id: "ws-1", name: "我的项目", folder: { cwd: "/code/a", exists: true } },
      { id: "ws-2", name: "已删除目录", folder: { cwd: "/code/b", exists: false } },
    ]);
  });

  it("create：没填 cwd 时用桌面端的默认目录（那是本机的事实，服务端不可能知道）", async () => {
    const h = harness(() => ({
      workspace: { id: "ws-9", name: "桌面", folder: { cwd: "/home/user/Desktop", exists: true } },
    }));

    const workspace = await new ServerWorkspaceService(h.ctx).create("", "");

    expect(h.calls[0]).toEqual({ method: "workspace.create", params: { cwd: "/home/user/Desktop" } });
    expect(workspace).toEqual({ id: "ws-9", name: "桌面", folder: { cwd: "/home/user/Desktop", exists: true } });
  });

  it("create：填了名字就一起交出去", async () => {
    const h = harness(() => ({
      workspace: { id: "ws-9", name: "甲", folder: { cwd: "/code/a", exists: true } },
    }));

    await new ServerWorkspaceService(h.ctx).create("甲", "/code/a");

    expect(h.calls[0]).toEqual({
      method: "workspace.create",
      params: { cwd: "/code/a", name: "甲" },
    });
  });

  it("rename / remove：参数名是契约里的 `workspaceId`", async () => {
    const h = harness();
    const service = new ServerWorkspaceService(h.ctx);

    await service.rename("ws-1", "新名字");
    await service.remove("ws-1");

    expect(h.calls).toEqual([
      { method: "workspace.rename", params: { workspaceId: "ws-1", name: "新名字" } },
      { method: "workspace.remove", params: { workspaceId: "ws-1" } },
    ]);
  });
});

// ==================================================================
// conversation
// ==================================================================

describe("conversation", () => {
  it("list：name / messageCount / running / modelId 都取自服务端那一项", async () => {
    const h = harness(() => ({
      conversations: [
        {
          id: "conv-1",
          workspaceId: "ws-1",
          agentId: "agent-1",
          modelId: "model-1",
          name: "第一段",
          messageCount: 3,
          updatedAt: "2026-01-01T00:00:00.000Z",
          running: true,
        },
      ],
      total: 1,
    }));

    const list = await new ServerConversationService(h.ctx).list("ws-1");

    expect(h.calls[0]).toEqual({ method: "conversation.list", params: { workspaceId: "ws-1" } });
    expect(list).toEqual([
      {
        id: "conv-1",
        workspaceId: "ws-1",
        agentId: "agent-1",
        modelId: "model-1",
        name: "第一段",
        messageCount: 3,
        updatedAt: "2026-01-01T00:00:00.000Z",
        running: true,
      },
    ]);
  });

  it("create：建完再取一次消息（助手定义的预设消息由服务端写进会话）", async () => {
    const preset = { id: "m-system", role: AgentNS.Role.System, content: "你是助手" };
    const h = harness((method) => {
      if (method === "conversation.create") {
        return {
          conversation: {
            id: "conv-1",
            workspaceId: "ws-1",
            agentId: "agent-1",
            name: "2026-01-01 10:00",
            messageCount: 1,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            running: false,
            model: { modelId: "model-1", name: "模型一", vision: true, source: "agent" },
          },
        };
      }
      if (method === "message.list") {
        return { conversationId: "conv-1", anchor: null, messages: [preset] };
      }
      return {};
    });

    const conversation = await new ServerConversationService(h.ctx).create("ws-1", "agent-1");

    expect(h.calls.map((call) => call.method)).toEqual(["conversation.create", "message.list"]);
    expect(h.calls[0]?.params).toEqual({ workspaceId: "ws-1", agentId: "agent-1" });
    expect(conversation.id).toBe("conv-1");
    // 生效模型整块来自 `model`（创建时定死的那一个，PRD L7）：名字、能不能看图、谁定的都在
    expect(conversation.model).toEqual({ modelId: "model-1", name: "模型一", vision: true, source: "agent" });
    expect(conversation.messages).toEqual([preset]);
  });

  it("create：目录还没登记成项目 → 抛一句说清原因的话（桌面端还没有提问界面）", async () => {
    const h = harness(() => ({
      conversation: null,
      requiresRegistration: true,
      questionId: "q1",
      cwd: "/code/new",
    }));

    const error: unknown = await new ServerConversationService(h.ctx)
      .create("ws-1", "agent-1")
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("还没登记成项目");
    expect((error as Error).message).toContain("/code/new");
  });

  it("read：服务端说 `not_found` 就翻回 `null`（调用方不必认识业务码）", async () => {
    const h = harness(() => {
      throw new ClientErrorValue("not_found", "这段对话不存在");
    });

    expect(await new ServerConversationService(h.ctx).read("ws-1", "conv-x")).toBeNull();
  });

  it("remove / rename / setModel：只认会话 id（render 那个 workspaceId 参数不再转发）", async () => {
    const h = harness();
    const service = new ServerConversationService(h.ctx);

    await service.remove("ws-1", "conv-1");
    await service.rename("ws-1", "conv-1", "新名字");
    await service.setModel("ws-1", "conv-1", "model-2");

    expect(h.calls).toEqual([
      { method: "conversation.delete", params: { conversationId: "conv-1" } },
      { method: "conversation.rename", params: { conversationId: "conv-1", name: "新名字" } },
      { method: "conversation.setModel", params: { conversationId: "conv-1", modelId: "model-2" } },
    ]);
  });
});

// ==================================================================
// agent / model
// ==================================================================

describe("agent / model", () => {
  it("agent.list：子 Agent 不进入口列表（服务端用 `isSubAgent` 明说了）", async () => {
    const h = harness(() => ({
      agents: [
        { id: "a1", name: "助手甲", description: "会写代码", isSubAgent: false },
        { id: "a2", name: "子助手", description: null, isSubAgent: true },
      ],
      defaultAgentId: "a1",
    }));

    expect(await new ServerAgentService(h.ctx).list()).toEqual([
      { id: "a1", name: "助手甲", description: "会写代码" },
    ]);
  });

  it("model.list：只给能用的", async () => {
    const h = harness(() => ({
      models: [
        { id: "m1", name: "能用", available: true },
        { id: "m2", name: "端点缺密钥", available: false, unavailableReason: { message: "缺密钥" } },
      ],
    }));

    expect(await new ServerModelService(h.ctx).list()).toEqual([{ id: "m1", name: "能用" }]);
  });
});

// ==================================================================
// config
// ==================================================================

describe("config", () => {
  it("get：密钥是掩码，dataDir 用服务端给的 configDir", async () => {
    const h = harness(() => ({
      config: {
        endpoints: [
          { id: "e1", name: "DeepSeek", baseUrl: "https://api.deepseek.com", apiKeyMasked: "sk-…9f3a", apiKeySet: true, description: "主用" },
        ],
        defaults: { defaultModel: "m1", defaultAgent: "a1", defaultImageModel: null, defaultMigrationModel: null, namingModel: null, autoTitle: true },
        configDir: "/home/user/.ai-zen",
      },
      issues: [],
    }));

    const settings = await new ServerConfigService(h.ctx).get();

    expect(settings).toEqual({
      endpoints: [
        { id: "e1", name: "DeepSeek", baseUrl: "https://api.deepseek.com", apiKey: "sk-…9f3a", description: "主用" },
      ],
      defaultModel: "m1",
      defaultAgent: "a1",
      dataDir: "/home/user/.ai-zen",
    });
  });

  it("update：掩码原样提交 ⇒ 不写密钥（否则会把掩码当密钥存起来）", async () => {
    const h = harness((method) => {
      if (method === "config.get") {
        return {
          config: {
            endpoints: [
              { id: "e1", name: "DeepSeek", baseUrl: "https://api.deepseek.com", apiKeyMasked: "sk-…9f3a", apiKeySet: true },
            ],
            defaults: {},
            configDir: "/d",
          },
          issues: [],
        };
      }
      return {};
    });

    const report = await new ServerConfigService(h.ctx).update({
      endpoints: [{ id: "e1", name: "DeepSeek", baseUrl: "https://api.deepseek.com", apiKey: "sk-…9f3a" }],
    });

    expect(report.writtenEndpointIds).toEqual(["e1"]);
    const save = h.calls.find((call) => call.method === "config.saveEndpoint");
    expect(save?.params).toEqual({
      endpoint: { id: "e1", name: "DeepSeek", baseUrl: "https://api.deepseek.com" },
    });
  });

  it("update：真换了密钥就写进去", async () => {
    const h = harness((method) => {
      if (method === "config.get") {
        return {
          config: {
            endpoints: [
              { id: "e1", name: "DeepSeek", baseUrl: "https://api.deepseek.com", apiKeyMasked: "sk-…9f3a", apiKeySet: true },
            ],
            defaults: {},
            configDir: "/d",
          },
          issues: [],
        };
      }
      return {};
    });

    await new ServerConfigService(h.ctx).update({
      endpoints: [{ id: "e1", name: "DeepSeek", baseUrl: "https://api.deepseek.com", apiKey: "sk-new" }],
    });

    const save = h.calls.find((call) => call.method === "config.saveEndpoint");
    expect(save?.params).toMatchObject({ endpoint: { apiKey: "sk-new" } });
  });

  it("update：服务端已经没有的端点如实回报（不凭空加回来）", async () => {
    const h = harness(() => ({ config: { endpoints: [], defaults: {}, configDir: "/d" }, issues: [] }));

    const report = await new ServerConfigService(h.ctx).update({
      endpoints: [{ id: "gone", name: "x", baseUrl: "y", apiKey: "k" }],
    });

    expect(report.missingEndpointIds).toEqual(["gone"]);
    expect(h.calls.filter((call) => call.method === "config.saveEndpoint")).toEqual([]);
  });

  it("update：空的默认值不写，但要说出来（窄方法只收非空 id）", async () => {
    const h = harness();

    const report = await new ServerConfigService(h.ctx).update({ defaultModel: "", defaultAgent: "" });

    expect(report.skippedDefaults).toEqual(["defaultModel", "defaultAgent"]);
    expect(h.calls).toEqual([]);
  });

  it("update：默认值走 `config.setDefaults`", async () => {
    const h = harness();

    await new ServerConfigService(h.ctx).update({ defaultModel: "m2", defaultAgent: "a2" });

    expect(h.calls).toEqual([
      { method: "config.setDefaults", params: { defaults: { defaultModel: "m2", defaultAgent: "a2" } } },
    ]);
  });
});

// ==================================================================
// chat
// ==================================================================

describe("chat", () => {
  it("send：受理之后回显 start + 库里那条 user（带图那句在库里是内容段数组）", async () => {
    const stored: AgentNS.Message = {
      id: "m-user",
      role: AgentNS.Role.User,
      content: [
        { index: 0, type: "text", text: "你好" },
        { index: 1, type: "image_url", image_url: { url: "" }, __asset_id: "a1" },
      ],
    } as AgentNS.Message;
    const h = harness((method) => {
      if (method === "message.list") {
        return { conversationId: CONVERSATION, anchor: null, messages: [stored] };
      }
      return {
        userMessageId: "m-user",
        assistantMessageId: "m-assistant",
        attachments: [],
        acceptedAt: "2026-01-01T00:00:00.000Z",
      };
    });

    await new ServerChatService(h.ctx).send("ws-1", CONVERSATION, "你好");

    expect(h.calls[0]).toEqual({
      method: "conversation.send",
      params: { conversationId: CONVERSATION, input: { content: "你好" } },
    });
    // 上屏的是库里那条消息（`message.list` 取回来的整条，内容段数组原样），不是手上这句 `content`
    expect(h.events).toEqual([
      { conversationId: CONVERSATION, type: "start" },
      { conversationId: CONVERSATION, type: "user", message: stored },
    ]);
  });

  it("send 撞上 busy：什么都不推（那是多点了一下发送，不是错误）", async () => {
    const h = harness(() => {
      throw new ClientErrorValue("busy", "这段对话正在跑一轮");
    });

    await new ServerChatService(h.ctx).send("ws-1", CONVERSATION, "你好");

    expect(h.events).toEqual([]);
  });

  it("send 撞上 question_pending：推 error（用户得知道「有题没答」挡着）", async () => {
    const h = harness(() => {
      throw new ClientErrorValue("question_pending", "这个问题还没回答，这段对话暂时不能发消息");
    });

    await new ServerChatService(h.ctx).send("ws-1", CONVERSATION, "你好");

    const error = h.events[0];
    if (error?.type !== "error") throw new Error("应当推一条 error");
    expect(error.problem.message).toContain("还没回答");
    // 业务码一起递下去：界面按码分支，不去解析句子
    expect(error.problem.code).toBe("question_pending");
  });

  it("abort：发 `conversation.abort`（收尾照常走 run.state）", async () => {
    const h = harness();
    await new ServerChatService(h.ctx).abort(CONVERSATION);
    expect(h.calls[0]).toEqual({ method: "conversation.abort", params: { conversationId: CONVERSATION } });
  });

  it("getAsset：发 `asset.get`，把 base64 解成字节能 render 造 Blob", async () => {
    // 四个字节，base64 是 AQIDBA==：用例要看的是「解码这件事真的发生了」，不是字符串搬运
    const h = harness(() => ({
      asset: { assetId: "a1", mime: "image/png", bytes: 4, name: "图.png", width: 1, height: 1 },
      variant: "thumb",
      data: "AQIDBA==",
    }));

    const content = await new ServerChatService(h.ctx).getAsset("a1", "thumb");

    expect(h.calls[0]).toEqual({ method: "asset.get", params: { assetId: "a1", variant: "thumb" } });
    // 整份 `AssetRef` 下传：类型、字节数、文件名、宽高都在（R76：界面按宽高先摆占位框）
    expect(content.asset).toEqual({
      assetId: "a1",
      mime: "image/png",
      bytes: 4,
      name: "图.png",
      width: 1,
      height: 1,
    });
    expect([content.asset.width, content.asset.height]).toEqual([1, 1]);
    // 实际给的档也一并下去（`thumb` 目前等同原图，服务端如实回报）
    expect(content.variant).toBe("thumb");
    expect(Array.from(content.bytes)).toEqual([1, 2, 3, 4]);
  });

  it("getAsset：不传档位时缺省 `thumb`（气泡先显示的就这一档）", async () => {
    const h = harness(() => ({
      asset: { assetId: "a1", mime: "image/png", bytes: 4, name: null, width: null, height: null },
      variant: "thumb",
      data: "AQIDBA==",
    }));

    await new ServerChatService(h.ctx).getAsset("a1");

    expect(h.calls[0]).toEqual({ method: "asset.get", params: { assetId: "a1", variant: "thumb" } });
  });

  it("getAsset：服务端说 not_found 就把那句话原样抛上去（不降级成空字节）", async () => {
    const h = harness(() => {
      throw new ClientErrorValue("not_found", "这份素材已经不在了");
    });

    await expect(new ServerChatService(h.ctx).getAsset("gone")).rejects.toThrow("已经不在了");
  });

  it("getState：先状态后消息，并把锚点记成最后一条的 id（重连补拉的 after）", async () => {
    const messages = [
      { id: "m1", role: AgentNS.Role.User, content: "问题" },
      { id: "m2", role: AgentNS.Role.Assistant, content: "写了一半" },
    ];
    const h = harness((method) => {
      if (method === "conversation.state") {
        return { state: wireConversationState({ status: "running", generation: { phase: "generating", since: "…", chars: 4 } }) };
      }
      if (method === "message.list") {
        return { conversationId: CONVERSATION, anchor: null, messages };
      }
      return {};
    });

    const state = await new ServerChatService(h.ctx).getState("ws-1", CONVERSATION);

    expect(h.calls.map((call) => call.method)).toEqual(["conversation.state", "message.list"]);
    expect(state.messages).toEqual(messages);
    // 服务端的现场状态原样整份回来：`run` 在跑，上下文 / 思考 / 用量 / 问题 / 状态栏都在
    expect(state.run.status).toBe("running");
    for (const field of ["context", "thinking", "usage", "questions", "statusBlocks"] as const) {
      expect(state[field]).toEqual(wireConversationState()[field]);
    }
    // 派生布尔不在这里：要判「在不在跑」读 `run.status`
    expect(state).not.toHaveProperty("streaming");
    expect(h.tracked.get(CONVERSATION)).toBe("m2");
    // 六态也交给了事件层：切回来不该显示成「什么都没在跑」
    expect(h.events).toEqual([
      { conversationId: CONVERSATION, type: "stream", phase: "generating", toolCalls: [] },
    ]);
  });
});
