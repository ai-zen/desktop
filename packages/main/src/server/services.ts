/**
 * 六个 Service —— 每个方法只做一件事：**把 render 要的形状翻成契约调用，再把结果翻回来**。
 * 没有业务规则、没有本地状态、不碰磁盘。
 *
 * ## 分发键是 render 的调用面，不许跟着实现改名
 *
 * `workspace` / `conversation` / `agent` / `model` / `chat` / `config` 这六个键、以及每个键下面
 * 的方法名与参数顺序，全部来自 render 的 `apis/*.ts`（`invokeService(service, method, ...args)`）。
 * render 一行不动是这一波的硬约束，所以这里的方法名照旧，只是**另一头**换成了新契约。
 *
 * ## 三条纪律
 *
 * 1. **不自己算规则**：侧栏顺序、消息条数、`running`、生效模型都由服务端给（`conversation.list`
 *    的每一项就是它算好的），客户端再推一遍就是第二份会漂的实现；
 * 2. **消息本体是 core 的 `AgentNS.Message`**，原样来回搬，不重新包装字段（`message.list` 给的
 *    就是那个类型）；
 * 3. **契约没有的东西不造**：render 要而这一波没接的（子 Agent 栏目、通知的手动清除、提问 UI），
 *    宁可留空并在 `events.ts` 里说清，也不编一个像样的假值。
 */

import type { AgentNS } from "@ai-zen/agents-client";
import type {
  AgentOption,
  ConfigSettings,
  ConfigUpdateReport,
  Conversation,
  ConversationState,
  ConversationSummary,
  EndpointSettings,
  ModelOption,
  Workspace,
} from "@ai-zen/desktop-shared";
import type { ContractCall, ContractConnection } from "./contract.js";
import type { ChatEventBridge } from "./events.js";

/**
 * 服务共用的那几样东西。
 *
 * `connection` 是**取连接的动作**而不是一条连接：客户端库在重连时换掉底层 socket（对象本身不变），
 * 而把这些服务与「这一条」绑死没有任何好处 —— 每次现取，「哪条连接」就只有一个来源。
 */
export interface ServiceContext {
  /** 发一次契约调用 */
  call: ContractCall;
  /** 当前这条连接（`chat` 要 `resume` / `track`，见那边的注释） */
  connection: () => ContractConnection;
  /** 事件出口（`chat.send` 受理之后要立刻回显，收尾要靠它） */
  events: ChatEventBridge;
  /** 用户不填目录时的默认工作目录（桌面端注入 `app.getPath("desktop")`） */
  defaultCwd: () => string;
}

// ==================================================================
// workspace
// ==================================================================

export class ServerWorkspaceService {
  constructor(private readonly ctx: ServiceContext) {}

  /** 全部项目（服务端已按 `createdAt` 倒序 / 置顶优先排好，客户端不重排） */
  async list(): Promise<Workspace[]> {
    const { workspaces } = await this.ctx.call("workspace.list", {});
    return workspaces.map(toWorkspace);
  }

  /**
   * 建（或复用）一个项目。
   *
   * `cwd` 为空时用桌面端的默认目录（`app.getPath("desktop")`）—— 那是**本机**的事实，服务端
   * 不可能知道，所以由这里补上再交出去。
   */
  async create(name: string, cwd: string): Promise<Workspace> {
    const input = cwd?.trim() || this.ctx.defaultCwd();
    const title = name?.trim();
    const { workspace } = await this.ctx.call("workspace.create", {
      cwd: input,
      ...(title ? { name: title } : {}),
    });
    return toWorkspace(workspace);
  }

  /** 改显示名（不动 id、不动 cwd；PRD D9 的 cwd 不可变） */
  async rename(id: string, name: string): Promise<void> {
    await this.ctx.call("workspace.rename", { workspaceId: id, name });
  }

  /**
   * 删项目 —— 服务端连带删它名下的对话（PRD D11），目录本身它永不碰。
   *
   * 不带 `dryRun`：render 的删除确认框问的是「连会话一起删」这件事本身，代价明细（几条会话几条
   * 消息）这一波没有界面显示；要显示的那天把 `dryRun: true` 先跑一遍即可。
   */
  async remove(id: string): Promise<void> {
    await this.ctx.call("workspace.remove", { workspaceId: id });
  }
}

