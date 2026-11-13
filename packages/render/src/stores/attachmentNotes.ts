/**
 * 附件结局 → 气泡里要显示的那几行字（纯函数，视图与用例共用这一份）。
 *
 * ## 口径（PRD F-H7：失败要告警、降级要说、不假成功也不打扰）
 *
 * | 宿主说它怎么走的 | 有没有原因 | 界面 |
 * |---|---|---|
 * | `file_reference` / `inline` | 没有 | 不说话（正常的那些，说了只是噪声） |
 * | `text_fallback`（退化成文字） | 有 | 说话 —— 那是用户该知道的一次降级 |
 * | `dropped`（没发出去） | 有 | 把那句话原文显示出来 |
 * | `dropped` | 没有 | 一句兜底（宿主没说原因，界面也不能装作没事） |
 *
 * ## 为什么正文一字不改
 *
 * `problem.message` 是宿主按这条连接的语言渲染好的一句话（客户端库自己那几种失败也用同一套措辞），
 * 界面只负责把它摆出来：在渲染层再拼一句「图片发送失败：」之类的，同一件事就有两种说法，而且
 * 换个语言之后只有一半会跟着变（PRD D8 的理由）。
 *
 * 这一层拿的是整个 `ProblemFact`（码、参数、句子、detail 都在），所以以后要按码分颜色、把 detail
 * 摆成按钮，改的只有这里 —— 不必回头让 main 多搬一个字段。
 *
 * 这里唯一由客户端产出的一句是 dropped 又没原因的兜底 —— 那种情况下宿主什么也没说，界面要么
 * 说一句「它没发出去」，要么让一张图凭空消失。
 */

import type { AttachmentOutcome } from "@ai-zen/desktop-shared";

/** 宿主说「没发出去」却没给原因时，界面补的那一句 */
const DROPPED_WITHOUT_REASON = "有一张附件没能发出去（宿主没说明原因）";

/**
 * 一条消息上要显示的句子（顺序 = 用户的摆放顺序，与 `attachments` 一致）。
 *
 * 返回空数组 = 这一轮附件都好好走了，界面上一个字都不出现。
 */
export function attachmentNotes(items: readonly AttachmentOutcome[] | undefined): string[] {
  if (!items || items.length === 0) return [];
  const notes: string[] = [];
  for (const item of items) {
    if (item.problem !== null) {
      // 宿主/客户端库渲染好的那句话，原文搬运
      notes.push(item.problem.message);
      continue;
    }
    if (item.deliveredAs === "dropped") {
      // 没原因也得说一句：一张图没发出去不能看起来像成功了
      notes.push(DROPPED_WITHOUT_REASON);
    }
  }
  return notes;
}
