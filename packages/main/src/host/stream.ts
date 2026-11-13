/**
 * 流式增量 → 一条 core 的 `AgentNS.Message`。
 *
 * ## 为什么这里只有「拼」，没有「判断」
 *
 * 宿主推的 `message.delta.delta` 就是 core 的 `AgentNS.Delta`（正文 / 思考 / 工具调用由它自己
 * 的字段区分），而「一片增量怎么攒进一条消息」这件事 core 里**已经有唯一一份实现**：
 * `applyChunk()`。它认的入参形状是 `ChatCompletionChunk`，而 `Delta` 恰好就是
 * `chunk.choices[0].delta`，所以这里把增量原样塞回去喂给它 —— 不抄一遍拼接规则（正文怎么加、
 * 工具参数的「整串重发」与「只发增量」两种厂商行为怎么认、内容段数组怎么按 index 落位）。
 *
 * 抄一份的代价是漂移，而漂移只在边界情形上显形：半截的工具参数、内容段数组里的图片段。
 * 屏幕上表现为「答案比真正存下来的那条少一截」，而真正的消息在宿主是好的 —— 这种 bug 最难信。
 *
 * ## 一轮一条
 *
 * 一轮只拼**一条**助手消息：宿主在受理时就把这条消息的 id 分配好了（PRD L6），`message.delta`
 * 每一片都带着它。id 换了就说明这是另一条（下一轮，或工具轮次之后的新一条），把手里那条丢掉重开。
 *
 * 工具**结果**消息不由这里拼：它们是宿主自己写进库的完整消息，客户端在收尾时按 `message.list`
 * 整份拿（见 `events.ts` 的 `settle`）。
 */

import type { AgentNS } from "@ai-zen/agents-client";
import { AgentNS as CoreNS, applyChunk } from "@ai-zen/agents-core";

/** `applyChunk` 认的第二个入参（`ChatCompletionChunk`）；这里只构造它的最小可用形状 */
type ApplyTarget = Parameters<typeof applyChunk>[1];

export class StreamingMessage {
  /** 正在拼的那条消息；还没收到任何增量时为空 */
  private message: AgentNS.Message | null = null;

  /** 当前拼的是哪条消息的 id（没在拼时为空） */
  get messageId(): string | null {
    return this.message?.id ?? null;
  }

  /** 目前拼出来的那条消息（没有就为空）。推给 render 的是它本身，不复制 */
  get current(): AgentNS.Message | null {
    return this.message;
  }

  /** 开始（或切换到）一条新消息；id 与手上那条不同才重开 */
  begin(messageId: string): AgentNS.Message {
    if (this.message && this.message.id === messageId) return this.message;
    this.message = {
      id: messageId,
      role: CoreNS.Role.Assistant,
      // 空正文而不是「不发 content」：`applyChunk` 在字符串与内容段数组之间做判断，缺字段时
      // 它会自己补一个空串，但先放好一个空串能让「第一次增量就是数组内容段」那条路也走对
      content: "",
      // 「还在写」是这一刻的事实（宿主那条在库里就是这个状态，见 PRD D15 的边流边写）
      status: CoreNS.MessageStatus.Writing,
    };
    return this.message;
  }

  /**
   * 吃一片增量，返回拼到此刻的那条消息。
   *
   * 调用方（`events.ts`）保证同一轮的 `messageId` 稳定；这里再挡一次是为了「id 变了就地重开」
   * 这件事只有一处实现 —— 事件乱序（收尾那次 `message.list` 与下一轮的第一片撞在一起）时，
   * 宁可重开也不要把两条消息的正文拼到一条上。
   */
  applyDelta(messageId: string, delta: AgentNS.Delta): AgentNS.Message {
    const message = this.begin(messageId);
    // `Delta` 就是 `choices[0].delta`；`finish_reason` 在两处都可能有，两处都给上
    const chunk = {
      choices: [{ index: 0, delta, finish_reason: delta.finish_reason ?? null }],
    } as unknown as ApplyTarget;
    applyChunk(message, chunk);
    return message;
  }

  /** 用量只到 `usage` 事件里（增量里没有）：钉到这条消息上，与收尾时宿主给的那条同口径 */
  attachUsage(usage: AgentNS.Usage): AgentNS.Message | null {
    if (!this.message) return null;
    this.message.usage = usage;
    return this.message;
  }

  /** 丢掉手上的拼接态（一轮收尾 / 对话被删 / 换了对话） */
  reset(): void {
    this.message = null;
  }
}