// ==================================================================
// conversation
// ==================================================================

export class ServerConversationService {
  constructor(private readonly ctx: ServiceContext) {}

  /** 侧栏的会话清单（顺序、条数、`running` 全由服务端给） */
  async list(workspaceId: string): Promise<ConversationSummary[]> {
    const { conversations } = await this.ctx.call("conversation.list", { workspaceId });
    return conversations.map(toSummary);
  }

  /**
   * 新建一段会话。
   *
   * 助手与模型在创建时定死（PRD L7）：`agentId` 由 render 选，模型由服务端按「助手定义 > 兜底」
   * 解析，客户端不指定、也不猜。
   *
   * 目录还没登记成项目时服务端不建对话，而是回 `requiresRegistration`（PRD D10）—— 那个分支要
   * 用户先答一个问题，而桌面端这一波没有提问 UI（见 `events.ts` 文件头），所以这里当成失败**说
   * 清原因**，不静默返回一个空对话。
   */
  async create(workspaceId: string, agentId: string): Promise<Conversation> {
    const created = await this.ctx.call("conversation.create", { workspaceId, agentId });
    if (!created.conversation) {
      throw new Error(
        `这个目录还没登记成项目（${created.cwd ?? workspaceId}），要先回答「是否登记为项目」才能建对话 —— 桌面端还没有提问界面`,
      );
    }
    const conversation = created.conversation;
    // 预设消息（助手定义里的 system / few-shot）由服务端写进会话，客户端只读：刚建出来的这一段
    // 可能已经有几条，所以照常规取一次
    const listed = await this.ctx.call("message.list", { conversationId: conversation.id });
    return {
      id: conversation.id,
      workspaceId: conversation.workspaceId,
      agentId: conversation.agentId,
      modelId: conversation.model.modelId,
      name: conversation.name,
      messages: listed.messages,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
    };
  }

  /**
   * 读一段会话（含全部消息）。
   *
   * render 目前没有调用点（点开会话走 `chat.getState`），保留它是为了让 `apis/conversation.ts`
   * 的方法面与 main 对得上：少一个方法，那个 api 函数就成了一条会 reject 的死路。
   */
  async read(workspaceId: string, id: string): Promise<Conversation | null> {
    try {
      const { conversation } = await this.ctx.call("conversation.get", { conversationId: id });
      const listed = await this.ctx.call("message.list", { conversationId: id });
      return {
        id: conversation.id,
        workspaceId: conversation.workspaceId || workspaceId,
        agentId: conversation.agentId,
        modelId: conversation.model.modelId,
        name: conversation.name,
        messages: listed.messages,
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
      };
    } catch (error) {
      // 服务端用 `not_found` 表达「这段对话不在」：在这里翻回 `null`，调用方不必认识业务码
      if (isBiz(error, "not_found")) return null;
      throw error;
    }
  }

  /** 硬删（PRD D17；服务端按引用清理图片） */
  async remove(workspaceId: string, id: string): Promise<void> {
    void workspaceId; // 渲染层签名如此；契约只认会话 id（会话自己知道属于哪个项目）
    await this.ctx.call("conversation.delete", { conversationId: id });
  }

  /** 改名（不动 id、不动排序，PRD D1 / D13） */
  async rename(workspaceId: string, id: string, name: string): Promise<void> {
    void workspaceId;
    await this.ctx.call("conversation.rename", { conversationId: id, name });
  }

  /** 临时换模型（只活在内存、重开回默认，PRD L7 / F-B4） */
  async setModel(workspaceId: string, id: string, modelId: string): Promise<void> {
    void workspaceId;
    await this.ctx.call("conversation.setModel", { conversationId: id, modelId });
  }
}

// ==================================================================
// agent / model
// ==================================================================

export class ServerAgentService {
  constructor(private readonly ctx: ServiceContext) {}

  /**
   * 入口助手列表。
   *
   * 子 Agent（定义里带 `function`）不进这个列表：它们不是「开一段对话」的入口（服务端用
   * `isSubAgent` 明说了这件事，客户端不再按字段自己判）。
   */
  async list(): Promise<AgentOption[]> {
    const { agents } = await this.ctx.call("agent.list", {});
    return agents
      .filter((agent) => !agent.isSubAgent)
      .map((agent) => ({
        id: agent.id,
        name: agent.name,
        ...(agent.description ? { description: agent.description } : {}),
      }));
  }
}

