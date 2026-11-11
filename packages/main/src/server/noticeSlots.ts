/**
 * 通知槽位在本层的那两件事：**补看**（`notice.list` / 快照的 `pendingNotices`）与**确认**
 * （`notice.ack { ids }`）。
 *
 * ## 为什么通知要「补看」了
 *
 * 通知在服务端现在是**有状态的槽位**（见 `@ai-zen/agents-server/protocol` 的 `notice.ts`）：
 * 登记之后一直挂着，直到有人确认。广播只是「顺手通知一声」—— 所以「登记的那一刻没人在听」
 * 是正常情形（桌面端没开着、连接正在重连、用户切到了别的会话）。只认那条广播的话，那些
 * 通知就等于不存在，用户看到的仍是「什么都没发生」。
 *
 * 于是两个出口成对出现：
 *
 *   1. **实时广播**（`server-notice` / `session-notice`）：到手就上屏；
 *   2. **槽位**（`notice.list` 的全局那批 / `session.snapshot` 的 `pendingNotices`）：
 *      拿到一条（新）连接查一次全局的，打开一段会话看一次快照里的；
 *   3. 两条路上屏之后都**立刻确认**（决策 C2：寿命的终点由消费者决定），不确认的话同一批
 *      通知会在每一次重连 / 每一次收尾之后重新弹一遍。
 *
 * ## 确认用的是事件**自带**的 id（不是再查一遍列表）
 *
 * 上一轮这里有两处绕法，都是因为协议当时不给 id：实时广播里没有 id，于是「先上屏，再走一趟
 * `notice.list` + `notice.ack`（这一次不上屏）」；会话内通知拿不到 id，于是按
 * 「会话 + code + params」签名记账。协议补上之后（决策 A35）它们都退场了：
 *
 *   - `ServerNoticeEvent.id` 与 `GlobalNoticeSlot.id` 是**同一个值**；
 *   - `SessionNoticeEvent.id` 与 `pendingNotices` 里每一项的 `id` 是同一个值，而
 *     `notice.ack { ids }` **同时认两类 id**（决策 A30）。
 *
 * 所以现在只有一个动作：**上屏 → 拿这条事件（或这个槽位）自己的 id 去 ack**。不必回头查
 * 列表 —— 那一趟往返当初唯一的作用就是把 id 捡回来。
 *
 * ## 为什么还留一张 `shown` 表（但只按 id）
 *
 * 同一条通知有两个出口，它们可能**先后都到**：实时那条先上屏，随后快照仍报它一遍（ack 的
 * 那一趟还在飞，槽位还没消）。按 id 记一笔「这条已经弹过了」就够 —— 那正是上一轮那张
 * 「会话 + code + params」签名表唯一站得住的作用，而签名本身站不住：两条 code 相同、params
 * 相同的通知是**两条**（服务端各给一个 UUID），按签名去重会让用户少看到一份交接文档落在哪。
 *
 * 表里的 id 用完不删：条目是一个 UUID 字串，量级是「这部进程里出现过的通知条数」（个位数到
 * 几十），而删了之后一旦某次 ack 失败（连接刚好断），同一条通知会在下一次快照里重新弹一遍
 * —— 那才是用户看得见的毛病。ack 本身是幂等的，重复确认一个已经不存在的 id 只是不出现在
 * `acked` 里，不是错误。
 */

import type {
  NoticeAckResult,
  NoticeLevel,
  NoticeListResult,
  ServerNoticeCode,
  ServerNoticeEvent,
  SessionNoticeEvent,
} from "@ai-zen/agents-client";
import type { ChatStreamEvent } from "@ai-zen/desktop-shared";
import type { ProtocolCall } from "./call.js";
import { noticeText } from "./notices.js";

export interface NoticeSlotOptions {
  /** 发一次协议调用（`notice.list` / `notice.ack`；连接死了它自己会重建） */
  call: ProtocolCall;
  /** 推给 render（与 chat:push 同一个出口） */
  push: (event: ChatStreamEvent) => void;
}

export class NoticeSlots {
  /**
   * 「这条通知已经上过屏了」—— 键是通知**自己的** id（UUID，与槽位同一个值）。
   *
   * 唯一的作用是挡住「实时那条 + 快照/列表那条」这对双出口的重复（见文件头最后一段）。
   * 全局与会话内共用同一张表：id 是 UUID，两边的值域本来就不相交。
   */
  private readonly shown = new Set<string>();
  /** 正在进行的补看（单飞：同一条连接上并发触发不该查两次，见 {@link sync}） */
  private syncing: Promise<void> | null = null;

  constructor(private readonly options: NoticeSlotOptions) {}

  /**
   * 一条（新）连接就绪：把此刻还没被确认的**全局**通知补看一遍，**显示后确认**。
   *
   * 单飞：`start()` 与 `onOpen()` 都可能触发，而两次都在同一条连接上——并发跑两遍的后果是
   * 同一批通知弹两遍（第二遍在第一次确认之前就 `list` 到了）。
   *
   * 失败不往上抛（调用方按「下次再说」处理）：`notice.list` 失败意味着这是一台还不认识这条
   * 方法的服务端，或者连接刚断 —— 两种都不该让桌面端起不来，而槽位还在服务端，下一次连接
   * 会重新对一次账。
   */
  async sync(): Promise<void> {
    const inFlight = this.syncing;
    if (inFlight) return await inFlight;
    const attempt = this.list();
    this.syncing = attempt;
    try {
      await attempt;
    } finally {
      this.syncing = null;
    }
  }

