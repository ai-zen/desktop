/**
 * 通知词典：`level + code + params` → **中文文案**。
 *
 * ## 为什么翻译在客户端，而且只在 main 这一份
 *
 * 服务端的通知只带机器码（`SessionNoticeCode` / `ServerNoticeCode`，见
 * `@ai-zen/agents-server/protocol` 的 `sessions.ts`），一句自然语言都不产 —— 一个服务端
 * 同时接中文终端与英文浏览器时，它只能挑一种语言撒谎。于是「这句 code 该怎么说」落在各
 * 客户端自己的词典里：CLI 那份在 `cli/src/session-notice.ts`，本文件是桌面端的那一份。
 *
 * 放在 main 而不是 render：文案与「哪条事件变成哪个 code」是同一件事，而事件翻译已经全在
 * main（`events.ts`）。render 那边若再查一份词典，就是同一份文案两处维护 —— 迟早一处改了
 * 另一处没改，表现为「同一条通知在弹窗里和在别处说法不一样」。所以 main 出去的通知**已经
 * 是人话**（见 `ChatStreamEvent` 的 `notice` 成员），render 只管弹。
 *
 * ## 为什么未知 code 也要给一条文案
 *
 * 协议把文案交给客户端，意味着**版本偏斜是常态**：服务端先发版、桌面端后装（或者反过来，
 * 用户很久不升级）。新 code 到了老客户端，若静默丢弃，用户看到的就是「什么都没发生」。
 * 所以查不到时给一条明确写着「未知通知 + 原 code」的句子：它不好看，但它说的是实话，而且
 * 带着 code 可以直接拿去查（`未知通知` 不是垃圾兜底，是诊断出口）。
 *
 * ## 为什么是函数表
 *
 * 每个 code 的句子结构不同（有的句子中间要塞枚举值的翻译，有的整块可省），只有函数能表达。
 * 写成函数表而不是一坨 `if/else`：新增 code 时**表里必然缺一行**，`Record<Code, …>` 会
 * 直接编译失败；`if/else` 链漏一个分支则一句抱怨都没有，运行期默默走到兜底。
 */

import type {
  ServerNoticeCode,
  SessionNoticeCode,
} from "@ai-zen/agents-client";

/** 服务端给来的可变部分（协议里是 `Record<string, unknown>`，本层不假设值的类型） */
type NoticeParams = Record<string, unknown>;

/** 一条文案的模板：拿 `params` 出一句话 */
type NoticeTemplate = (params: NoticeParams) => string;

/**
 * 取一个参数当作句子里的值。
 *
 * 为什么不直接 `String(params[key])`：`params` 是 `Record<string, unknown>`，字段缺失时
 * `String(undefined)` 会把 `undefined` 糊进句子里 —— 用户看到「交接文档：undefined」比
 * 少一句话更糟（那是把内部字段名漏给了用户）。所以缺字段就是**空串**：句子读起来少一截，
 * 但它不说谎也不吓人。合并、非字符串的复杂值同样按空处理（协议里这些位置只会是字符串/数字；
 * 万一不是，空着也比 `[object Object]` 强）。
 */
function text(params: NoticeParams, key: string): string {
  const value = params[key];
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return "";
}

/**
 * `HandoffMode` 枚举 → 中文（`self` / `summary`）。
 *
 * 载荷里的**枚举值也得翻**：服务端放的是 `self`，原样塞进句子会让中文界面冒出
 * 「正在编写任务交接文档（self）…」。不认识的取值原样返回（那是协议新增了执行者，
 * 露出来才好定位）；字段缺失则说「未指定」——留一对空引号比说清楚更让人困惑。
 */
const MODE_NAMES: Record<string, string> = {
  self: "原 agent 自交接",
  summary: "独立摘要",
};

function modeName(params: NoticeParams, key: string): string {
  const raw = text(params, key);
  if (!raw) return "未指定";
  return MODE_NAMES[raw] ?? raw;
}

/** `（独立摘要）` 这种后置说明；值缺了就整块省掉，不留空括号 */
function modeSuffix(params: NoticeParams, key = "mode"): string {
  const raw = text(params, key);
  return raw ? `（${MODE_NAMES[raw] ?? raw}）` : "";
}

/**
 * 对话内通知（`session-notice`）的文案。
 *
 * 参数名逐条对着 `agents` 仓的 emit 点核过（不是按 code 名字猜的），出处写在每一条后面。
 */
