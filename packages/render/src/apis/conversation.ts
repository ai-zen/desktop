/**
 * conversation api — 会话（对应 main ConversationService）。
 */

import type { Conversation, ConversationSummary } from "@ai-zen/desktop-shared";
import { invokeService } from "./base.js";

export function listConversations(
  workspaceId: string,
): Promise<ConversationSummary[]> {
  return invokeService("conversation", "list", workspaceId);
}

export function createConversation(
  workspaceId: string,
  agentId: string,
): Promise<Conversation> {
  return invokeService("conversation", "create", workspaceId, agentId);
}

export function getConversation(
  workspaceId: string,
  id: string,
): Promise<Conversation | null> {
  return invokeService("conversation", "read", workspaceId, id);
}

export function removeConversation(
  workspaceId: string,
  id: string,
): Promise<void> {
  return invokeService("conversation", "remove", workspaceId, id);
}

export function setConversationModel(
  workspaceId: string,
  id: string,
  modelId: string,
): Promise<void> {
  return invokeService("conversation", "setModel", workspaceId, id, modelId);
}
