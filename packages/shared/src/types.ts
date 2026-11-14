// ==================== 类型契约（shared）====================
// 实体 + IPC 事件 DTO。纯类型，零运行时。
// 消息模型直接沿用 Core 的 AgentNS.Message（三层统一，不做 adapter）。
//
// ## 宿主定过的形状一律引用，不再抄第二份
//
// 这一层曾经把宿主的 `LocalizedText` / `ProblemFact` / `FolderFact` / `ModelState` 重述了一遍
// （那时候 render 只被允许依赖已发布的 core）。现在 `@ai-zen/agents-host` 是一条**开发时依赖**：
// 这里 `import type` 它、原样再导出，同一份形状因此只有一个定义 —— 宿主改了字段，这里跟着改，
// 而不是各自漂。
//
// 运行期零依赖：`import type` 在编译产物里一个字节都不留，render 的产物由
// `packages/render/scripts/check-no-host-runtime.mjs` 在构建之后钉住这一条。

import type { AgentNS } from "@ai-zen/agents-core";
import type {
  AssetGetResult,
  AssetVariant,
  AttachmentDelivery,
  AttachmentOutcome as WireAttachmentOutcome,
  ConversationState,
  FolderFact,
  GenerationPhaseName,
  LocalizedText as WireLocalizedText,
  ModelState,
  NoticeLevel,
  ProblemFact as WireProblemFact,
  QuestionAnswer,
  QuestionAnswerResult,
  QuestionEffects,
  QuestionKind,
  QuestionOption,
  QuestionState,
  QuestionView,
} from "@ai-zen/agents-host";

// ==================== 宿主已有的形状（原样再导出）====================

export type {
  AssetVariant,
  AttachmentDelivery,
  ConversationState,
  FolderFact,
  ModelState,
  NoticeLevel,
  // 问题对象这一组（`question` 推送与 `chat.questions` / `chat.answerQuestion` 的里外都是它们）：
  // `QuestionView` 里装的就是 `QuestionOption` / `QuestionAnswer`，答完的后续动作是
  // `QuestionEffects`。render 直接按宿主那份读 `prompt.message` 之类，不另造一份 ViewModel。
  QuestionAnswer,
  QuestionAnswerResult,
  QuestionEffects,
  QuestionKind,
  QuestionOption,
  QuestionState,
  QuestionView,
};

/** 生成六态的名字：宿主 `GenerationPhaseName` 逐字一致（render 只按它挑界面用词） */
export type StreamPhase = GenerationPhaseName;

// ==================== 宿主的文案与事实 ====================

/**
 * 宿主 `LocalizedText`（`packages/host/src/wire/states.ts`）原样，只有一处放宽。
 *
 * 四样一起搬，而不是只搬那一句：`code` 是客户端按它分支的稳定码、`messageKey` 是文案表里的键、
 * `params` 是重排这句话要用的原始参数、`message` 是**当前连接语言**下能直接摆上屏的句子。
 *
 * ## `messageKey` 为什么允许空串
 *
 * 宿主那一份的 `messageKey` 是它文案表里的键。而 main 与客户端库自己产出的句子（连不上、
 * 拉起宿主失败、重连放弃……）不在那张表里：那些句子没有翻译，只有已经说好的那一句 `message`。
 * 放宽只往「多一种取值」的方向走 —— 宿主给的每一句仍然合法，反方向不成立。`code` 空串同理
 * 表示「这句不是宿主产出的」。其余字段一字不改地来自宿主那一份。
 */
export type LocalizedText = Omit<WireLocalizedText, "messageKey"> & {
  messageKey: WireLocalizedText["messageKey"] | "";
};

/**
 * 失败/降级这类「有事发生了」的事实：宿主 `ProblemFact` 原样（`LocalizedText` 之上多一个
 * **结构化的原因**：哪个工具、哪条错误、还差什么），只有 `messageKey` 同 {@link LocalizedText}
 * 一样允许空串。
 */
export type ProblemFact = Omit<WireProblemFact, "messageKey"> & {
  messageKey: WireLocalizedText["messageKey"] | "";
};

// ==================== Workspace ====================

export interface Workspace {
  id: string;
  name: string;
  /** 目录事实（宿主 `FolderFact`）：路径 + 还在不在，原样搬 */
  folder: FolderFact;
}

