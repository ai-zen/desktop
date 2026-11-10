/**
 * 六个 Service 的「瘦客户端」实现 —— 每个方法只做一件事：**把 render 要的形状翻译成
 * 协议调用，再把结果翻译回去**。没有业务规则、没有本地状态、不碰磁盘。
 *
 * ## 三条纪律
 *
 * 1. **对外方法签名与旧的 `services/*.ts` 一字不差**（含参数顺序与返回类型），
 *    `ServicesManager` 的分发键（`workspace` / `conversation` / `agent` / `model` /
 *    `chat` / `config`）也不变 —— render 一行不改是这一阶段的目标，签名一漂就等于改了它。
 * 2. **不自己算规则**：模型走服务端三级解析（`会话级 > Agent 定义 > 全局`）、会话清单的
 *    排序与 `live/phase` 由服务端给、删工作区连会话一起删也在服务端。客户端再算一遍
 *    就是第二份会漂的实现。
 * 3. **协议没有的东西不造**：`session.snapshot` 只认活会话、`session.list` 里没有消息
 *    正文、`SessionListEntry.modelId` 只是会话级覆盖 —— 这些都在下面各自的注释里写清
 *    降级到哪一步。
 *
 * ## 为什么直接调协议方法而不用 `RemoteSessions` / `RemoteConfigPort`
 *
 * 那两个门面只覆盖 CLI 用到的那部分（`workspace.list/rename/remove` 就没有），本层要的
 * 是**逐条对应**：每个方法名、每个参数、每个结果字段都在调用点可见，改协议时这里编译
 * 不过而不是运行期 500。方法名与结果类型仍来自 `@ai-zen/agents-client` 转出的协议包。
 */

import { basename, dirname } from "node:path";
import {
  AGENT_METHODS,
  CONFIG_METHODS,
  SESSION_METHODS,
  WORKSPACE_METHODS,
  type AgentListResult,
  type ConfigGetResult,
  type SessionCreateResult,
  type SessionListResult,
  type SessionRemoveResult,
  type SessionSendResult,
  type SessionSnapshotResult,
  type WorkspaceListResult,
  type WorkspaceRemoveResult,
  type WorkspaceRenameResult,
  type WorkspaceResolveResult,
} from "@ai-zen/agents-client";
// 只借类型：Agent 定义与全局配置的形状真相源在 SDK，协议层刻意用 `unknown` 不解释它
// （`import type` 在产物里被整体擦除，不构成运行期依赖）
import type { AgentDefinition, AppConfig } from "@ai-zen/agents-sdk";
// 同理只要类型：本文件里 `AgentNS` 只出现在类型位置（`AgentNS.Message[]` 的断言）。
// 写 `import type` 与 `events.ts` 一个口径：依赖图里不出现「main → 整个模型库」这条运行期边
// （打包器这一版会自己擦掉纯类型用的导入，但那是它的优化，不是我们的约定）
import type { AgentNS } from "@ai-zen/agents-core";
import type {
  AgentOption,
  ConfigSettings,
  Conversation,
  ConversationState,
  ConversationSummary,
  EndpointSettings,
  ModelOption,
  Workspace,
} from "@ai-zen/desktop-shared";
import type { ServerConnection } from "./connection.js";
import type { ChatEventBridge } from "./events.js";

/**
 * 会话没起过名时的兜底名字。
 *
 * 服务端把「没有 title」如实回成 `undefined`（那确实还没名字），而侧栏总得显示点什么。
 * 用的是旧实现里新建会话的默认格式（`对话_HH:mm`）：用户认得这个形态，且同一段会话每次
 * 列出来的名字都相同（按 `updatedAt` 算，不是"现在几点"）。
 */
function fallbackConversationName(iso: string): string {
  const date = new Date(iso);
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `对话_${hh}:${mm}`;
}

// ==================================================================
// workspace
// ==================================================================

export interface ServerWorkspaceServiceOptions {
  connection: ServerConnection;
  /** 用户不填目录时的默认工作目录（桌面端注入 `app.getPath("desktop")`） */
  defaultCwd: () => string;
}

export class ServerWorkspaceService {
  constructor(private readonly options: ServerWorkspaceServiceOptions) {}

  /** 盘上全部工作区（服务端已按显示名排好序，客户端不重排） */
  async list(): Promise<Workspace[]> {
    const result = await this.options.connection.call<WorkspaceListResult>(WORKSPACE_METHODS.list);
    return result.workspaces.map((summary) => ({
      id: summary.workspaceId,
      // `title` 缺省 = 还没起过名：用目录名兜底（与旧实现「名称选填，默认取文件夹名」一致）
      name: summary.title ?? basename(summary.path),
      cwd: summary.path,
    }));
  }

