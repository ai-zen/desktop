/**
 * 「这条消息要不要出现在界面上」的唯一判据。
 *
 * 宿主建会话时会写一条 `hidden: true` 的 `user` 消息（它自己的上下文，如当前目录），
 * `hidden` 取的就是 core 里的原意 —— **不给人看**。所以界面层什么都不解析：`hidden === true`
 * 就整条不画。
 *
 * 为什么不看内容：那条消息里写了什么、分了几段、末尾是不是某句话，都是宿主的排版。
 * 界面层按内容去认形状，等于把宿主某一版的写法抄进渲染代码 —— 宿主换个写法就得跟着改，
 * 而真正的判据（`hidden`）一直在消息自己的字段上。
 *
 * 判据与过滤都只有这一份：视图侧只在 `chat` store 的 `viewMessages` 这一处调用它
 * （气泡组件、渲染窗口、滚动跟随读的都是那一份），不在多个组件里各判一遍 —— 各写一遍
 * `message.hidden === true` 迟早会有一处写成真值判断或漏掉，那时界面上就会多出一条没人说过的话。
 */
import type { AgentNS } from "@ai-zen/agents-core";

/**
 * 这条消息是否「不给人看」。
 *
 * 严格比 `true`：`hidden` 在类型上是 `boolean | undefined`，`false` / `undefined` 都是
 * 「正常消息」。用真值判断会把 `hidden: false` 也算进去。
 */
export function isHidden(message: AgentNS.Message): boolean {
  return message.hidden === true;
}

/**
 * 过滤掉不给人看的那几条（顺序与内容原样保留）。
 *
 * 返回新数组：调用方拿到的是 store 里那一份 `messages`，就地 `splice` 会把原始数据改掉
 * （重连补拉 / 重试还要用它）。
 */
export function visibleMessages(messages: readonly AgentNS.Message[]): AgentNS.Message[] {
  return messages.filter((message) => !isHidden(message));
}