// ==================== Conversation ====================

export interface Conversation {
  id: string;
  workspaceId: string;
  agentId: string;
  /** 这段会话的**当前模型**（宿主 `ModelState` 原样：三级解析后的生效值，含名字与能不能看图） */
  model: ModelState;
  name: string;
  /** 直接沿用 Core 消息模型（三层统一，无 adapter） */
  messages: AgentNS.Message[];
  createdAt: string;
  updatedAt: string;
}

export interface ConversationSummary {
  id: string;
  workspaceId: string;
  agentId: string;
  /** 同上：模型下拉框要显示的**当前模型**（桌面端填入宿主清单里的 `effectiveModelId`，解析不出来时空串） */
  modelId: string;
  name: string;
  messageCount: number;
  updatedAt: string;
  /** 会话运行中标记（侧栏显示） */
  running?: boolean;
}

/**
 * `chat.getState` 的返回：宿主的**整份现场状态** + 这段对话的整段消息。
 *
 * 前半截就是宿主 `conversation.state` 的原文 —— `run`（在不在跑、跑到哪一态、结局、子 Agent、
 * 本轮用量）/ `context`（上下文占用与两条线）/ `thinking`（思考强度档位）/ `usage`（三个口径与
 * 速率）/ `questions`（挂在这段对话上的问题）/ `statusBlocks`（状态栏那几块事实）全在里面，一个
 * 字段都不在客户端侧丢掉：界面今天只画其中一部分，不等于另一部分不存在。
 *
 * 后半截是 `message.list` 给的消息本体（宿主的现场状态里没有消息，而「重开这段对话看到的那一屏」
 * 是这两样合起来）。
 *
 * 「在不在跑」**不另给一个布尔**：它就是 `run.status === "running"`。派生值留在这里只会多一份会
 * 与宿主说法漂开的第二真相。
 */
export interface ChatState extends ConversationState {
  /** 整段消息（含流式中那条的部分内容），core 原样 */
  messages: AgentNS.Message[];
}

// ==================== 附件（图片）====================

/**
 * 一张要上传的附件 —— render → main 的 IPC 形状。
 *
 * ## 为什么是「字节 + 类型 + 名字」这样三件
 *
 * render 手上只有 `File` / `Blob` / dataURL（剪贴板图片、文件选择器给的都是这些），而 main 那一头
 * 要的是能直接交给客户端库 `uploadAssets` 的东西：字节（`Uint8Array`，IPC 走结构化克隆，原样到）
 * 与这个字节**自称**的类型。名字只是给用户看的（「哪一张没发出去」），宿主落盘不用它拼路径。
 *
 * `data` 里没有 base64：dataURL 只在 render 内部用来做缩略图预览，跨进程传的是原始字节。
 */
export interface AttachmentInput {
  /** MIME 类型（如 `image/png`）；拿不到真实类型时传 `application/octet-stream`，不在这一层猜 */
  mime: string;
  /** 原始文件名（剪贴板图片没有名字，那时省略） */
  name?: string;
  /** 字节本体 */
  data: Uint8Array;
}

/**
 * 一张附件这一轮的结局 —— 宿主 `AttachmentOutcome` 原样，另加一个名字。
 *
 * `section` 是它**真正变成的那个内容段**（core 的 `MessageContentSection`：内联图片是 `image_url`、
 * Files API 是 `file`、降级成文字是 `text`）—— 界面要显示「它最后成了什么」时读的是这一份，
 * 不是从 `deliveredAs` 反推。
 *
 * `problem` 是宿主/客户端库给的**结构化原因**（码 + 参数 + 已渲染的那句 + detail），界面原文显示
 * `problem.message`、一字不改（另写一份措辞就有两种说法，其中一份还不跟着语言变，D8）；
 * 需要按码分支时读 `problem.code`。没有 `problem` 就是没事（`file_reference` / `inline` /
 * `text_fallback` 正常走完），界面不打扰。
 *
 * `problem` 用的是这一层那份（`messageKey` 允许空串）：没传上去的那几张，原因是客户端库在
 * **上传阶段**说的（空文件、认不出类型），那些句子没有宿主的文案键。
 */
export type AttachmentOutcome = Omit<WireAttachmentOutcome, "problem"> & {
  /** 没送达 / 降级时的原因（结构化）；没有就是 `null` */
  problem: ProblemFact | null;
  /** 这张叫什么（宿主给了就用它给的，本地失败时是用户选的那个名字） */
  name: string | null;
};

