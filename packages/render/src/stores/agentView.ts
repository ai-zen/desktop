/**
 * 子 Agent 栏目的**纯逻辑**：选中态修正 + Tab 循环顺序。
 *
 * 为什么单独一个文件（而不是写在 `stores/chat.ts` 里）：那里的模块级 import 有
 * `element-plus`（通知 toast 用 `ElMessage`）与 pinia store 互相引用，在 node 环境里
 * 跑不起来；把规则搬来这里，测的仍然是生产代码用的同一份实现，而不是另写一份影子逻辑。
 * 本文件只依赖 `SubAgentView` 的**类型**（`import type`，编译期擦除），没有任何运行时依赖。
 *
 * 规则只有两条，且都只跟「栏目当前有哪些子 Agent」和「现在看的是谁」有关：
 *   - 选中的子 Agent 不在新列表里了 → 退回主对话（`agents: []` 或换了一批的结果）；
 *   - Tab 循环顺序固定为 `主对话 → 子1 → 子2 → … → 主对话`。
 */
import type { SubAgentView } from "@ai-zen/desktop-shared";

/**
 * 主对话的视图 id。
 *
 * 用空串而不是 `"main"`：这个值直接落在会话状态槽位里当「有没有选中子 Agent」的判据，
 * 空串同时也是一眼就能看出的「没选任何子 Agent」（falsy），省掉一层 `=== "main"` 的转换。
 */
export const MAIN_AGENT_VIEW_ID = "";

/**
 * 按新到的栏目列表修正选中项：选中的子 Agent 还在就保持，不在了就退回主对话。
 *
 * 为什么必须有这一步：栏目**整份替换**，而替换有两种「消失」——`agents: []`（这一轮结束）
 * 和换了一批 id（新一轮的子 Agent 拿到了新 id）。两种情况下若不动 `activeAgentId`，
 * 会话就会停在一段已经不存在的子对话上：列表换成新 Agent 的消息，标题却还写着旧选项
 * （甚至一屏空白），用户既看不出发生了什么，也没有任何标签处于高亮。
 */
export function resolveActiveAgentId(
  agents: readonly SubAgentView[],
  activeAgentId: string,
): string {
  if (activeAgentId === MAIN_AGENT_VIEW_ID) return MAIN_AGENT_VIEW_ID;
  return agents.some((agent) => agent.id === activeAgentId)
    ? activeAgentId
    : MAIN_AGENT_VIEW_ID;
}

/**
 * Tab 切换的下一个视图 id：`主对话 → 子1 → 子2 → … → 主对话`（首尾相接）。
 *
 * 起点取**当前列表里**的位置（不是记下来的序号）：选中项已失效时（调用方没来得及修正，
 * 例如栏目刚换了一批）把它当成主对话（下标 0），于是下一次落到子1 —— 而不是从一个
 * 说不清位置开始数。
 * 没有子 Agent 时无处可切，返回主对话 —— 此时栏目根本不会渲染，Tab 也不该被拦截。
 */
export function nextAgentViewId(
  agents: readonly SubAgentView[],
  activeAgentId: string,
): string {
  const ids = [MAIN_AGENT_VIEW_ID, ...agents.map((agent) => agent.id)];
  const current = Math.max(0, ids.indexOf(activeAgentId));
  const next = ids[(current + 1) % ids.length];
  return next ?? MAIN_AGENT_VIEW_ID;
}