export class ServerModelService {
  constructor(private readonly ctx: ServiceContext) {}

  /**
   * 模型下拉的候选。
   *
   * 只给**现在能用**的：下拉框里选一个不可用的模型，发出去必然失败，而失败原因（端点缺密钥之类）
   * 在对话才显示就太晚了。不可用的那些仍然在服务端清单里（`model.list` 默认全给），设置页要列
   * 的时候再拉一次就是。
   */
  async list(): Promise<ModelOption[]> {
    const { models } = await this.ctx.call("model.list", {});
    return models.filter((model) => model.available).map((model) => ({ id: model.id, name: model.name }));
  }
}

// ==================================================================
// config
// ==================================================================

export class ServerConfigService {
  constructor(private readonly ctx: ServiceContext) {}

  /**
   * 设置页要的那一小撮字段。
   *
   * `dataDir` 是服务端给的 `configDir`：两机部署时客户端算不出对面把配置放在哪，所以这条路径
   * 只能由服务端随配置一起回来。
   *
   * `apiKey` 里放的是**掩码**（`sk-…9f3a`）：新契约的明文密钥不出网（PRD F-F2）。设置页那个输入框
   * 因此显示的是掩码 —— 用户在框里改成一个新值就表示「换密钥」，原样不动就表示「不改」
   * （见 `update()` 的 `apiKeySet` 判定）。
   */
  async get(): Promise<ConfigSettings> {
    const { config } = await this.ctx.call("config.get", {});
    const endpoints: EndpointSettings[] = config.endpoints.map((endpoint) => ({
      id: endpoint.id,
      name: endpoint.name,
      baseUrl: endpoint.baseUrl,
      apiKey: endpoint.apiKeyMasked,
      ...(endpoint.description ? { description: endpoint.description } : {}),
    }));
    return {
      endpoints,
      defaultModel: config.defaults.defaultModel ?? "",
      defaultAgent: config.defaults.defaultAgent ?? "",
      dataDir: config.configDir,
    };
  }

  /**
   * 保存设置：默认项走 `config.setDefaults`，端点走 `config.saveEndpoint`（一个端点一次）。
   *
   * 两处「没写」照实回报（`ConfigUpdateReport` 的存在理由）：默认值是空串（服务端的窄方法只收非空
   * id）、端点 id 在服务端已经不存在。界面据此说一句真话，而不是把「没落盘」当成「已保存」。
   *
   * **密钥只在真的改了时才写**：框里显示的是掩码，把它原样回写会把掩码当成密钥存起来。所以
   * 「提交值 === 掩码」⇒ 省略 `apiKey`（契约里省略 = 保留原值）。
   */
  async update(input: Partial<ConfigSettings>): Promise<ConfigUpdateReport> {
    const skippedDefaults: ConfigUpdateReport["skippedDefaults"] = [];

    const defaults: { defaultModel?: string; defaultAgent?: string } = {};
    if (input.defaultModel) defaults.defaultModel = input.defaultModel;
    else if (input.defaultModel === "") skippedDefaults.push("defaultModel");
    if (input.defaultAgent) defaults.defaultAgent = input.defaultAgent;
    else if (input.defaultAgent === "") skippedDefaults.push("defaultAgent");
    if (Object.keys(defaults).length > 0) {
      await this.ctx.call("config.setDefaults", { defaults });
    }

    const writtenEndpointIds: string[] = [];
    const missingEndpointIds: string[] = [];
    if (input.endpoints) {
      // 现读一次是为了拿到掩码与「服务端还有没有这个端点」—— 面板开着的时候它可能已经被别的
      // 客户端删掉了
      const { config } = await this.ctx.call("config.get", {});
      for (const edit of input.endpoints) {
        const current = config.endpoints.find((endpoint) => endpoint.id === edit.id);
        if (!current) {
          missingEndpointIds.push(edit.id);
          continue;
        }
        const apiKey = edit.apiKey && edit.apiKey !== current.apiKeyMasked ? edit.apiKey : undefined;
        await this.ctx.call("config.saveEndpoint", {
          endpoint: {
            id: edit.id,
            name: edit.name,
            baseUrl: edit.baseUrl,
            ...(apiKey ? { apiKey } : {}),
            ...(edit.description !== undefined ? { description: edit.description } : {}),
          },
        });
        writtenEndpointIds.push(edit.id);
      }
    }

    return { writtenEndpointIds, missingEndpointIds, skippedDefaults };
  }
}