// ==================== 素材（历史图片回显）====================

/**
 * `chat.getAsset` 的返回：宿主 `asset.get` 的整份回包，只把 base64 换成字节。
 *
 * 宿主那一份是 `{ asset: AssetRef, variant, data }`；到这里去掉 `data`、换成 `bytes`。
 * `asset` 是**整份引用**：`assetId` / `mime` / `bytes`（字节数）/ `name` / `width` / `height`
 * 全在，调用方要哪个读哪个（只挑四个字段搬，剩下的就再也拿不到了 —— 宿主加字段时也一样）。
 *
 * `variant` 是**实际给出的那一档**：`thumb` 目前等同原图（宿主这一波不引入原生图像库），
 * 它如实回报给了哪一档，客户端按 `asset.width` / `asset.height` 自己缩，不造一份假缩略图。
 *
 * `bytes` 走 IPC 的结构化克隆（与 `AttachmentInput.data` 同一种形状，只是反过来走：main → render），
 * 不经 base64。render 拿到它做两件事：`new Blob([bytes], { type: asset.mime })` 造一个 `blob:` URL
 * 交给 `<img>`，以及按 `asset.width` / `asset.height` 先摆好占位框（R76：解码完成前就按原比例占住
 * 位置，气泡不抖）。
 */
export type AssetContent = Omit<AssetGetResult, "data"> & {
  /** 字节本体 */
  bytes: Uint8Array;
};

// ==================== Agent / Model 选项 ====================

export interface AgentOption {
  id: string;
  name: string;
  description?: string;
}

export interface ModelOption {
  id: string;
  name: string;
}

// ==================== 设置页（ConfigService） ====================

/** 端点设置（设置页可编辑 API Key / 地址 / 名称） */
export interface EndpointSettings {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  description?: string;
}

export interface ConfigSettings {
  /** 全部端点（含 API Key，桌面本地应用场景明文展示） */
  endpoints: EndpointSettings[];
  /** 默认模型（config.defaultModel） */
  defaultModel: string;
  /** 默认 Agent（config.defaultAgent） */
  defaultAgent: string;
  /** 数据目录（只读：宿主 `config.json` 所在目录，由宿主随配置一起回来） */
  dataDir: string;
}

/**
 * `config.update` 的回报：**这次真的写进去了什么**。
 *
 * main 的 `HostConfigService.update()` 有两处「故意不写」—— 端点按 id 匹配不上、空的
 * 默认值没有窄方法可写。两处都不该改成别的写法（见那边的注释），但**不吭声**是另一回事：
 * 调用方拿到的 `void` 让它只能靠「保存后再读一遍」去猜自己写进去没有，而那次重读与这次
 * 写入之间还隔着一个窗口。
 *
 * 所以让它**自己报**：写了哪些、哪些没写、为什么没写。界面据此说一句真话，而不是替用户
 * 把「没落盘」当成「已保存」。
 */
export interface ConfigUpdateReport {
  /** 这次真的落到盘上的端点 id */
  writtenEndpointIds: string[];
  /** 宿主配置里已经没有、这次没写进去的端点 id（用户在那些框里改的 apiKey 丢了） */
  missingEndpointIds: string[];
  /** 值是空串、因此没有写入的默认字段（宿主的窄方法只接受非空 id） */
  skippedDefaults: Array<"defaultModel" | "defaultAgent">;
}

// ==================== 连接设置（本地 / 远程） ====================

/**
 * 连哪台宿主：`local` = 老路（地址读 `<AI_ZEN_DIR>/run/host.json`，凭证读 `<AI_ZEN_DIR>/run/token`）；
 * `remote` = 用户显式填的那一台（可能在他自己机器上，也可能在隧道另一端）。
 *
 * ## 为什么只有两档，且 `local` 不叫 `loopback`
 *
 * 决策 D9 明文**不做静态的 loopback 判断**：隧道的入口恰恰是 `127.0.0.1:9999`（`ssh -L` /
 * `kubectl port-forward` / tailscale serve 都长这样），从地址上分不出「本机 daemon」与
 * 「隧道另一端」。所以 `local` 说的不是「地址在本机」，而是「按本机发现文件 + 本机凭证走」——
 * 连的到底是谁，由宿主的回答决定。
 */