  /**
   * 建（或复用）一个工作区。
   *
   * `workspace.resolve` 是**幂等**的：同一个目录永远得到同一个 `workspaceId`（id 首次分配
   * 后冻结，目录改名也不会变）。所以"再建一次同名目录"在服务端就是"又指到了那个工作区"，
   * 客户端不该自己判重。
   *
   * 服务端的 `resolve` **不接受名字**（名字是纯展示用的 `title`，另一条窄方法写它）：
   * 用户填了名字就再补一次 `workspace.rename`，没填就让它继续空着（列表侧用目录名兜底）。
   */
  async create(name: string, cwd: string): Promise<Workspace> {
    const path = cwd?.trim() || this.options.defaultCwd();
    const resolved = await this.options.connection.call<WorkspaceResolveResult>(
      WORKSPACE_METHODS.resolve,
      { path },
    );
    const title = name?.trim();
    if (title) {
      await this.options.connection.call<WorkspaceRenameResult>(WORKSPACE_METHODS.rename, {
        workspaceId: resolved.workspaceId,
        title,
      });
    }
    return {
      id: resolved.workspaceId,
      name: title || basename(resolved.path),
      // 一律用服务端规范化后的路径：它才是会话真正跑的地方
      cwd: resolved.path,
    };
  }

  /** 改显示名（不动 id、不动 path） */
  async rename(id: string, name: string): Promise<void> {
    await this.options.connection.call<WorkspaceRenameResult>(WORKSPACE_METHODS.rename, {
      workspaceId: id,
      title: name,
    });
  }

  /**
   * 删工作区 —— 服务端把整个 `workspaces/<id>/` 删掉（含 `sessions/` 与续接指针），并
   * 关掉该工作区下还活着的会话。旧实现在这里挂的 `releaseWorkspace` 钩子因此不需要了。
   */
  async remove(id: string): Promise<void> {
    await this.options.connection.call<WorkspaceRemoveResult>(WORKSPACE_METHODS.remove, {
      workspaceId: id,
    });
  }
}

// ==================================================================
// conversation
// ==================================================================

export interface ServerConversationServiceOptions {
  connection: ServerConnection;
}

export class ServerConversationService {
  constructor(private readonly options: ServerConversationServiceOptions) {}

  /**
   * 侧栏的会话清单：服务端把「盘上存档 ∪ 内存活会话」合成一条（同一段会话只有一条），
   * 并按 `updatedAt` 倒序给好。
   *
   * `running = live && phase !== null`：`live` 只说明"在服务端内存里"，挂着不跑也算；
   * 侧栏那个小圆点要的是"正在跑"。
   */
  async list(workspaceId: string): Promise<ConversationSummary[]> {
    const result = await this.options.connection.call<SessionListResult>(SESSION_METHODS.list, {
      workspaceId,
    });
    return result.sessions.map((entry) => ({
      id: entry.sessionId,
      workspaceId,
      agentId: entry.agentId,
      // render 的模型下拉框读这一位当「当前模型」显示（`ChatPanel.vue` 的 `currentModelId`），
      // 所以它必须答「这段会话实际在用哪个模型」，而不是「这段会话有没有自己的覆盖」：
      // 协议里 `modelId` 是后者（缺省 = 跟着 Agent 定义 / 全局兜底走），只读它的话绝大多数
      // 会话的下拉框会空着 —— 改造前永远有值，这是行为回归。生效值由服务端给
      // （`effectiveModelId`，三级解析的唯一实现是 SDK 的 `resolveModel`）。
      //
      // 为什么还留着 `?? entry.modelId`：解析不出来时（那段会话指着已删的 Agent 定义、或
      // 三级都空）服务端**省略**该字段，此刻退回覆盖值至少是「用户自己选过的那一个」，比
      // 空串多一分信息。**绝不**在客户端按「覆盖 + 定义 + 默认」再推一遍 —— 那是优先级规则
      // 的第二份实现，正是这条协议字段要消灭的东西。
      modelId: entry.effectiveModelId ?? entry.modelId ?? "",
      name: entry.title ?? fallbackConversationName(entry.updatedAt),
      messageCount: entry.messageCount,
      updatedAt: entry.updatedAt,
      running: entry.live && entry.phase !== null,
    }));
  }

