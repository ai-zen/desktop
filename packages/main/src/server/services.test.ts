/**
 * 六个 Service 的**映射**用例：方法名 / 参数 / 返回形状是否与旧的 `services/*.ts` 一致，
 * 以及每一步在服务端立了什么事实。
 *
 * 全部走 `ServicesManager.invokeService`（render 真实走的那条路），不直接 new 服务类 ——
 * 分发键（`workspace` / `conversation` / `chat` / …）本身就是契约的一部分。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  AgentOption,
  ConfigSettings,
  Conversation,
  ConversationState,
  ConversationSummary,
  ModelOption,
  Workspace,
} from "@ai-zen/desktop-shared";
import type {
  SessionListResult,
  SessionSnapshotResult,
  WorkspaceListResult,
} from "@ai-zen/agents-client";
import { startTestServer, waitFor, MODEL_ID, type TestServer } from "./test-harness.js";

let server: TestServer;

beforeEach(async () => {
  server = await startTestServer();
});

afterEach(async () => {
  await server.stop();
});

/** render 的那条路：`window.electronAPI.invokeService(service, method, ...args)` */
async function invoke<T>(service: string, method: string, ...args: unknown[]): Promise<T> {
  return (await server.layer.manager.invokeService(service, method, ...args)) as T;
}

async function createWorkspace(name = ""): Promise<Workspace> {
  return await invoke<Workspace>("workspace", "create", name, server.projectDir);
}

async function createConversation(agentId = "default"): Promise<Conversation> {
  const workspace = await createWorkspace();
  return await invoke<Conversation>("conversation", "create", workspace.id, agentId);
}

/**
 * 会话级覆盖用的另一个模型 id。
 *
 * 只有 `MODEL_ID` 一个模型时，「有覆盖」与「没覆盖」会得到同一个值，用例就分辨不出
 * 「客户端读的是生效值」还是「读的是定义那个」—— 所以临时给配置补一个。
 */
const OVERRIDE_MODEL_ID = "model-y";

/** 往 `config.json` 里补一个模型：覆盖值必须指向配置里真有的模型（服务端装配与解析都要查它） */
function addModelToConfig(id: string): void {
  const file = join(server.dir, "config.json");
  const config = JSON.parse(readFileSync(file, "utf-8")) as {
    models: Array<Record<string, unknown>>;
  };
  config.models.push({ id, name: `模型 ${id}`, endpointId: "e1" });
  writeFileSync(file, JSON.stringify(config));
}

describe("workspace", () => {
  it("create：返回 render 的 Workspace 形状；名字落成服务端的 title，目录用服务端规范化的路径", async () => {
    const created = await createWorkspace("我的项目");

    expect(created).toEqual({
      id: expect.any(String),
      name: "我的项目",
      cwd: server.projectDir,
    });

    // 名字不是客户端的私事：它进了 `workspace.json` 的 title（`workspace.rename` 那条窄方法）
    const listed = await server.call<WorkspaceListResult>("workspace.list");
    expect(listed.workspaces).toEqual([
      { workspaceId: created.id, title: "我的项目", path: server.projectDir, pathExists: true },
    ]);
  });

  it("create：同一个目录再来一次是同一个工作区（服务端幂等），没给名字时用目录名兜底", async () => {
    const first = await createWorkspace("我的项目");
    const second = await createWorkspace();

    expect(second.id).toBe(first.id);
    expect(second.name).toBe("proj");
  });

  it("list：id/name/cwd 逐个对位，没起过名的工作区用目录名（不是空串）", async () => {
    const other = join(server.dir, "另一个目录");
    mkdirSync(other, { recursive: true });
    const named = await createWorkspace("起过名的");
    await invoke<Workspace>("workspace", "create", "", other);

    const list = await invoke<Workspace[]>("workspace", "list");
    const byId = new Map(list.map((item) => [item.id, item]));
    expect(byId.get(named.id)).toEqual({ id: named.id, name: "起过名的", cwd: server.projectDir });
    // 顺序由服务端定（显示名码位序），客户端不重排
    expect(list.map((item) => item.name)).toEqual(["另一个目录", "起过名的"]);
  });

  it("rename / remove：改名只动显示名；删除连它的会话一起删，且幂等", async () => {
    const workspace = await createWorkspace("旧名字");
    await invoke<void>("workspace", "rename", workspace.id, "新名字");
    expect((await invoke<Workspace[]>("workspace", "list"))[0]!.name).toBe("新名字");
    // cwd 一个字都不动
    expect((await invoke<Workspace[]>("workspace", "list"))[0]!.cwd).toBe(server.projectDir);

    const conversation = await invoke<Conversation>("conversation", "create", workspace.id, "default");
    expect(conversation.id).toEqual(expect.any(String));

    await invoke<void>("workspace", "remove", workspace.id);
    expect(await invoke<Workspace[]>("workspace", "list")).toEqual([]);
    // 工作区没了，它下面的会话也一并没了（`session.list` 读不到任何存档）
    const sessions = await server.call<SessionListResult>("session.list", {
      workspaceId: workspace.id,
    });
    expect(sessions.sessions).toEqual([]);
    // 幂等：本来就不存在不算错
    await expect(invoke<void>("workspace", "remove", workspace.id)).resolves.toBeUndefined();
  });
});

