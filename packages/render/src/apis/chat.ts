/**
 * chat api — 聊天（对应 main ServerChatService）。
 * 发送消息 + 订阅流式推送（chat:push 单通道）。
 */

import type {
  AssetContent,
  AssetVariant,
  AttachmentInput,
  ChatState,
  ChatStreamEvent,
} from "@ai-zen/desktop-shared";
import { invokeService, subscribeServiceEvent } from "./base.js";

/**
 * 发一条消息（可选带图片附件）。
 *
 * 附件在这里就是一串字节（`AttachmentInput`）：上传、`assetIds` 的摆放、`conversation.send` 都在
 * main 那一头做（它手上有客户端库，而且上传的字节不该在 render 里分片）。render 只负责「用户选了
 * 哪几张」。
 *
 * 没附件时第四个参数不传 —— main 那边看到的是 `undefined`，走的就是纯文本那条老路。
 *
 * 返回值仍然是 `void`：受理与否看事件（`user` / `start` / `error` / `attachments`），不靠 IPC 的
 * 回执 —— 与纯文本那一轮完全同一口径。
 */
export function sendChatMessage(
  workspaceId: string,
  conversationId: string,
  content: string,
  attachments?: AttachmentInput[],
): Promise<void> {
  return invokeService("chat", "send", workspaceId, conversationId, content, attachments);
}

/**
 * 取一份历史图片的字节（`asset.get`，main 转发给服务端）。
 *
 * 返回的是整份回包（`asset` 里的 mime / 宽高 / 名字 / 字节数都在，`variant` 是实际给的档）加字节
 * 本体，调用方自己造 `blob:` URL（`stores/assetImages.ts` 管这件事：同一份素材一屏只取一次、
 * 用完回收）。这里不带任何缓存与重试：取不到就抛（`InvokeServerError`），与其余调用同一口径。
 */
export function getChatAsset(assetId: string, variant: AssetVariant): Promise<AssetContent> {
  return invokeService("chat", "getAsset", assetId, variant);
}

/** 中止生成（main 让服务端取消本轮，保留已生成部分，事件流自然收尾） */
export function abortChatMessage(conversationId: string): Promise<void> {
  return invokeService("chat", "abort", conversationId);
}

/**
 * 读取会话现场状态（服务端 `conversation.state` 原样 + 整段消息）。
 *
 * 「在不在跑」不另给一个布尔：就是 `run.status === "running"`。上下文、思考档位、用量、挂着的
 * 问题、状态栏那几块全在这个回包里，谁需要谁读。
 */
export function getChatState(
  workspaceId: string,
  conversationId: string,
): Promise<ChatState> {
  return invokeService("chat", "getState", workspaceId, conversationId);
}

/** 订阅流式推送，返回取消订阅函数 */
export function onChatPush(
  callback: (evt: ChatStreamEvent) => void,
): () => void {
  return subscribeServiceEvent<ChatStreamEvent>("chat:push", callback);
}