export type ConnectionMode = "local" | "remote";

/**
 * 用户在设置面板里能改的全部连接配置。落盘在 `<AI_ZEN_DIR>/desktop/connection.json`（`0600`）。
 *
 * ## `local` 模式下那两个值必须是 `undefined`，不是空字符串
 *
 * 客户端把空串当成「显式给了一个空值」（于是它不会退回发现文件 / 本机 `run/token`），只有
 * `undefined` 才表示「按老路走」。这条口径在 main 侧由
 * `connection/settings.ts` 的 `connectionConfigOf()` 保证，类型这里只说明事实。
 */
export interface ConnectionSettings {
  /** `local` = 老路：地址读 `<AI_ZEN_DIR>/run/host.json`，凭证读 `<AI_ZEN_DIR>/run/token` */
  mode: ConnectionMode;
  /** 仅 `remote` 有意义：显式地址（`ws:` / `wss:` / `http:` / `https:`） */
  hostUrl?: string;
  /** 仅 `remote` 有意义：显式凭证。留空 = 退回 `<AI_ZEN_DIR>/run/token`（D9 的本地兜底） */
  hostToken?: string;
}

/**
 * 「测试连接」的结果。
 *
 * 成功那一支只有三件可看的事实：宿主自报的协议版本、版本串、以及这一次试连花了多久
 * （用户判断「远端是不是慢得不能忍」的唯一依据）。失败那一支只有一句**人话** —— 它不是
 * 错误码的搬运工，`unauthorized` 的四种成因已经被客户端包的 `explainUnauthorized` 翻过
 * 一遍了（哪一种该去改什么，措辞只有那一份）。
 */
export type ConnectionProbe =
  | { ok: true; protocol: number; version: string; elapsedMs: number }
  | { ok: false; message: string };

/**
 * 「此刻这条连接是什么状态」（D23）—— render 靠它决定**该不该说话**。
 *
 * ## 为什么这个状态必须存在（而不是「连上了就是连上了」）
 *
 * 窗口现在**先出来**、连接放到后面（D25）。于是 render 挂载的那一刻，连接可能还没建立 ——
 * 它在 `onMounted` 里发的 `workspace.list` / `config.get` 会撞在一条还没连上的连接上，
 * 屏幕上就是一片空白且没有提示。三态是那次挂载唯一能问的东西：`connecting` 就等，
 * `ready` 就照常干活，`error` 就把 `message` 显示出来（含「去设置页改回来」的入口）。
 *
 * ## 四态各自的含义
 *
 *   · `unset` —— **没配过**（`connection.json` 不存在或不可用）。这不是「连不上」，而是一个
 *     该由**用户**做的选择：界面据此摆出首启引导屏（本机 / 远程），而不是去猜一个默认值。
 *     把「没配过」压进 `local` 是错的 —— 那样应用一启动就去拉起一个本地宿主，「引导」永远
 *     出不来；
 *   · `connecting` —— **包含**「首次尝试中」与「重试等待中」。两者的区别是最后两个字段：
 *     `attempt: 0` = 首次尝试（`nextRetryInMs` 为 `undefined`）；`attempt: N > 0` = 正在
 *     等待第 N 次重试，`nextRetryInMs` 是还要等多久（见 D24 的 1000 / 2000 / 5000）；
 *   · `ready` —— 连上了。`protocol` / `version` 是宿主**自报**的（`hello` 回执），
 *     拿不到时是 `0` / `""`（连上了但不知道自己连的是哪一版，比编一个数字诚实）；
 *   · `error` —— **重试也失败之后**的终态（不是「这一次失败了」）。它带一句人话 `message`；
 *     用户点「重连」（{@link ConnectionControls.reconnect}）才会离开这个状态。
 *
 * ## `label` 为什么由 main 产出
 *
 * render 不许自己拼地址、也不许猜模式（`local` / `remote` 是 main 的事实）：`label` 就是
 * 它该显示的那一行字 —— 本地模式是 `"本机宿主"`，远程模式是那个地址。
 * **它绝不包含凭证**（地址里的 userinfo 与任何 token 都不会进这里，见 main 的
 * `connection/controller.ts`）。
 */