const SESSION_TEXTS: Record<SessionNoticeCode, NoticeTemplate> = {
  /** `Persistence.write` 的 catch：存档没写成功，用户以为存了 */
  persistFailed: (params) =>
    `会话存档没写成功，下次打开可能看不到这一段：${text(params, "error")}`,
  /** `SessionHandoff` 的 `onHandoff`：请求的执行者没产出文档，降级成了另一种 */
  migrationDegraded: (params) =>
    `交接方式降级：请求的是「${modeName(params, "requested")}」，实际执行的是「${modeName(params, "mode")}」（文档质量会打折）`,
  /** `SessionManager.failHandoff`：用户取消交接（会话已回退，不是失败） */
  turnAborted: () => "已中止本轮，会话回到中止前的状态",
  /** `SessionHandoff` 的 `onBeforeHandoff`（手动交接）：`params.mode` */
  handoffWriting: (params) => `正在编写任务交接文档${modeSuffix(params)}…`,
  /** `SessionHandoff` 的 `onBeforeHandoff`（用量超阈值自发）：`used` / `limit` / `mode` */
  handoffAutoDetected: (params) => {
    const used = text(params, "used");
    const limit = text(params, "limit");
    // 两个数缺一个就整块省掉：留下 `（9000/ tokens）` 这种半截比不给数更看不懂
    const usage = used && limit ? `（${used}/${limit} tokens）` : "";
    return `检测到上下文即将超限${usage}，正在交接${modeSuffix(params)}…`;
  },
  /** `SessionHandoff` 的 `onHandoff`：文档落在哪（`params.path`） */
  handoffPath: (params) => `交接文档：${text(params, "path")}`,
  /** `SessionManager.autoMigrate` / `migrate`：`params.sessionId` 是**旧**会话 id */
  handoffArchived: (params) => `原对话已存入存档：${text(params, "sessionId")}`,
  /** `SessionHandoff` 的 `onMigrated`：`params.n` 是新会话第一条上下文的消息数 */
  handoffMigrated: (params) => {
    const count = text(params, "n");
    return count
      ? `任务迁移完成，已开启新会话（共 ${count} 条消息）`
      : "任务迁移完成，已开启新会话";
  },
  /** 紧跟 `handoffMigrated` 的补充（无参数）：新助手会先读交接文档 */
  handoffMigratedHint: () => "新助手会先读交接文档，然后继续推进任务",
  /** `QuestionBroker.askHandoffMode`（无参数）：这轮没迁，上下文会继续长 */
  migrationSkipped: () => "已跳过本次任务迁移，上下文会继续增长",
  /** `EventBridge` 的 `onSubError`：`index` 指哪个子 Agent，`message` 是原始错误 */
  subAgentFailed: (params) => {
    const index = text(params, "index");
    const message = text(params, "message");
    // 序号缺失时不出 `子 Agent # 出错`：没有序号就说「子 Agent 出错」，句子照样成立
    return index
      ? `子 Agent #${index} 出错：${message}`
      : `子 Agent 出错：${message}`;
  },
};

/**
 * 服务端通知（`server-notice`）的文案。
 *
 * 它与对话内通知分属**两个联合**（`ServerNoticeCode` / `SessionNoticeCode`）：这条
 * 事件的载荷里没有 `sessionId`，切到别的会话也不该消失 —— 事件名与码的名字都跟
 * `SERVER_` 走（见协议里的 `ServerEventName` 与 `ServerNoticeCode` 注释）。
 *
 * 这两条今天在服务端**还没有生产者**（协议先立住 code，等组装根接上 MCP 探活 / 存档探活），
 * 参数名沿用 CLI 那份模板的字段（`name` / `error`）—— 两边说的是同一条通知，不该各叫一个名。
 */
const SERVER_TEXTS: Record<ServerNoticeCode, NoticeTemplate> = {
  /** `params.name` 是连不上的那个 MCP server */
  mcpUnavailable: (params) => `MCP server 连不上：${text(params, "name")}`,
  /** `params.error` 是存档读写失败的原因 */
  storeUnavailable: (params) => `会话存档目录不可用：${text(params, "error")}`,
};

/**
 * 把一条通知翻成中文。
 *
 * `code` 收成 `string`（而不是 `SessionNoticeCode | ServerNoticeCode`）：服务端版本比桌面端
 * 新时，运行期真的会来一个类型上不存在的 code，而这条路的正确行为是「说出来」而不是
 * 编译期假装它不可能（理由见文件头）。
 */
export function noticeText(code: string, params: NoticeParams = {}): string {
  const templates: Record<string, NoticeTemplate | undefined> = {
    ...SESSION_TEXTS,
    ...SERVER_TEXTS,
  };
  const template = templates[code];
  if (!template)
    return `未知通知：${code}（桌面端还不认识这条，可能是服务端更新了）`;
  return template(params);
}
