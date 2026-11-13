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
 * ## 四条纪律
 *
 * 1. **不自己算规则**：侧栏顺序、消息条数、`running`、生效模型都由宿主给（`conversation.list`
 *    的每一项就是它算好的），客户端再推一遍就是第二份会漂的实现；
 * 2. **消息本体是 core 的 `AgentNS.Message`**，原样来回搬，不重新包装字段（`message.list` 给的
 *    就是那个类型）；内容段、工具调用、用量同理；
 * 3. **结构化的宿主事实不拍平**：`folder`（路径 + 还在不在）、`model`（id + 名字 + 能不能看图
 *    + 谁定的）这类成组的事实整块搬，不取其中一字段压成一个值（R75 的同一条原则）；
 * 4. **契约没有的东西不造**：render 要而这一波没接的（子 Agent 栏目、通知的手动清除），
 *    宁可留空并在 `events.ts` 里说清，也不编一个像样的假值。
 */

import { getAsset as fetchAssetContent } from "@ai-zen/agents-client";
import type { AgentNS } from "@ai-zen/agents-client";
import type {
  AgentOption,
  AssetContent,
  AssetVariant,
  AttachmentInput,
  ChatState,
  ConfigSettings,
  ConfigUpdateReport,
  Conversation,
  ConversationSummary,
  EndpointSettings,
  FolderFact,
  ModelOption,
  QuestionAnswerResult,
  QuestionView,
  Workspace,
} from "@ai-zen/desktop-shared";
import { mergeAttachmentOutcomes, uploadAttachments } from "./attachments.js";
import type { ContractCall, ContractConnection } from "./contract.js";
import type { ChatEventBridge } from "./events.js";
import { problemOf } from "./problem.js";

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

export class HostWorkspaceService {
  constructor(private readonly ctx: ServiceContext) {}

  /** 全部项目（宿主已按 `createdAt` 倒序 / 置顶优先排好，客户端不重排） */
  async list(): Promise<Workspace[]> {
    const { workspaces } = await this.ctx.call("workspace.list", {});
    return workspaces.map(toWorkspace);
  }

  /**
   * 建（或复用）一个项目。
   *
   * `cwd` 为空时用桌面端的默认目录（`app.getPath("desktop")`）—— 那是**本机**的事实，宿主
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
   * 删项目 —— 宿主连带删它名下的对话（PRD D11），目录本身它永不碰。
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

export class HostConversationService {
  constructor(private readonly ctx: ServiceContext) {}

  /** 侧栏的会话清单（顺序、条数、`running` 全由宿主给） */
  async list(workspaceId: string): Promise<ConversationSummary[]> {
    const { conversations } = await this.ctx.call("conversation.list", { workspaceId });
    return conversations.map(toSummary);
  }

  /**
   * 新建一段会话。
   *
   * 助手与模型在创建时定死（PRD L7）：`agentId` 由 render 选，模型由宿主按「助手定义 > 兜底」
   * 解析，客户端不指定、也不猜。
   */
  async create(workspaceId: string, agentId: string): Promise<Conversation> {
    const { conversation } = await this.ctx.call("conversation.create", { workspaceId, agentId });
    // 预设消息（助手定义里的 system / few-shot）由宿主写进会话，客户端只读：刚建出来的这一段
    // 可能已经有几条，所以照常规取一次
    const listed = await this.ctx.call("message.list", { conversationId: conversation.id });
    return {
      id: conversation.id,
      workspaceId: conversation.workspaceId,
      agentId: conversation.agentId,
      model: conversation.model,
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
        model: conversation.model,
        name: conversation.name,
        messages: listed.messages,
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
      };
    } catch (error) {
      // 宿主用 `not_found` 表达「这段对话不在」：在这里翻回 `null`，调用方不必认识业务码
      if (isBiz(error, "not_found")) return null;
      throw error;
    }
  }

  /** 硬删（PRD D17；宿主按引用清理图片） */
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

export class HostAgentService {
  constructor(private readonly ctx: ServiceContext) {}

