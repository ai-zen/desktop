/**
 * chat api — 聊天（对应 main ChatService）。
 * 发送消息 + 订阅流式推送（chat:push 单通道）。
 */

import type { ChatStreamEvent, ConversationState } from "@ai-zen/desktop-shared";
import { invokeService, subscribeServiceEvent } from "./base.js";

export function sendChatMessage(
  workspaceId: string,
  conversationId: string,
  content: string,
): Promise<void> {
  return invokeService("chat", "send", workspaceId, conversationId, content);
}

/** 中止生成（main 对运行中 agent 调 abort，保留已生成部分，事件流自然收尾） */
export function abortChatMessage(conversationId: string): Promise<void> {
  return invokeService("chat", "abort", conversationId);
}

/** 读取会话实时状态（有常驻 agent 则含流式进行中的消息） */
export function getChatState(
  workspaceId: string,
  conversationId: string,
): Promise<ConversationState> {
  return invokeService("chat", "getState", workspaceId, conversationId);
}

/** 订阅流式推送，返回取消订阅函数 */
export function onChatPush(
  callback: (evt: ChatStreamEvent) => void,
): () => void {
  return subscribeServiceEvent<ChatStreamEvent>("chat:push", callback);
}
