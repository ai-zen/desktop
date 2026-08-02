/**
 * 消息渲染窗口（QQ/微信式分页加载）。
 *
 * 维护 [loadedStart, messages.length) 的渲染窗口，尾部始终跟随最新消息。
 * - 首屏：resetToTail() 对齐最近 initialLoad 条（底部开始）
 * - 上翻：loadOlder() 窗口起点前移 pageSize 条，并按高度差补偿 scrollTop，
 *   使视口内容位置不跳动
 * - 上限：maxLoaded 条，超出丢最旧（起点压缩）。压缩时 next 恒 ≤ loadedStart
 *   （窗口永不上移），因此补偿恒为正，不会出现视口跳动
 *
 * items 返回渲染窗口内的消息（id 恒存在，直接作为 v-for key）：
 * prepend 更早消息时已有消息的 id 不变，作为 v-for 的 key 时 DOM 常驻，
 * 折叠状态天然保持 —— key 稳定性是这套方案的基石。
 */
import { computed, nextTick, ref } from "vue";
import type { AgentNS } from "@ai-zen/agents-core";

export interface MessageWindowOptions {
  /** 首屏加载条数（底部开始） */
  initialLoad?: number;
  /** 上翻历史每次加载条数 */
  pageSize?: number;
  /** DOM 常驻上限（超出丢最旧） */
  maxLoaded?: number;
}

/** 渲染链路中的消息：id 恒存在 —— agent 构造即生成；
 *  流式事件携带真实 id；历史快照经 ConversationRepository 懒迁移补齐 */
export type MessageWithId = AgentNS.Message & { id: string };

export function useMessageWindow(
  messages: () => AgentNS.Message[],
  scroller: () => HTMLElement | null,
  options: MessageWindowOptions = {},
) {
  const { initialLoad = 20, pageSize = 20, maxLoaded = 200 } = options;

  /** 窗口起点（全局 index），窗口 = messages.slice(loadedStart) */
  const loadedStart = ref(0);
  /** 上翻加载中（防 scroll 事件重入） */
  const loadingOlder = ref(false);

  /** 渲染窗口内的可见消息（id 恒存在，直接作为 v-for key） */
  const items = computed<MessageWithId[]>(() =>
    messages().slice(loadedStart.value) as MessageWithId[],
  );

  /** 是否还有更早历史可加载 */
  const hasOlder = computed(() => loadedStart.value > 0);

  /** 会话初始化：窗口对齐最近 initialLoad 条（空数组时安全，对齐到 0） */
  function resetToTail() {
    loadedStart.value = Math.max(0, messages().length - initialLoad);
  }

  /**
   * 上翻加载更早历史：窗口起点前移 pageSize 条。
   * 窗口超上限时压缩起点（丢最旧）；next 恒 ≤ loadedStart，补偿恒为正。
   * prepend 后按 scrollHeight 高度差补偿 scrollTop，视口内容位置不变。
   * @returns 是否发生了加载
   */
  async function loadOlder(): Promise<boolean> {
    const el = scroller();
    const len = messages().length;
    if (!el || loadingOlder.value || loadedStart.value <= 0) return false;

    let next = Math.max(0, loadedStart.value - pageSize);
    if (len - next > maxLoaded) next = len - maxLoaded;
    if (next === loadedStart.value) return false;

    const prevHeight = el.scrollHeight;
    const prevTop = el.scrollTop;
    loadingOlder.value = true;
    loadedStart.value = next;
    await nextTick();
    // prepend 后顶部新增内容：scrollTop 加上高度差，视口内容保持原位
    el.scrollTop = prevTop + (el.scrollHeight - prevHeight);
    loadingOlder.value = false;
    return true;
  }

  return { loadedStart, items, hasOlder, loadingOlder, resetToTail, loadOlder };
}