describe("conversation", () => {
  it("create：模型由服务端三级解析给出，消息要再要一次快照才有", async () => {
    // 真件的初始消息来自 Agent 定义的预设；假件照抄这个形态
    server.agent.messages = [
      { id: "preset_1", role: "system", content: "你是助手" },
    ] as never;

    const conversation = await createConversation();

    expect(conversation.id).toEqual(expect.any(String));
    expect(conversation.agentId).toBe("default");
    // 客户端没有能力指定模型：这是服务端解析出来的（Agent 定义上那个）
    expect(conversation.modelId).toBe(MODEL_ID);
    expect(conversation.messages.map((message) => message.role)).toEqual(["system"]);
    expect(conversation.createdAt).toEqual(expect.any(String));
    expect(conversation.updatedAt).toEqual(expect.any(String));
  });

  it("list：id/name/messageCount/updatedAt 对位；running = live && phase !== null；title 缺省走兜底名", async () => {
    const workspace = await createWorkspace();
    server.agent.messages = [
      { id: "preset_1", role: "system", content: "你是助手" },
    ] as never;
    const conversation = await invoke<Conversation>(
      "conversation",
      "create",
      workspace.id,
      "default",
    );

    const list = await invoke<ConversationSummary[]>("conversation", "list", workspace.id);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: conversation.id,
      workspaceId: workspace.id,
      agentId: "default",
      // 没有会话级覆盖不等于「没有模型」：这一位是下拉框的当前值，服务端给的是三级解析后
      // 的生效值（Agent 定义那一档）。只读覆盖值的话下拉框会空着（改造前的回归）
      modelId: MODEL_ID,
      messageCount: 1,
      // 还没起名：兜底名与旧实现的默认命名同形
      name: expect.stringMatching(/^对话_[0-9]{2}:[0-9]{2}$/),
      running: false,
    });
    expect(list[0]!.updatedAt).toEqual(expect.any(String));
  });

  it("list：没有会话级覆盖时 modelId 是 Agent 定义里那个模型（下拉框不能空着）", async () => {
    const workspace = await createWorkspace();
    const conversation = await invoke<Conversation>(
      "conversation",
      "create",
      workspace.id,
      "default",
    );

    // 先看服务端侧的事实：这一条**没有**会话级覆盖（清单里 `modelId` 缺省），而生效值落在
    // Agent 定义那一档。两者是两个字段，客户端要的是后者
    const raw = await server.call<SessionListResult>("session.list", {
      workspaceId: workspace.id,
    });
    expect("modelId" in raw.sessions[0]!).toBe(false);
    expect(raw.sessions[0]!.effectiveModelId).toBe(MODEL_ID);

    // 下拉框读的就是这一位：空串 = 用户看到「没选模型」（改造前的行为回归）
    const list = await invoke<ConversationSummary[]>("conversation", "list", workspace.id);
    expect(list[0]).toMatchObject({ id: conversation.id, modelId: MODEL_ID });
  });

  it("list：有会话级覆盖时 modelId 是覆盖值", async () => {
    addModelToConfig(OVERRIDE_MODEL_ID);
    const workspace = await createWorkspace();
    const conversation = await invoke<Conversation>(
      "conversation",
      "create",
      workspace.id,
      "default",
    );
    await invoke<void>("conversation", "setModel", workspace.id, conversation.id, OVERRIDE_MODEL_ID);

    // 服务端侧：有覆盖时两个字段同值，档位说清是会话级赢了
    const raw = await server.call<SessionListResult>("session.list", {
      workspaceId: workspace.id,
    });
    expect(raw.sessions[0]).toMatchObject({
      modelId: OVERRIDE_MODEL_ID,
      effectiveModelId: OVERRIDE_MODEL_ID,
      effectiveModelLevel: "session",
    });

    const list = await invoke<ConversationSummary[]>("conversation", "list", workspace.id);
    expect(list[0]!.modelId).toBe(OVERRIDE_MODEL_ID);
  });

  it("list：服务端省略 effectiveModelId（定义已删）时，modelId 退回覆盖值 / 空串而不抛错", async () => {
    addModelToConfig(OVERRIDE_MODEL_ID);
    const workspace = await createWorkspace();
    // 两段会话都指向 default：一段有会话级覆盖，一段没有
    const overridden = await invoke<Conversation>(
      "conversation",
      "create",
      workspace.id,
      "default",
    );
    await invoke<void>("conversation", "setModel", workspace.id, overridden.id, OVERRIDE_MODEL_ID);
    const plain = await invoke<Conversation>("conversation", "create", workspace.id, "default");

    // 落盘再放回存档：只有**存档条目**才走服务端那个解析器（活会话的生效模型来自 Agent 实例，
    // 定义删了也不影响它 → 造不出「解析不出来」）
    await server.call("session.save", { sessionId: overridden.id });
    await server.call("session.save", { sessionId: plain.id });
    await invoke<void>("chat", "release", overridden.id);
    await invoke<void>("chat", "release", plain.id);

    // 先确认「有 → 没有」只由删定义引起：放回存档之后、删定义之前，两条都还解析得出来
    // （否则下面「字段被省略」可能只是假件根本没接解析器，用例就变成永远为真）
    const archived = new Map(
      (await server.call<SessionListResult>("session.list", { workspaceId: workspace.id })).sessions.map(
        (entry) => [entry.sessionId, entry.effectiveModelId],
      ),
    );
    expect(archived.get(overridden.id)).toBe(OVERRIDE_MODEL_ID);
    expect(archived.get(plain.id)).toBe(MODEL_ID);

    // 用户把 Agent 定义删了：这两段会话此刻指着一个不存在的定义
    rmSync(join(server.dir, "agents", "default.json"));

    // 先确认场景在真 daemon 上成立：两条都**省略**了 effectiveModelId（解析不出来就不猜值）
    const raw = await server.call<SessionListResult>("session.list", {
      workspaceId: workspace.id,
    });
    expect(raw.sessions).toHaveLength(2);
    for (const entry of raw.sessions) {
      expect("effectiveModelId" in entry).toBe(false);
      expect("effectiveModelLevel" in entry).toBe(false);
    }

    // 客户端：退回会话级覆盖（用户自己选过的那一个）/ 没覆盖则空串；两条都不能抛
    const list = await invoke<ConversationSummary[]>("conversation", "list", workspace.id);
    const byId = new Map(list.map((item) => [item.id, item]));
    expect(byId.get(overridden.id)!.modelId).toBe(OVERRIDE_MODEL_ID);
    expect(byId.get(plain.id)!.modelId).toBe("");
  });

  it("list：run 起来之后 running 为 true（live 只说明在内存里，phase 才说明正在跑）", async () => {
    const workspace = await createWorkspace();
    const conversation = await invoke<Conversation>(
      "conversation",
      "create",
      workspace.id,
      "default",
    );
    await invoke<void>("chat", "send", workspace.id, conversation.id, "你好");

    await waitFor(async () => {
      const list = await invoke<ConversationSummary[]>("conversation", "list", workspace.id);
      return list[0]?.running === true;
    }, "侧栏看到 running");

    // 收尾之后回到 false（live 仍为 true —— 会话还在服务端内存里）
    server.agent.messages.push({
      id: "tool_1",
      role: "tool",
      content: "结果",
      tool_call_id: "call_1",
    } as never);
    server.agent.finish();
    await waitFor(async () => {
      const list = await invoke<ConversationSummary[]>("conversation", "list", workspace.id);
      return list[0]?.running === false;
    }, "收尾后 running 落回 false");
  });

  it("rename：名字进 title（list 立刻反映），空名字被服务端拒掉", async () => {
    const workspace = await createWorkspace();
    const conversation = await invoke<Conversation>(
      "conversation",
      "create",
      workspace.id,
      "default",
    );

    await invoke<void>("conversation", "rename", workspace.id, conversation.id, "改过的名字");
    const list = await invoke<ConversationSummary[]>("conversation", "list", workspace.id);
    expect(list[0]!.name).toBe("改过的名字");

    // 协议里 title 是必填非空：空名字当场报错，而不是悄悄改名
    await expect(
      invoke<void>("conversation", "rename", workspace.id, conversation.id, ""),
    ).rejects.toThrow(/title/);
  });

  it("read：活会话直读；盘上的历史先 attach 再取；不存在的会话回 null（旧签名的那条返回值）", async () => {
    const workspace = await createWorkspace();
    const conversation = await invoke<Conversation>(
      "conversation",
      "create",
      workspace.id,
      "default",
    );
    await invoke<void>("chat", "send", workspace.id, conversation.id, "留个痕");
    server.agent.emitDelta("答");
    server.agent.finish();
    await waitFor(() => server.pushed.some((event) => event.type === "done"), "本轮收尾");

    const live = await invoke<Conversation | null>("conversation", "read", workspace.id, conversation.id);
    expect(live?.messages.map((message) => message.role)).toEqual(["user", "assistant"]);

    // 把会话从内存里放掉：只剩盘上的存档。`session.snapshot` 这时是取不到的（协议缺口①），
    // 所以 read 必须先 attach
    await invoke<void>("chat", "release", conversation.id);
    expect(
      (await server.call<SessionListResult>("session.list", { workspaceId: workspace.id })).sessions[0]
        ?.live,
    ).toBe(false);
    const archived = await invoke<Conversation | null>(
      "conversation",
      "read",
      workspace.id,
      conversation.id,
    );
    expect(archived?.messages.map((message) => message.role)).toEqual(["user", "assistant"]);

    expect(await invoke<Conversation | null>("conversation", "read", workspace.id, "chat_nope")).toBeNull();
  });

  it("read：name 是服务端的 title（不是「对话_HH:mm」）", async () => {
    const workspace = await createWorkspace();
    const conversation = await invoke<Conversation>(
      "conversation",
      "create",
      workspace.id,
      "default",
    );
    await invoke<void>("conversation", "rename", workspace.id, conversation.id, "服务端记得的名字");

    const read = await invoke<Conversation | null>(
      "conversation",
      "read",
      workspace.id,
      conversation.id,
    );
    expect(read?.name).toBe("服务端记得的名字");
  });

  it("read：updatedAt 与清单里那一条一致（存档的最后活动时间，不是「此刻」）", async () => {
    const workspace = await createWorkspace();
    const conversation = await invoke<Conversation>(
      "conversation",
      "create",
      workspace.id,
      "default",
    );
    await invoke<void>("chat", "send", workspace.id, conversation.id, "留个痕");
    server.agent.emitDelta("答");
    server.agent.finish();
    await waitFor(() => server.pushed.some((event) => event.type === "done"), "本轮收尾");
    await invoke<void>("chat", "release", conversation.id);

    // 把这段存档的最后活动时间挪到过去：服务端从清单（清单不在时取正文文件的 mtime）读它。
    // 这样「read 报的是清单里那个时间」与「read 报的是此刻」之间才有一眼可辨的差距 ——
    // 两边都是「刚才」，断言相等就什么也证不了
    const sessionsDir = join(server.dir, "workspaces", workspace.id, "sessions");
    rmSync(join(sessionsDir, `${conversation.id}.meta.json`));
    const past = new Date("2020-01-02T03:04:05.000Z");
    utimesSync(join(sessionsDir, `${conversation.id}.json`), past, past);

    const listed = await invoke<ConversationSummary[]>("conversation", "list", workspace.id);
    expect(listed[0]!.updatedAt).toBe(past.toISOString());

    const read = await invoke<Conversation | null>(
      "conversation",
      "read",
      workspace.id,
      conversation.id,
    );
    expect(read?.updatedAt).toBe(listed[0]!.updatedAt);
    // 协议没有创建时间：这一段取的就是最后一次更新时间（同一处判断，这里锁住它，
    // 免得以后有人在上面「顺手」填一个 now）
    expect(read?.createdAt).toBe(listed[0]!.updatedAt);
  });

  it("setModel：只写会话级覆盖（服务端随即重建 Agent）", async () => {
    const workspace = await createWorkspace();
    const conversation = await invoke<Conversation>(
      "conversation",
      "create",
      workspace.id,
      "default",
    );

    await invoke<void>("conversation", "setModel", workspace.id, conversation.id, MODEL_ID);

    // 服务端侧的事实：存档里的会话级 modelId 就是它（假件的 `definition.modelId` 没被改）
    const listed = await server.call<SessionListResult>("session.list", { workspaceId: workspace.id });
    expect(listed.sessions[0]!.modelId).toBe(MODEL_ID);
    const list = await invoke<ConversationSummary[]>("conversation", "list", workspace.id);
    expect(list[0]!.modelId).toBe(MODEL_ID);
  });

  it("remove：物理删会话，幂等（本来就没有不算错）", async () => {
    const workspace = await createWorkspace();
    const conversation = await invoke<Conversation>(
      "conversation",
      "create",
      workspace.id,
      "default",
    );

    await invoke<void>("conversation", "remove", workspace.id, conversation.id);
    expect((await invoke<ConversationSummary[]>("conversation", "list", workspace.id))).toEqual([]);
    await expect(
      invoke<void>("conversation", "remove", workspace.id, conversation.id),
    ).resolves.toBeUndefined();
  });
});

