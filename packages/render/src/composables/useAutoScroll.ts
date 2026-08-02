/**
 * 聊天自动滚动策略。
 *
 * - alignToBottom：初始化/切会话时强制对齐底部（一次滚底 + 下一帧兑底）。
 * - followIfNearBottom：内容增量（append / delta / done）时仅当视口位于底部附近
 *   才跟随 —— 用户上翻历史时不强制拽回底部。
 */
import { nextTick } from "vue";

export function useAutoScroll(
  scroller: () => HTMLElement | null,
  nearBottomThreshold = 120,
) {
  /** 视口是否在底部附近（剩余距离 < 阈值 px） */
  function isNearBottom(): boolean {
    const el = scroller();
    if (!el) return false;
    return el.scrollHeight - el.scrollTop - el.clientHeight < nearBottomThreshold;
  }

  function scrollToBottom() {
    const el = scroller();
    if (el) el.scrollTop = el.scrollHeight;
  }

  /** 初始化对齐底部：markdown 同步渲染，一次滚底 + 下一帧兑底即可 */
  function alignToBottom() {
    scrollToBottom();
    nextTick(() => scrollToBottom());
  }

  /** 内容增量时跟随（仅在底部附近，上翻历史不拽回） */
  function followIfNearBottom() {
    if (isNearBottom()) scrollToBottom();
  }

  return { isNearBottom, scrollToBottom, alignToBottom, followIfNearBottom };
}
