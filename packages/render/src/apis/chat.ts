/**
 * chat api — 聊天（对应 main HostChatService）。
 * 发送消息 + 订阅流式推送（chat:push 单通道）+ 问题对象（`question.list` / `question.answer`）。
 */

import type {
  AssetContent,
  AssetVariant,
  AttachmentInput,
  ChatState,
  ChatStreamEvent,
  QuestionAnswerResult,
  QuestionView,
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
 * 取一份历史图片的字节（`asset.get`，main 转发给宿主）。
 *
 * 返回的是整份回包（`asset` 里的 mime / 宽高 / 名字 / 字节数都在，`variant` 是实际给的档）加字节
 * 本体，调用方自己造 `blob:` URL（`stores/assetImages.ts` 管这件事：同一份素材一屏只取一次、
 * 用完回收）。这里不带任何缓存与重试：取不到就抛（`InvokeHostError`），与其余调用同一口径。
 */
export function getChatAsset(assetId: string, variant: AssetVariant): Promise<AssetContent> {
  return invokeService("chat", "getAsset", assetId, variant);
}

/** 中止生成（main 让宿主取消本轮，保留已生成部分，事件流自然收尾） */
export function abortChatMessage(conversationId: string): Promise<void> {
  return invokeService("chat", "abort", conversationId);
}

/**
 * 读取会话现场状态（宿主 `conversation.state` 原样 + 整段消息）。
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

/**
 * 拉一段对话挂着的问题（`chat.questions` → 宿主 `question.list`）。
 *
 * ## 为什么不能只等推送
 *
 * 推送不重放：另开一个窗口、断线重连之后、或者这道题在本端连上之前就挂上了 —— 那几种情况下
 * 一条 `question` 事件都收不到，界面上就是「打开这段对话看着正常，一发消息却被
 * `question_pending` 拒」。所以打开对话时（`chat store` 的 `activate`）与答完之后各拉一次。
 *
 * 回的是**整份 `QuestionView` 列表**（含已答 / 已过期的）：界面按 `state` 决定显不显示，
 * 不在这一层过滤。
 */
export function listQuestions(conversationId: string): Promise<QuestionView[]> {
  return invokeService("chat", "questions", conversationId);
}

/**
 * 回答一道题（`chat.answerQuestion` → 宿主 `question.answer`）。
 *
 * 回包就是宿主那两个字段：`question`（答完之后的那份问题对象，`state` 已变成 `answered`）与
 * `effects`（`handoffStarted` / `newConversationId`）。**答完接着做什么由宿主说**：交接顺带开出来
 * 的新对话 id 就在 `effects` 里，界面照着切过去，自己不去推「该不该开新会话」。
 *
 * 这个函数**没有任何默认值**：`value` 必须是用户点中的那个候选（`options[].value`）。
 */
export function answerQuestion(
  questionId: string,
  value: string,
): Promise<QuestionAnswerResult> {
  return invokeService("chat", "answerQuestion", questionId, value);
}

/** 订阅流式推送，返回取消订阅函数 */
export function onChatPush(
  callback: (evt: ChatStreamEvent) => void,
): () => void {
  return subscribeServiceEvent<ChatStreamEvent>("chat:push", callback);
}