describe("chat", () => {
  it("send：立刻返回（过程走事件）；随后 getState 能看到消息与 streaming", async () => {
    const workspace = await createWorkspace();
    const conversation = await invoke<Conversation>(
      "conversation",
      "create",
      workspace.id,
      "default",
    );

    // 假件的 `send()` 不会自己结束 —— 所以这行返回时本轮仍在跑，正是「立刻回 turnId」
    await invoke<void>("chat", "send", workspace.id, conversation.id, "你好");

    expect(server.agent.sent).toEqual(["你好"]);
    // 服务端侧：这一轮的编号已经是 1（`session.send` 的返回值就是它）
    const snapshot = await server.call<SessionSnapshotResult>("session.snapshot", {
      sessionId: conversation.id,
    });
    expect(snapshot.turnId).toBe(1);
    expect(snapshot.phase).not.toBeNull();

    const state = await invoke<ConversationState>("chat", "getState", workspace.id, conversation.id);
    expect(state.streaming).toBe(true);
    expect(state.messages.map((message) => message.role)).toEqual(["user"]);
  });

  it("send：撞上 turn-busy 时静默忽略（与旧实现一致：重复提交不弹错）", async () => {
    const workspace = await createWorkspace();
    const conversation = await invoke<Conversation>(
      "conversation",
      "create",
      workspace.id,
      "default",
    );

    await invoke<void>("chat", "send", workspace.id, conversation.id, "第一句");
    await waitFor(() => server.pushed.some((event) => event.type === "start"), "本轮开始");
    const pushedBefore = server.pushed.length;

    // 上一轮还没收尾，再发一次：旧实现在运行注册表里看到 pending 就直接 return
    await expect(
      invoke<void>("chat", "send", workspace.id, conversation.id, "第二句"),
    ).resolves.toBeUndefined();
    // render 侧什么都没多看到（既没有 error，也没有第二条 user）
    expect(server.pushed.slice(pushedBefore)).toEqual([]);
    // 服务端的消息里也只有第一句
    expect(server.agent.sent).toEqual(["第一句"]);
  });

  it("abort：请求服务端掐掉本轮（会话本身还在）", async () => {
    const workspace = await createWorkspace();
    const conversation = await invoke<Conversation>(
      "conversation",
      "create",
      workspace.id,
      "default",
    );
    await invoke<void>("chat", "send", workspace.id, conversation.id, "跑起来");
    await waitFor(() => server.pushed.some((event) => event.type === "start"), "本轮开始");

    await invoke<void>("chat", "abort", conversation.id);
    expect(server.agent.aborted).toBe(true);
  });

  it("release：会话从内存里退场（存档留着），getState 照样读得回来", async () => {
    const workspace = await createWorkspace();
    const conversation = await invoke<Conversation>(
      "conversation",
      "create",
      workspace.id,
      "default",
    );
    await invoke<void>("chat", "send", workspace.id, conversation.id, "留档");
    server.agent.emitDelta("答");
    server.agent.finish();
    await waitFor(() => server.pushed.some((event) => event.type === "done"), "本轮收尾");

    await invoke<void>("chat", "release", conversation.id);
    const listed = await server.call<SessionListResult>("session.list", { workspaceId: workspace.id });
    expect(listed.sessions[0]!.live).toBe(false);

    // 点回来：getState 先 attach 再取快照（协议缺口①的唯一出口）
    const state = await invoke<ConversationState>("chat", "getState", workspace.id, conversation.id);
    expect(state.streaming).toBe(false);
    expect(state.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
  });
});

describe("agent / model / config", () => {
  it("agent.list：只列入口 Agent（子 Agent 由服务端分好，不再靠 `function` 过滤）", async () => {
    const agents = await invoke<AgentOption[]>("agent", "list");
    expect(agents).toEqual([{ id: "default", name: "默认助手", description: "入口 Agent" }]);
  });

  it("model.list：来自 config.get 的 models（协议里没有 model.list）", async () => {
    const models = await invoke<ModelOption[]>("model", "list");
    expect(models).toEqual([{ id: MODEL_ID, name: "模型 X" }]);
  });

  it("config.get：端点 / 默认模型 / 默认 Agent / 数据目录（dataDir 由 config.json 的路径取目录）", async () => {
    const settings = await invoke<ConfigSettings>("config", "get");
    expect(settings).toEqual({
      endpoints: [
        { id: "e1", name: "端点一", baseUrl: "http://127.0.0.1:9/v1", apiKey: "key-1", description: undefined },
        { id: "e2", name: "端点二", baseUrl: "http://127.0.0.1:9/v2", apiKey: "key-2", description: undefined },
      ],
      defaultModel: MODEL_ID,
      defaultAgent: "default",
      dataDir: server.dir,
    });
  });

  it("config.update：默认模型/默认 Agent 走窄方法，端点只有整份 save 一条路", async () => {
    const readConfig = () =>
      JSON.parse(readFileSync(join(server.dir, "config.json"), "utf-8")) as {
        defaultModel: string;
        defaultAgent: string;
        endpoints: Array<{ id: string; name: string; apiKey: string }>;
      };

    await invoke<void>("config", "update", { defaultModel: MODEL_ID, defaultAgent: "default" });
    // 空串不写（服务端的窄方法只接受非空 id）：不影响另一个字段
    await invoke<void>("config", "update", { defaultModel: "", defaultAgent: "" });
    expect(readConfig().defaultModel).toBe(MODEL_ID);
    expect(readConfig().defaultAgent).toBe("default");

    await invoke<void>("config", "update", {
      endpoints: [{ id: "e1", name: "端点一", baseUrl: "http://127.0.0.1:9/v1", apiKey: "换过的 key" }],
    });
    const config = readConfig();
    expect(config.endpoints.find((endpoint) => endpoint.id === "e1")?.apiKey).toBe("换过的 key");
    // 没被编辑的端点原样保留（整份 save 用的是服务端刚读到的那一份，不是客户端的副本）
    expect(config.endpoints.find((endpoint) => endpoint.id === "e2")?.apiKey).toBe("key-2");
  });
});