export type ConnectionState =
  /** 没配过：连一个默认值都不该猜，界面该问用户（首启引导屏） */
  | { status: "unset" }
  | { status: "connecting"; label: string; attempt: number; nextRetryInMs?: number }
  | { status: "ready"; label: string; protocol: number; version: string }
  | { status: "error"; label: string; message: string };

// ==================== 子 Agent 视图 ====================

/**
 * 子 Agent 的状态：`running` 是进行态，`done` / `failed` 是终态。
 *
 * 这三档是 render 栏目在用的词（`agentView` 的选中/标签逻辑按它分支）。宿主 `SubAgentSnapshot`
 * 那一组是 `running` / `done` / `error` / `aborted`，而 main 这一波不推 `agents` 事件 —— 两边没有
 * 在跑的对接点，因此没有可以合并的“同一份形状”。要对齐要么把 render 的四分支改成宿主那四档，
 * 要么等子 Agent 推送接上时一起做，都不在“只留一份 token 类型”这一波里。
 */
export type SubAgentStatus = "running" | "done" | "failed";

/**
 * 一个子 Agent 自己的对话（= 栏目标签 `子AGENT{n}` 点进去看到的那一屏）。
 *
 * 三处事实**都来自宿主**，客户端一个都不自己算：
 *   - `id`：`sub-agent-start` 的 `subAgentId`（跨轮稳定的标识，选中态与 v-for key 靠它；
 *     它不带展示含义，展示序号是 `index`）；
 *   - `index`：同一个事件里的 `index`（本轮内从 1 起，栏目标签直接印它）。客户端不数：
 *     它要在「切到某个子 Agent」「中途接上连接」时都对得上，而那时本地没数过；
 *   - `status`：`sub-agent-start` 给 `running`、`sub-agent-end` 与 `session.subAgent.snapshot` 给终态。
 */
export interface SubAgentView {
  id: string;
  index: number;
  status: SubAgentStatus;
  /** 它到目前为止的对话（流式期间由增量拼出来，之后以 `session.subAgent.snapshot` 为准） */
  messages: AgentNS.Message[];
}

// ==================== 推送事件 DTO ====================

// 生成六态的名字就是宿主那一组（见上面 `StreamPhase` 的再导出）：main 不另造一套词，
// 只是把它搬进 render 认的形状里。

/** chat:push 单通道推送（discriminated union）
 *  状态源是常驻宿主：send 只提交（快速返回），user/start/message/done 全由事件回流 */