// ==================================================================
// chat
// ==================================================================

export class ServerChatService {
  constructor(private readonly ctx: ServiceContext) {}

  /**
   * 发一段消息。**受理即返回**（PRD F-I12）：`conversation.send` 回来的是两个消息 id，
   * 过程与结果全走事件。
   *
   * 三条出口：
   *   · 受理了 → 立刻把 `user` + `start` 推给 render（id 是服务端给的，不必编）；
   *   · `busy`（这段对话正跑着一轮，PRD D14）→ 什么都不推：那是「多点了一下发送」，不是错误；
   *   · 其余（`question_pending`、会话不在、连接断了）→ 推 `error`。不让 IPC 抛错：render 的
   *     `send()` 因此永远正常返回，错误条由事件驱动。
   */
  async send(workspaceId: string, conversationId: string, content: string): Promise<void> {
    void workspaceId; // 渲染层签名如此；契约只认会话 id
    try {
      const accepted = await this.ctx.call("conversation.send", {
        conversationId,
        input: { content },
      });
      this.ctx.events.beginTurn(conversationId, accepted.userMessageId, content);
    } catch (error) {
      if (isBiz(error, "busy")) return;
      this.ctx.events.pushError(conversationId, messageOf(error));
    }
  }

  /** 中止本轮（PRD D14：用户的显式动作，不排队）；收尾照常走 `run.state` 的 `settled` */
  async abort(conversationId: string): Promise<void> {
    await this.ctx.call("conversation.abort", { conversationId });
  }

  /**
   * 会话实时状态（render 每次点开会话都调它）。
   *
   * 两跳、串行：先 `conversation.state`（这一段在不在跑、跑到哪一态、用量、问题），再
   * `message.list`（整段消息，含流式中那条的部分内容 —— PRD L5）。
   *
   * 把这条消息列表交给事件层当**基线**，并把本地锚点记成最后一条的 id：下一次断线重连，客户端库
   * 拿这个锚点做 `message.list({after})`，续传天然就是「那条的最新内容 + 之后的」。
   */
  async getState(workspaceId: string, conversationId: string): Promise<ConversationState> {
    void workspaceId;
    const { state } = await this.ctx.call("conversation.state", { conversationId });
    const listed = await this.ctx.call("message.list", { conversationId });

    this.ctx.events.noteMessages(conversationId, listed.messages);
    this.ctx.events.noteState(state);

    const connection = this.ctx.connection();
    connection.track(conversationId, lastId(listed.messages));

    return {
      messages: listed.messages,
      // 「在跑」的唯一判据是服务端给的 `run.status`，客户端不自己推
      streaming: state.run.status === "running",
    };
  }
}

// ==================================================================
// 内部
// ==================================================================

function toWorkspace(view: {
  id: string;
  name: string;
  folder: { cwd: string };
}): Workspace {
  return { id: view.id, name: view.name, cwd: view.folder.cwd };
}

function toSummary(view: {
  id: string;
  workspaceId: string;
  agentId: string;
  modelId: string;
  name: string;
  messageCount: number;
  updatedAt: string;
  running: boolean;
}): ConversationSummary {
  return {
    id: view.id,
    workspaceId: view.workspaceId,
    agentId: view.agentId,
    // 侧栏这一行没有「临时换模型」的信息（`conversation.list` 只说创建时定的那个）：下拉框
    // 在选中某段对话之后由 `chat.getState` 的现场值补正
    modelId: view.modelId,
    name: view.name,
    messageCount: view.messageCount,
    updatedAt: view.updatedAt,
    running: view.running,
  };
}

/** 消息列表最后一条的 id（重连补拉的 `after`）；空列表时是 `undefined` */
function lastId(messages: readonly AgentNS.Message[]): string | undefined {
  return messages.at(-1)?.id;
}

/** 这个失败是不是服务端那个业务码（判伪看 `code`，不看句子） */
function isBiz(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
