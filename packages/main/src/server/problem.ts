/**
 * 「一次失败 / 一句提示」→ `LocalizedText` / `ProblemFact`（`packages/shared/src/types.ts`）。
 *
 * ## 为什么不是一句 `error.message`
 *
 * 事件里只放一句话就等于把码、参数、detail 全扔掉：界面想按码分支（`question_pending` 与
 * `busy` 不是同一件事）、想拿参数重排一句话、想知道「差的是哪个字段」，都没有东西可读。
 * 客户端库的 `ClientError` 本来就把这几样带着（`code` / `message` / `params` / `detail`），
 * 服务端回的错更是连句子都按连接语言渲染好了 —— 这里只把它搬进 `ProblemFact`。
 *
 * ## 两种来源，一种形状
 *
 *   · **客户端库/服务端给的失败**（`ClientError`）：码、参数、句子、detail 原样搬过来；
 *   · **本进程自己的句子**（意外异常，或「断线重连失败」这类 main 才看得见的事）：
 *     只有一个 `message`，于是码与文案键留空、参数为空 —— 那正是它的事实。
 *
 * `messageKey` 由服务端按它的 key 空间给；本进程产出的句子不在那张表里，所以是空串。
 */

import { isClientError } from "@ai-zen/agents-client";
import type { LocalizedText, ProblemFact } from "@ai-zen/desktop-shared";

/**
 * 一个异常 → `ProblemFact`。
 *
 * `detail` 有才带（`ClientError` 里它是可选的）：没有这个字段与「有，但是空」不是一回事。
 */
export function problemOf(error: unknown): ProblemFact {
  if (isClientError(error)) {
    return {
      code: error.code,
      messageKey: "",
      params: error.params,
      message: error.message,
      ...(error.detail === undefined ? {} : { detail: error.detail }),
    };
  }
  return localText(error instanceof Error ? error.message : String(error));
}

/** 本进程自己的一句话（没有码、没有参数）→ `LocalizedText`（`ProblemFact` 也认它） */
export function localText(message: string): LocalizedText {
  return { code: "", messageKey: "", params: {}, message };
}