export type ChatStreamEvent =
  | { conversationId: string; type: "start" }
  /**
   * 本轮的用户消息上屏（render 据此上屏，不本地乐观插入）。
   *
   * 载荷是**宿主落库的那条消息本体**（core 的 `AgentNS.Message`），不是把正文拍成一句字：
   * 带图的那一句在库里是 `image_url` 内容段数组，压成字符串就只能显示文字、图要等整轮跑完
   * 的 `done` 全量替换才出现。id 是宿主受理时就分配好的那个（L6），所以 `done` 那次全量
   * 替换里同一条消息用的是同一个 id —— 不会画成两条。
   */
  | { conversationId: string; type: "user"; message: AgentNS.Message }
  /**
   * 这一轮的生成状态（六态 + 正在跑的工具）。
   *
   * 宿主的 `run.state` 是一份**全量快照**、而且带的东西远多于界面今天要显示的（六态、子 Agent、
   * 用量、结局）。这里只搬「界面上真能显示的那部分」：六态的名字（取值与宿主
   * `GenerationState.phase` 逐字一致）+ 正在跑的那几个工具（core 的 `AgentNS.ToolCall` 原样：
   * 名字、参数、id、index 都在里面，界面要哪个读哪个，不先拍成名字列表）。
   *
   * 与 `start` / `done` 的关系：`start` / `done` 说的是「这一轮开始了 / 结束了」（render 用它切
   * 流式态），这一条说的是「此刻在哪一态」，两件事分开之后，六态变化不必重发 `start`。
   */
  | {
      conversationId: string;
      type: "stream";
      /** 空闲时为 `null`（这一轮不在跑） */
      phase: StreamPhase | null;
      /** 「在等哪几个工具」：并行时只含还在跑的那几个，core 的 `ToolCall` 原样（PRD L8） */
      toolCalls: AgentNS.ToolCall[];
    }
  /**
   * 一条完整消息的实时同步（流式中的 assistant 消息：正文/reasoning/tool_calls/status；
   * 以及每轮结束补推的工具结果消息）。
   *
   * 载荷就是 core 的 `AgentNS.Message`，不另包一层 id —— 消息自己的 `id` 就是 upsert 的键。
   * render 按 id 就地 upsert：有则替换、无则追加末尾 —— 事件到达顺序即消息顺序。
   */
  | { conversationId: string; type: "message"; message: AgentNS.Message }
  /**
   * 这一轮各附件的结局（`conversation.send` 回来的 `attachments`，逐张一条）。
   *
   * ## 为什么单独一条事件，而不是塞进 `user` 或消息内容里
   *
   * `user` 那条事件说的是「你这句话上屏了」；附件结局是**另一件事**（谁走成了文件引用、谁退化成
   * 文字、谁根本没发出去），而且它要跟着 `userMessageId` 挂在那条气泡旁边 —— 那个 id 在
   * `done` 的全量替换里是同一个（L6），所以按 id 记住就不会丢。塞进消息内容则会把它变成
   * 「消息正文的一部分」，而消息正文是宿主的历史事实，不是一条告警。
   *
   * 空数组不会发（没带附件的那一轮根本没有这条事件）。
   */
  | {
      conversationId: string;
      type: "attachments";
      /** 这批附件是跟着哪条用户消息发的（气泡按这个 id 找结局） */
      userMessageId: string;
      attachments: AttachmentOutcome[];
    }
  | { conversationId: string; type: "done"; messages: AgentNS.Message[] }
  /** 任务迁移完成后推送：全量替换消息。旧历史带 omit（已作废）标记，UI 展示但不进 agent 请求 */
  | { conversationId: string; type: "migrated"; messages: AgentNS.Message[] }
  /**
   * 这一轮（或这条连接）失败的事实。
   *
   * 载荷是 `ProblemFact`（码 + 参数 + 已渲染的那句 + detail），不是一句摘出来的话：宿主说的
   * 失败（`run.problem`）、客户端库里带业务码的失败、以及 main 自己捕到的异常分别带着自己那里
   * 能给出的事实，界面要显示就读 `problem.message`，要分支就读 `problem.code`。
   */
  | { conversationId: string; type: "error"; problem: ProblemFact }
  /** 自动生成对话标题后推送（不阻塞 done，侧栏据此更新名称） */
  | { conversationId: string; type: "renamed"; name: string }
  /**
   * 宿主推来的一条**通知**（`notice` 事件）：给用户看的一句话，瞬时的。
   *
   * ## 为什么不是 `type: "error"`
   *
   * `error` 的语义是「这一轮失败了」：render 把它写进会话状态里的错误条，占着位置，直到
   * 下一轮 `done` 才被清掉。通知说的不是失败，而是「顺带告诉你一句」——存档没写成功、
   * 本次迁移被跳过、子 Agent 挂了、交接文档落在哪。走 `error` 通道有两个后果：用户要在
   * 下一轮开始前一直看着一条红字（其实这轮没事），而 `done` 会替它提前销账（真该看的那句
   * 反而被抹掉）。两条通道各说各的：`error` 是状态，`notice` 是提示。
   *
   * ## 为什么内容是一份 `LocalizedText`
   *
   * 文案归宿主（PRD D8）：`text.message` 是按**这条连接的语言**渲染好的句子，main 原样搬过来，
   * 自己不查第二份词典；而 `code` / `params` 一起搬过来，界面才能按码分支、换语言重排，
   * 而不是只能把一句写死的字摆上屏。
   *
   * ## 为什么 `conversationId` 是 `null` 而不是可选
   *
   * 全局通知**不属于任何会话**（存档目录不可用、MCP 连不上是服务本身的事），宿主给的
   * `NoticeView.conversationId` 那时就是 `null`。用 `null` 而不是省略：宿主的形状就是它，
   * 两种「没有」的写法会让人以为它们不是一件事。
   */
  | {
      type: "notice";
      /** 三档语气，就是宿主的 `NoticeLevel` */
      level: NoticeLevel;
      /** 秒数；`null` 表示不自动消失，留到被手动清掉 */
      duration: number | null;
      text: LocalizedText;
      conversationId: string | null;
    }
  /**
   * 宿主推来的一个**问题对象**（`question` 事件）：到交接线时问「自交接 / 独立摘要 / 不交接」、
   * 或不可撤销的动作前确认（PRD D22 / F-D2 / F-I9）。
   *
   * ## 为什么载荷是整份 `QuestionView`，而不是一句话
   *
   * 问题是一等对象：`prompt`（问什么）/ `options[]`（候选，每个带 `label` 与 `detail` 两句
   * `LocalizedText`）/ `answer`（有没有人答过）/ `blocking`（挡不挡着对话）/ `state`（挂起 /
   * 已答 / 过期 / 取消）/ `kind`（交接还是确认）都是界面要用的**事实**。压成一句
   * `prompt.message` 之后，界面就只剩一行字：候选没了（用户没法答）、`blocking` 没了
   * （输入区不知道要挡）、`id` 没了（答回去不知道答哪一道）。
   *
   * ## 为什么与 `notice` 分开
   *
   * 通知是「顺带说一句」，说完就没用了；问题是**要用户口头回答**的东西，答完之前一直挂着，
   * 而且宿主会用 `question_pending` 拒掉这段对话的后续发送（PRD D23）。两件事混在一条通道上，
   * 界面就只能二选一：要么当提示（用户的回答无处可去），要么当状态（提示反而占住了位置）。
   *
   * ## 同一道题会被推多次
   *
   * 宿主在「创建」「被回答」「过期」时都推同一个 `question`，`state` 与 `updatedAt` 随之变。
   * 所以 render 按 `id` **并入**本地那份（同 id 取 `updatedAt` 更晚的），而不是把整份列表换掉
   * —— 换掉就会在「推送比快照晚到」或「别的一端刚把它答了」时丢掉/错留一道题。
   */
  | { conversationId: string; type: "question"; question: QuestionView }
  /**
   * 这段会话**当前这一轮**的子 Agent 栏目，一有变化就推**整份**。
   *
   * ## 为什么是整份替换，而不是「新增 / 更新 / 删除」三条增量事件
   *
   * 子 Agent 的对话很短（一次委派的完整上下文通常就几条消息），而 render 那边要对的是
   * 「用户切到某一栏看到的那一屏」。整份替换让 render **不需要任何合并逻辑**：收到就把手上
   * 那份换掉，字段就是 `SubAgentView`（id / index / status / messages），没有 id 对应的
   * upsert、没有「这条是新的还是改的」的判断。增量事件的复杂度会摊到每一个消费方（桌面端
   * 今天一个，将来还会有别的），而省下来的带宽在一屏几条消息的量级上毫无意义。
   *
   * 这与主对话那条 `message` 事件的取舍完全同源：那条也是「推这条消息此刻的完整内容」，
   * 让 render 按 id 整条替换 —— 一处只有一个合并口径，就不会出现「两套合并规则各说各话」。
   *
   * ## 空数组 = 这一轮的子 Agent 都没了
   *
   * 子 Agent 只活在当前一轮（`session-turn-end` 之后宿主把它们连同展示序号一起清掉，客户端同一
   * 口径）。所以 `agents: []` 的意思是「把栏目收回去」，不是「这段会话没有子 Agent 这个
   * 概念」。render 收到空数组就清空栏目、退回主对话 —— 不能让一个标签停在一段已经过去的
   * 对话上。换会话 id（迁移 / 另存为）同样清空。
   *
   * ## 顺序
   *
   * 数组顺序 = `sub-agent-start` 的到达顺序 = 宿主给的 `index` 顺序（栏目标签
   * 从左到右）。render 直接照数组渲染，不重排 —— 重排就得知道「序号是谁给的」，而那是
   * 宿主的展示序号，不是客户端可以推的东西。
   */
  | { conversationId: string; type: "agents"; agents: SubAgentView[] };