  /**
   * 入口助手列表。
   *
   * 子 Agent（定义里带 `function`）不进这个列表：它们不是「开一段对话」的入口（宿主用
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

export class HostModelService {
  constructor(private readonly ctx: ServiceContext) {}

  /**
   * 模型下拉的候选。
   *
   * 只给**现在能用**的：下拉框里选一个不可用的模型，发出去必然失败，而失败原因（端点缺密钥之类）
   * 在对话才显示就太晚了。不可用的那些仍然在宿主清单里（`model.list` 默认全给），设置页要列
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

export class HostConfigService {
  constructor(private readonly ctx: ServiceContext) {}

  /**
   * 设置页要的那一小撮字段。
   *
   * `dataDir` 是宿主给的 `configDir`：两机部署时客户端算不出对面把配置放在哪，所以这条路径
   * 只能由宿主随配置一起回来。
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
   * 两处「没写」照实回报（`ConfigUpdateReport` 的存在理由）：默认值是空串（宿主的窄方法只收非空
   * id）、端点 id 在宿主已经不存在。界面据此说一句真话，而不是把「没落盘」当成「已保存」。
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
      // 现读一次是为了拿到掩码与「宿主还有没有这个端点」—— 面板开着的时候它可能已经被别的
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

export class HostChatService {
  constructor(private readonly ctx: ServiceContext) {}

  /**
   * 发一段消息（可带图片附件）。**受理即返回**（PRD F-I12）：`conversation.send` 回来的是两个消息
   * id，过程与结果全走事件。
   *
   * ## 附件的顺序（PRD D5 / F-H7 / F-H8）
   *
   * ```
   * render 给的字节 → uploadAssets（asset.begin / 分片 / asset.end）→ assetIds
   *                  → conversation.send { input: { content, assetIds } }
   * ```
   *
   * 上传必须发生在 `conversation.send` **之前**：`assetIds` 是「已经传上去的那几张」的 id，而素材
   * 怎么变成内容段（文件引用 / 内联 / 退化成文字）由宿主按实发模型决定。
   *
   * ## 上传失败不阻挡发送
   *
   * 一张都没传上去时这一轮就是**纯文本**（F-H7 的「全失败退回纯文本」）：文字照发，附件的结局逐张
   * 上屏。把失败往上抛只会让用户连字都发不出去 —— 而失败原因本来就是他要看的一句话，不是异常。
   *
   * ## 三条出口
   *
   *   · 受理了 → 立刻把 `user` + `start` 推给 render（id 是宿主给的，不必编），随后推这一轮各附件
   *     的结局；
   *   · `busy`（这段对话正跑着一轮，PRD D14）→ 什么都不推：那是「多点了一下发送」，不是错误；
   *   · 其余（`question_pending`、会话不在、连接断了）→ 推 `error`。不让 IPC 抛错：render 的
   *     `send()` 因此永远正常返回，错误条由事件驱动。
   */
  async send(
    workspaceId: string,
    conversationId: string,
    content: string,
    attachments?: AttachmentInput[],
  ): Promise<void> {
    void workspaceId; // 渲染层签名如此；契约只认会话 id

    try {
      // 上传放在 try 里：它自己已经把「一张没传上去」收敛成返回值了，这里兜的是意料之外的抛错
      // —— 那也该走 `error` 事件说一句话，而不是让 `chat.send` 变成一个 reject。
      const files = attachments ?? [];
      const upload =
        files.length === 0
          ? { assets: [], failures: [] }
          : await uploadAttachments(this.ctx.connection(), conversationId, files);
      const assetIds = upload.assets.map((asset) => asset.assetId);

      const accepted = await this.ctx.call("conversation.send", {
        conversationId,
        input: { content, ...(assetIds.length > 0 ? { assetIds } : {}) },
      });
      // 上屏的是宿主落库的那条消息（`message.list` 里取回来），不是手上这句 `content`
      await this.ctx.events.beginTurn(conversationId, accepted.userMessageId);
      // 上传阶段已有的失败与宿主给的结局合到一份逐张账上（顺序 = 用户摆放的顺序）
      this.ctx.events.pushAttachments(
        conversationId,
        accepted.userMessageId,
        mergeAttachmentOutcomes(upload, accepted.attachments),
      );
    } catch (error) {
      if (isBiz(error, "busy")) return;
      this.ctx.events.pushError(conversationId, problemOf(error));
    }
  }

  /**
   * 取一份历史图片的字节（`asset.get`）：气泡里那段 `image_url` 引用的素材，按 id 换回内容。
   *
   * ## 为什么这条能力长在 `chat` 上而不是另开一个键
   *
   * 分发键就是 render 的调用面，而 render 的 `apis/*.ts` 与这六个键一一对应：新增第七个键要
   * 同步改掉六处「六个键 = 宿主调用面」的口径，换来的只是把同一屏的读写拆到两个文件里。
   * 「一条消息里的图能不能显示」与 `send` / `getState` 是同一件事的两半（发送时把图传上去、
   * 重开时把图取回来），所以它落在 `chat` 上。
   *
   * ## 整份引用下传，不挑字段
   *
   * 宿主 `asset.get` 回的是 `{ asset, variant, data }`：`asset` 是**整份** `AssetRef`（素材 id、
   * mime、字节数、文件名、原图宽高），`variant` 是实际给出的那一档。这一层只把 `data` 的 base64
   * 解成字节（客户端库已经做了），其余原样交给 render —— 挑几个字段搬，剩下的就再也拿不到了，
   * 宿主将来加字段也一样。
   *
   * ## 不碰缓存
   *
   * 什么时候取、取一次用几次、`blob:` URL 什么时候回收，全在 render（同一屏里同一份素材只该
   * 走一次这条通道）。这里既不缓存、也不重试：取不到就把错误原样抛上去（PRD F-H8 明确不做
   * 自动重试、不判失效、不做过期清理）。
   */
  async getAsset(assetId: string, variant: AssetVariant = "thumb"): Promise<AssetContent> {
    return await fetchAssetContent(this.ctx.connection(), { assetId, variant });
  }

