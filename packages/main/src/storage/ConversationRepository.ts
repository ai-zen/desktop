/**
 * 会话仓储 — 每个会话一个 JSON 文件：{conversationsDir}/{workspaceId}/{id}.json。
 * 按 workspace 分子目录，复用 SDK 的 EntityRepository（list/read/write/delete，目录自动创建）。
 */

import { join } from "path";
import { EntityRepository } from "@ai-zen/agents-sdk";
import type { Conversation } from "@ai-zen/desktop-shared";

export class ConversationRepository {
  private repos = new Map<string, EntityRepository<Conversation>>();

  constructor(private baseDir: string) {}

  /** 每个 workspace 一个子仓储（轻量缓存） */
  private repo(workspaceId: string): EntityRepository<Conversation> {
    let repo = this.repos.get(workspaceId);
    if (!repo) {
      repo = new EntityRepository<Conversation>(join(this.baseDir, workspaceId));
      this.repos.set(workspaceId, repo);
    }
    return repo;
  }

  list(workspaceId: string): Promise<Conversation[]> {
    return this.repo(workspaceId).list();
  }

  read(workspaceId: string, id: string): Promise<Conversation | null> {
    return this.repo(workspaceId).read(id);
  }

  write(workspaceId: string, conversation: Conversation): Promise<void> {
    return this.repo(workspaceId).write(conversation);
  }

  delete(workspaceId: string, id: string): Promise<void> {
    return this.repo(workspaceId).delete(id);
  }
}