// ==================== IPC 协议 ====================

export interface WindowControls {
  minimize: () => Promise<void>;
  maximize: () => Promise<void>;
  close: () => Promise<void>;
  isMaximized: () => Promise<boolean>;
}

export interface ElectronAPI {
  /** 通用服务调用：invokeService(service, method, ...args) —— 对应 main ServicesManager 动态分发，极薄，零业务定义 */
  invokeService: <T = unknown>(
    service: string,
    method: string,
    ...args: unknown[]
  ) => Promise<T>;
  /** 监听主进程推送事件 */
  on: (channel: string, callback: (...args: unknown[]) => void) => void;
  /** 取消监听 */
  off: (channel: string, callback: (...args: unknown[]) => void) => void;
  /** 打开原生目录选择器，返回选中路径（取消则 null） */
  selectDirectory: () => Promise<string | null>;
  /** 窗口控制 */
  window: WindowControls;
  /** 连接设置（本地 / 远程） */
  connection: ConnectionControls;
}

/**
 * 连接设置的**五条专用通道**（`connection:get` / `connection:save` / `connection:test` /
 * `connection:state` / `connection:reconnect`）。
 *
 * ## 为什么不走 `invokeService`
 *
 * `invokeService` 的六个分发键（workspace / conversation / agent / model / chat / config）
 * 就是**宿主的方法表** —— render 的调用面与协议一一对应。而「连哪台宿主」在宿主还不
 * 存在的时候就要回答（先有鸡先有蛋），它是**主进程自己**的事。混进那张表，第一个后果是
 * 「六个键 = 宿主调用面」这条边界失效（下一个人会以为 `connection.get` 也是协议方法），
 * 第二个是它根本没法被转发 —— 转发要一条连着的宿主，而它正是决定连哪条的那一个。
 */
