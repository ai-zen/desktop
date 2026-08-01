/**
 * 会话仓储 — SQLite 实现（表 conversations）。
 * 元数据走结构化列（列表/排序/搜索不解析大 JSON），消息整体存 messages blob。
 * 接口保持与原来一致：list/read/write/delete/removeWorkspace。
 */

import type { Conversation } from "@ai-zen/desktop-shared";
import { getDb } from "./db.js";

interface ConversationRow {
  id: string;
  workspace_id: string;
  agent_id: string;
  model_id: string;
  name: string;
  messages: string;
  created_at: string;
  updated_at: string;
}

function rowToConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    agentId: row.agent_id,
    modelId: row.model_id,
    name: row.name,
    messages: JSON.parse(row.messages || "[]"),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class ConversationRepository {
  async list(workspaceId: string): Promise<Conversation[]> {
    const rows = getDb()
      .prepare(
        `SELECT id, workspace_id, agent_id, model_id, name, messages, created_at, updated_at
         FROM conversations WHERE workspace_id = ? ORDER BY updated_at DESC`,
      )
      .all(workspaceId) as unknown as ConversationRow[];
    return rows.map(rowToConversation);
  }

  async read(
    workspaceId: string,
    id: string,
  ): Promise<Conversation | null> {
    const row = getDb()
      .prepare(
        `SELECT id, workspace_id, agent_id, model_id, name, messages, created_at, updated_at
         FROM conversations WHERE id = ? AND workspace_id = ?`,
      )
      .get(id, workspaceId) as unknown as ConversationRow | undefined;
    return row ? rowToConversation(row) : null;
  }

  /** 全量快照写：meta 列 + messages blob；更新时保留 created_at */
  async write(
    workspaceId: string,
    conversation: Conversation,
  ): Promise<void> {
    getDb()
      .prepare(
        `INSERT INTO conversations(
           id, workspace_id, agent_id, model_id, name,
           message_count, messages, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           workspace_id = excluded.workspace_id,
           agent_id     = excluded.agent_id,
           model_id     = excluded.model_id,
           name         = excluded.name,
           message_count = excluded.message_count,
           messages     = excluded.messages,
           updated_at   = excluded.updated_at`,
      )
      .run(
        conversation.id,
        workspaceId,
        conversation.agentId,
        conversation.modelId,
        conversation.name,
        conversation.messages?.length ?? 0,
        JSON.stringify(conversation.messages ?? []),
        conversation.createdAt,
        conversation.updatedAt,
      );
  }

  async delete(workspaceId: string, id: string): Promise<void> {
    getDb()
      .prepare("DELETE FROM conversations WHERE id = ? AND workspace_id = ?")
      .run(id, workspaceId);
  }

  /** 删除某 workspace 的全部会话（删除工作空间时级联清理） */
  async removeWorkspace(workspaceId: string): Promise<void> {
    getDb()
      .prepare("DELETE FROM conversations WHERE workspace_id = ?")
      .run(workspaceId);
  }
}