  /**
   * 挂在这段对话上的问题（`question.list`，PRD D22 / F-I9：**多端看到同一个问题**）。
   *
   * ## 为什么打开对话不能只靠推送
   *
   * 推送只说「此刻起了什么变化」，不重放。于是另开一个窗口时、断线重连之后、或者这道题在
   * 本端还没连上时就已经挂上了 —— 那几种情况下本端一条 `question` 事件都收不到，界面上就是
   * 「对话没坏，但一发消息就被 `question_pending` 拒」（PRD D23）。所以打开一段对话时现拉一次，
   * 答完之后再拉一次（多端同时挂着两道题的时候，答掉一道还有另一道）。
   *
   * ## 整份 `QuestionView` 原样回
   *
   * `prompt` / `options[]` / `answer` / `blocking` / `kind` / `state` 全在宿主那一份里，
   * 界面要哪个读哪个。这一层只拆掉出参的壳（`{ questions }` → 数组），不挑字段、不改形状 ——
   * 挑掉的字段在这里就永久消失了（宿主将来加一个候选说明也一样）。
   *
   * 不传 `state` 过滤：已答 / 已过期的那些也一起回来，界面按 `state` 决定显不显示
   * （宿主那份 `ConversationState.questions` 就是这么给的，两处口径一致）。
   */
  async questions(conversationId: string): Promise<QuestionView[]> {
    const { questions } = await this.ctx.call("question.list", { conversationId });
    return questions;
  }

  /**
   * 回答一道题（`question.answer`，PRD D22 / F-I9）：`question` 与 `effects` 原样交回 render。
   *
   * ## 答完之后接着做什么是宿主的结论
   *
   * `effects.handoffStarted` 说「开始交接了没有」，`effects.newConversationId` 说「交接顺带开出来
   * 的是哪一段新对话」（PRD D18：同 Workspace、同助手）。客户端据此换到那段新对话，自己不去猜
   * 「该不该开新会话」—— 那不是界面的事实。
   *
   * ## 这一层不作答、也不兜底
   *
   * 没有「默认选项」、没有超时自动答：答哪个值来自用户的点击（`options[].value`），这里只转发。
   * 替用户选一个等于替他决定「要不要交接、交接去哪」，而宿主不会超时取消这道题（PRD D23）——
   * 那道题会一直挂着，界面要做的正是把它摆出来等人答。
   */
  async answerQuestion(questionId: string, value: string): Promise<QuestionAnswerResult> {
    return await this.ctx.call("question.answer", { questionId, value });
  }

  /** 中止本轮（PRD D14：用户的显式动作，不排队）；收尾照常走 `run.state` 的 `settled` */
  async abort(conversationId: string): Promise<void> {
    await this.ctx.call("conversation.abort", { conversationId });
  }

  /**
   * 会话实时状态（render 每次点开会话都调它）。
   *
   * 一次调用拿齐两样：`conversation.state` 带 `includeMessages: true` —— 现场（这一段在不在跑、
   * 跑到哪一态、上下文、思考档位、用量、挂着的问题、状态栏那几块）与整段消息。分开调两次会
   * 在两份快照之间留一道缝：现场报的用量可能对应不到手上这批消息。
   *
   * ## 返回的就是宿主那两份，不加工
   *
   * `conversation.state` 那一份原样展开、再把 `messages` 接上去：宿主说
   * `run.status` 是 `running`，那就是在跑 —— 这一层不再把它压成一个 `streaming` 布尔（多一个
   * 派生值就多一份会与宿主说法漂开的第二真相）。界面要什么读什么，剩下的不因为今天没人画就
   * 在半路上丢掉。
   *
   * 把这条消息列表交给事件层当**基线**，并把本地锚点记成最后一条的 id：下一次断线重连，客户端库
   * 拿这个锚点做 `message.list({after})`，续传天然就是「那条的最新内容 + 之后的」。
   */
  async getState(workspaceId: string, conversationId: string): Promise<ChatState> {
    void workspaceId;
    const { state, messages } = await this.ctx.call("conversation.state", {
      conversationId,
      includeMessages: true,
    });
    // 要了 `includeMessages` 就一定有（`?? []` 只是让类型闭合）
    const list = messages ?? [];

    this.ctx.events.noteMessages(conversationId, list);
    this.ctx.events.noteState(state);

    const connection = this.ctx.connection();
    connection.track(conversationId, lastId(list));

    return { ...state, messages: list };
  }
}

// ==================================================================
// 内部
// ==================================================================

function toWorkspace(view: {
  id: string;
  name: string;
  folder: FolderFact;
}): Workspace {
  // `folder` 整块搬（路径 + 还在不在）：只取 `cwd` 就把「目录没了」这个事实棗掉了
  return { id: view.id, name: view.name, folder: view.folder };
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

/** 这个失败是不是宿主那个业务码（判伪看 `code`，不看句子） */
function isBiz(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;
}