export interface ConnectionControls {
  /** 读当前配置：文件不存在 / 坏 JSON / 字段不合法都回 `{ mode: "local" }`，**绝不抛错** */
  get: () => Promise<ConnectionSettings>;
  /**
   * 保存并**立即重建连接**（不要求重启 App）：先落盘、再换层。
   *
   * ## 两条失败路径说的不是一件事，界面不许混着显示
   *
   *   · **落盘失败**（或校验不过）→ 抛原错误，连接**一个字段都不动**。界面该说「没保存
   *     成功」，盘上那一份还是旧的；
   *   · **落盘成功但连不上**（D27）→ 也抛，但措辞明说「已保存」（例如
   *     「连接配置已保存，但连不上 …：…」），并且状态机已经落到 `connecting`（后台按 D24
   *     重试）。这种情况下**绝不能**显示成「保存失败」：盘上确实已经改了，用户再点一次
   *     「保存」也只是又存一遍同一份配置。
   *
   * 换层期间进行中的回答会中断（那是换连接的固有代价，界面上要提示）。
   */
  save: (settings: ConnectionSettings) => Promise<{ settings: ConnectionSettings }>;
  /**
   * 用**候选值**试连一次：不落盘、不影响当前连接（面板上「测试连接」那个按钮）。
   *
   * 地址非法 / 连不上 / 凭证被拒都**不抛错**，一律折成 `{ ok: false, message }`：这条通道的
   * 返回值就是给人看的一句话，抛错只会让界面多一条没头没尾的红字。
   */
  test: (candidate: { hostUrl: string; hostToken?: string }) => Promise<ConnectionProbe>;
  /**
   * **查询**当前连接状态（D26）。
   *
   * 为什么查询与推送（主进程 → render 的推送通道同名，也叫 `connection:state`）必须**都存在**：
   * 窗口现在先出来（D25），它挂载的那一刻可能已经错过了一次状态变化 —— 只靠推送会漏，
   * 只靠查询又拿不到之后的变化。两个合起来才完整：查一次当前值，之后听推送。
   *
   * 永不抛错：还没 `start()` 时它答 `{ status: "connecting", attempt: 0 }`（那正是事实 ——
   * 连接还没来得及开始），`label` 由盘上那份配置算出。
   */
  state: () => Promise<ConnectionState>;
  /**
   * 手动重试一次（D24）：清掉挂起的重试计时器、`attempt` 归零、立刻再试一轮（含它自己的
   * 3 次退避）。用户点「重连」与 `error` 态下那个按钮都走这里。
   *
   * **返回进入 `connecting` 之后的那一刻状态**（不是整轮的结果）：这一轮在后台跑，最多
   * 8 秒（1000 + 2000 + 5000），把它 await 住会让界面在那 8 秒里既没有回执也没有反馈。
   * 后续（`ready` / `connecting(N)` / `error`）全走推送。
   */
  reconnect: () => Promise<ConnectionState>;
}

// 与连接相关的纯函数（render 也能用：包里那份是 Node 包，进不了浏览器产物）
export * from "./address.js";

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