  /**
   * 一条**实时的**全局通知（`server-notice` 广播）：上屏，然后用它自带的 id 确认。
   *
   * 确认失败不报人看：最坏的结果是这条通知还挂在服务端，下一次 `sync()` 会把它再确认一次
   * （不会重新弹：同一个 id 已经在 `shown` 里了）。
   */
  live(event: ServerNoticeEvent): void {
    this.pushGlobal(event);
    void this.ack([event.id]);
  }

  /**
   * 一条**实时的**会话内通知（`session-notice` 广播）：上屏，然后用它自带的 id 确认。
   *
   * `key` 是 render 认的会话 id（换过 id 的会话由调用方收敛好）。
   */
  session(event: SessionNoticeEvent, key: string): void {
    this.showSession(event, key);
    void this.ack([event.id]);
  }

  /**
   * 快照里带回来的会话内通知（`SessionSnapshotResult.pendingNotices`）。
   *
   * 这条路补的是「登记的那一刻没人在看，或者那段时间连接不在这儿」：所有活下来的槽位都在
   * 这里，用户一打开这段会话就该看见它们。上屏之后同样按各自的 id 一次性确认 —— 否则快照
   * 每一次收尾都会把它们再报一遍（确认之后槽位就没了，这条出口自然空掉）。
   */
  pending(key: string, notices: readonly SessionNoticeEvent[]): void {
    if (notices.length === 0) return;
    for (const notice of notices) this.showSession(notice, key);
    // 确认的 id 取的是**这条通知自己的**（快照里那一项与实时事件同一个值）
    void this.ack(notices.map((notice) => notice.id));
  }

  // ==================================================================
  // 内部
  // ==================================================================

  /**
   * 查一次**全局**槽位：逐条上屏，然后按服务端报上来的 id 一次性确认。
   *
   * 这里仍然要先查：全局通知没有「所属物」可依附（不挂在任何会话上），`notice.list` 是它的
   * 唯一入口。而查询的**结果里就带着 id**，所以这一趟查完顺手确认，不必再发第二次请求。
   */
  private async list(): Promise<void> {
    const { notices } = await this.options.call<NoticeListResult>("notice.list");
    if (notices.length === 0) return;
    for (const slot of notices) this.pushGlobal(slot);
    await this.ack(notices.map((slot) => slot.id));
  }

  /**
   * 确认一批 id（`notice.ack { ids }`）—— 全局与会话内**都走这一条**（决策 A30）。
   *
   * 失败静默（`catch` 收在调用点之前的这一层）：槽位还在服务端，下一次连接 / 下一次快照会
   * 再对一次账；把一次确认失败变成一条红字，只会让「通知没消掉」看起来像「功能坏了」。
   */
  private async ack(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    try {
      await this.options.call<NoticeAckResult>("notice.ack", { ids });
    } catch {
      // 见上：下一次连接 / 下一次快照会重试
    }
  }

  /**
   * 一条全局通知上屏：**不给** `conversationId`，同一条（同一个 id）只弹一次。
   *
   * 它不属于任何会话（存档目录不可用、MCP 连不上是服务本身的事）。填个空串等于声称「有一个
   * key 为空的会话」，render 会照着这个 key 开一个假槽位；省掉这个字段才是「没有会话」。
   *
   * 收的是槽位 / 事件本身（两个形状在 `id` / `level` / `code` / `params` 上一致）：确认与
   * 去重都要那个 id，拆成四个参数就等于又把 id 支开了。
   */
  private pushGlobal(notice: {
    id: string;
    level: NoticeLevel;
    code: ServerNoticeCode;
    params?: Record<string, unknown>;
  }): void {
    if (!this.markShown(notice.id)) return;
    this.options.push({
      type: "notice",
      level: notice.level,
      text: noticeText(notice.code, notice.params),
    });
  }

  /**
   * 一条会话内通知上屏（**带** `conversationId`），同一条通知只弹一次。
   *
   * 报的是 render 认识的 key（不是服务端 id）：换过 id 的会话（迁移 / 另存为）否则会把通知
   * 贴到一段 render 从没见过、也永远不会选中过的会话上，等于又回到「什么都没发生」。
   */
  private showSession(notice: SessionNoticeEvent, key: string): void {
    if (!this.markShown(notice.id)) return;
    this.options.push({
      conversationId: key,
      type: "notice",
      level: notice.level,
      text: noticeText(notice.code, notice.params),
    });
  }

  /** 记一次「这条通知上过屏了」；已经记过就返回 `false`（两个出口之间不重复弹） */
  private markShown(id: string): boolean {
    if (this.shown.has(id)) return false;
    this.shown.add(id);
    return true;
  }
}