  /**
   * 新建一段会话。
   *
   * 模型**不由客户端指定**：服务端按「会话级覆盖 > Agent 定义 > 全局默认」三级解析，
   * 解析结果只在快照里出现，所以建完必须再要一次 `session.snapshot` —— 顺便把初始消息
   * （Agent 定义的预设 system/few-shot）也一起拿到，旧实现正是把这份预设写进库里。
   */
  async create(workspaceId: string, agentId: string): Promise<Conversation> {
    const created = await this.options.connection.call<SessionCreateResult>(
      SESSION_METHODS.create,
      { workspaceId, agentId },
    );
    const snapshot = await this.options.connection.call<SessionSnapshotResult>(
      SESSION_METHODS.snapshot,
      { sessionId: created.sessionId },
    );
    const now = new Date().toISOString();
    return {
      id: created.sessionId,
      workspaceId,
      agentId: created.agentId,
      modelId: snapshot.modelId,
      name: fallbackConversationName(now),
      messages: snapshot.messages as AgentNS.Message[],
      // 协议里没有创建/更新时间（`SessionRecord` 只有 `updatedAt`，且只在写档时出现），
      // 刚建出来的这一段，"现在"就是它唯一诚实的两个时间
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * 读一段会话（含消息）。
   *
   * 协议**没有只读的 read**：`session.snapshot` 只认活会话（服务端 `require()` 不到就报
   * `unknown-session`），盘上的存档要先 `attach` 装回内存。所以是两跳，而且 `attach`
   * 对活着的会话是空操作（立刻回同一个 id）。
   *
   * 名字与时间**不在快照里**（`SessionSnapshotResult` 只给消息、模型、阶段），所以在快照
   * 之外再要一次 `session.list`，从那一行取 `title` 与 `updatedAt`。
   *
   * 这里曾经有一个「顺序不能反过来」的约束：那时服务端把「装回内存的此刻」当成这段会话的
   * `updatedAt`，所以必须先 `list` 后 `attach`，否则读回来的是「我刚读它的时间」。
   * `agents@e93158b` 把那个缺陷堵了（续接沿用存档里的时间，`attach` 不再算一次活动），
   * 这个约束因此**不存在了** —— 现在两步的先后只影响多一次还是少一次往返，不影响结果。
   * 顺序仍保留 list 在前：少一次「先拿一个错值再改正」的窗口。read 是低频调用（render
   * 目前甚至没人调它），多这一次往返不做缓存 —— 缓存等于客户端存一份服务端的真相，
   * 迟早与它不一致。
   *
   * 找不到时回 `null`：旧签名声明了这条返回值，服务端用 `session-missing` 这个码表达
   * 同一件事 —— 在这里翻回 `null`，调用方不必认识服务端的错误码。
   */
  async read(workspaceId: string, id: string): Promise<Conversation | null> {
    // 先读清单（理由见上）。复用 `list` 而不是自己再拼一遍："read 的名字/时间与侧栏那一条
    // 一致"这件事，因此由同一处实现保证
    const summary = (await this.list(workspaceId)).find((item) => item.id === id);
    try {
      await this.options.connection.call(SESSION_METHODS.attach, { workspaceId, sessionId: id });
    } catch (error) {
      if ((error as { code?: string }).code === "session-missing") return null;
      throw error;
    }
    const snapshot = await this.options.connection.call<SessionSnapshotResult>(
      SESSION_METHODS.snapshot,
      { sessionId: id },
    );
    // 清单里没有这一条，只可能是「list 与 attach 之间它刚被另一条连接建出来」这种竞态：
    // 那一刻的快照也给不出时间，而「此刻」正是它唯一诚实的时间
    const updatedAt = summary?.updatedAt ?? new Date().toISOString();
    return {
      id,
      workspaceId,
      agentId: snapshot.agentId,
      modelId: snapshot.modelId,
      name: summary?.name ?? fallbackConversationName(updatedAt),
      messages: snapshot.messages as AgentNS.Message[],
      // 协议没有创建时间（`SessionRecord` 只有清单侧的 `updatedAt`，且它在写入时才刷新）：
      // 这一段**取的是最后一次更新时间，不要当创建时间用**。宁可如实说清，也不编一个
      // 「现在」—— 那会让排序与「这段会话多久没动过」全部失真
      createdAt: updatedAt,
      updatedAt,
    };
  }

  /** 删会话：服务端先关掉活会话再物理删存档（幂等，"本来就没有"不算错） */
  async remove(workspaceId: string, id: string): Promise<void> {
    await this.options.connection.call<SessionRemoveResult>(SESSION_METHODS.remove, {
      workspaceId,
      sessionId: id,
    });
  }

  /** 改显示名（不动 id；服务端会拒绝空名字，那是协议层的必填约束） */
  async rename(workspaceId: string, id: string, name: string): Promise<void> {
    await this.options.connection.call(SESSION_METHODS.rename, {
      workspaceId,
      sessionId: id,
      title: name,
    });
  }

  /** 换这一段会话的模型：只写会话级覆盖，服务端随即按新模型重建 Agent */
  async setModel(workspaceId: string, id: string, modelId: string): Promise<void> {
    await this.options.connection.call(SESSION_METHODS.modelSet, { sessionId: id, modelId });
  }
}

// ==================================================================
// agent / model
// ==================================================================

export interface ServerAgentServiceOptions {
  connection: ServerConnection;
}

export class ServerAgentService {
  constructor(private readonly options: ServerAgentServiceOptions) {}

  /**
   * 入口 Agent 列表。
   *
   * 服务端已经把两类定义分好（`{agents, subAgents}`），旧实现那句「过滤掉 SubAgent」
   * （按 `definition.function` 判断）因此删掉 —— 判定只该在分目录的地方做一次。
   */
  async list(): Promise<AgentOption[]> {
    const result = await this.options.connection.call<AgentListResult>(AGENT_METHODS.list);
    // 线上是 `unknown[]`（协议不解释定义的形状）：到这一层才回收成 Agent 定义
    return (result.agents as AgentDefinition[]).map((agent) => ({
      id: agent.id,
      name: agent.name,
      description: agent.description,
    }));
  }
}

export interface ServerModelServiceOptions {
  connection: ServerConnection;
}

export class ServerModelService {
  constructor(private readonly options: ServerModelServiceOptions) {}

  /** 模型下拉。协议里没有 `model.list`：模型清单是全局配置的一个字段，只能整份读 */
  async list(): Promise<ModelOption[]> {
    const result = await this.options.connection.call<ConfigGetResult>(CONFIG_METHODS.get);
    const config = result.config as AppConfig;
    return config.models.map((model) => ({ id: model.id, name: model.name }));
  }
}

// ==================================================================
// config
// ==================================================================

export interface ServerConfigServiceOptions {
  connection: ServerConnection;
}

export class ServerConfigService {
  constructor(private readonly options: ServerConfigServiceOptions) {}

  /**
   * 设置页要的那一小撮字段。
   *
   * `dataDir` 取 `config.json` 的**服务端**路径的目录：客户端算不出服务端的数据目录
   * （两机部署时更不存在），所以这条路径由服务端随配置一起回来。
   */
  async get(): Promise<ConfigSettings> {
    const result = await this.options.connection.call<ConfigGetResult>(CONFIG_METHODS.get);
    const config = result.config as AppConfig;
    const endpoints: EndpointSettings[] = config.endpoints.map((endpoint) => ({
      id: endpoint.id,
      name: endpoint.name,
      baseUrl: endpoint.baseUrl,
      apiKey: endpoint.apiKey ?? "",
      description: endpoint.description,
    }));
    return {
      endpoints,
      defaultModel: config.defaultModel ?? "",
      defaultAgent: config.defaultAgent ?? "",
      dataDir: dirname(result.path),
    };
  }

  /**
   * 保存设置。
   *
   * 两个默认值走**窄方法**（各写一个字段），不是「读整份 → 改一个字段 → 整份写回」：
   * 终端与桌面端同时开着时，整份写回会把对方刚改的字段一起抹掉。
   *
   * 端点的 `apiKey / baseUrl / name` 没有窄方法（协议只有 `config.mcp.save` 那一族，
   * 没有 `config.endpoint.set`），只能整份 `config.save` —— 这是这一阶段唯一还剩的
   * 丢更新窗口，代价写在改造报告里。
   *
   * 空串**不写**：旧实现里空串的含义是"这个字段没值"，而服务端的窄方法只接受非空 id
   * （空串是 `bad-params`）。也没有"清空默认值"的协议方法，所以没有等价的写入。
   */
  async update(input: Partial<ConfigSettings>): Promise<void> {
    if (input.defaultModel) {
      await this.options.connection.call(CONFIG_METHODS.defaultModelSet, {
        modelId: input.defaultModel,
      });
    }
    if (input.defaultAgent) {
      await this.options.connection.call(CONFIG_METHODS.defaultAgentSet, {
        agentId: input.defaultAgent,
      });
    }
    if (input.endpoints) {
      const result = await this.options.connection.call<ConfigGetResult>(CONFIG_METHODS.get);
      const config = result.config as AppConfig;
      for (const edit of input.endpoints) {
        const target = config.endpoints.find((endpoint) => endpoint.id === edit.id);
        if (!target) continue;
        if (edit.apiKey !== undefined) target.apiKey = edit.apiKey;
        if (edit.baseUrl !== undefined) target.baseUrl = edit.baseUrl;
        if (edit.name !== undefined) target.name = edit.name;
      }
      await this.options.connection.call(CONFIG_METHODS.save, { config });
    }
  }
}

// ==================================================================
// chat
// ==================================================================

export interface ServerChatServiceOptions {
  connection: ServerConnection;
  events: ChatEventBridge;
}

export class ServerChatService {
  constructor(private readonly options: ServerChatServiceOptions) {}

  /**
   * 开始一轮。
   *
   * `session.send` **立刻**回 `turnId`，过程与结果全走事件（一轮可能跑几分钟，等它回来
   * 就没东西可渲染了）。`turnId` 交给事件层做归轮，本方法照旧返回 `void`（render 的
   * `sendChatMessage` 就是这个签名）。
   *
   * 两条失败出口与旧实现对齐：
   *   - `turn-busy`（上一轮还没收尾）→ **静默忽略**。旧实现在运行注册表里看到该会话
   *     `isHasPendingMessage` 就直接 return，render 侧看不到任何东西；这里保持同一行为，
   *     不然"多点了一下发送"会弹一条看不懂的英文错误。
   *   - 其余错误（会话不在、连接断了）→ 推 `error` 事件。旧实现也是把"取 agent 阶段"的
   *     错误推成事件而不是让 IPC 抛错，render 的 `send()` 因此永远正常返回。
   *
   * 前提：会话已经 attach 过（`conversation.create` 与 `chat.getState` 都做了）。服务端的
   * `session.send` 只认内存里的活会话 —— 盘上的存档要先 `attach`（协议缺口①）。
   *
   * `workspaceId` 只是为了与 render 的签名一致留着：`session.send` 只认会话 id（会话已
   * 知道自己属于哪个工作区），这里不再拿它去查任何东西。
   */
  async send(workspaceId: string, conversationId: string, content: string): Promise<void> {
    // 事件可能比这次调用的回执**先**到（服务端在 beginTurn 后就推第一条阶段事件），
    // 所以正文要在发请求之前登记好，否则第一批增量到了却不知道该给哪条 user 消息
    this.options.events.noteSend(conversationId, content);
    try {
      await this.options.connection.call<SessionSendResult>(SESSION_METHODS.send, {
        sessionId: conversationId,
        content,
      });
    } catch (error) {
      this.options.events.dropSend(conversationId);
      if ((error as { code?: string }).code === "turn-busy") return;
      this.options.events.pushError(conversationId, errorMessageOf(error));
    }
  }

  /** 中止本轮：服务端掐掉正在流的那一段，随后照常走 `turn.end` 收尾（保留已生成内容） */
  async abort(conversationId: string): Promise<void> {
    await this.options.connection.call(SESSION_METHODS.cancel, { sessionId: conversationId });
  }

  /**
   * 会话实时状态（render 每次点开会话都调它）。
   *
   * 先 `attach` 再 `snapshot`：`snapshot` 只对**活**会话可用，而侧栏里点开的常常是盘上的
   * 历史（协议缺口①）。`attach` 对活会话是空操作，对存档是"装回内存"，两条路收敛成一条，
   * 不用 try/catch 猜是哪一种。
   */
  async getState(workspaceId: string, conversationId: string): Promise<ConversationState> {
    await this.options.connection.call(SESSION_METHODS.attach, {
      workspaceId,
      sessionId: conversationId,
    });
    const snapshot = await this.options.connection.call<SessionSnapshotResult>(
      SESSION_METHODS.snapshot,
      { sessionId: conversationId },
    );
    return {
      messages: snapshot.messages as AgentNS.Message[],
      // 「在跑」的唯一判据是阶段：阶段为 null 就是空闲
      streaming: snapshot.phase !== null,
    };
  }

  /**
   * 释放一段会话（服务端摘事件、让出 Agent 与 Scope 引用，**不删存档**）。
   *
   * 删除路径不需要它了：`session.remove` / `workspace.remove` 在服务端已经会关掉活会话。
   * 服务端的 `close` 不掐正在跑的那一轮（那一轮会自己跑完、存档照写），与旧实现「先
   * abort 再放手」略有差别 —— 差别只在"关一个正在跑的会话"这一种情况，而 render 没有
   * 这条路径（它只删会话，走 remove）。
   */
  async release(conversationId: string): Promise<void> {
    await this.options.connection.call(SESSION_METHODS.close, { sessionId: conversationId });
  }
}

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
