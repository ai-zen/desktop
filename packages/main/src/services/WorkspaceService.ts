/**
 * 工作空间服务 — 对应 render 的 apis/workspace.ts。
 */

import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import type { Workspace } from "@ai-zen/desktop-shared";
import type { WorkspaceRepository } from "../storage/WorkspaceRepository.js";
import type { ConversationRepository } from "../storage/ConversationRepository.js";

export class WorkspaceService {
  constructor(
    private repo: WorkspaceRepository,
    /** 用户不填目录时的默认工作目录（main 侧注入，如桌面） */
    private defaultCwd: () => string,
    /** 用于删除工作空间时级联清理其全部会话 */
    private conversationRepo: ConversationRepository,
    /** 删除后的联动钩子（如释放运行中的 agent） */
    private hooks?: { onRemove?: (id: string) => Promise<void> | void },
  ) {}

  async list(): Promise<Workspace[]> {
    return this.repo.list();
  }

  async create(name: string, cwd: string): Promise<Workspace> {
    const resolvedCwd = cwd?.trim() || this.defaultCwd();
    const workspace: Workspace = {
      id: randomUUID(),
      // 名称选填：不填则默认使用所选目录的文件夹名
      name: name?.trim() || basename(resolvedCwd),
      cwd: resolvedCwd,
    };
    await this.repo.write(workspace);
    return workspace;
  }

  async rename(id: string, name: string): Promise<void> {
    const workspace = await this.repo.read(id);
    if (!workspace) throw new Error(`工作空间不存在: ${id}`);
    workspace.name = name;
    await this.repo.write(workspace);
  }

  async remove(id: string): Promise<void> {
    await this.repo.delete(id);
    // 级联清理该工作空间下的全部会话（删工作空间 → 删会话；反向不成立）
    await this.conversationRepo.removeWorkspace(id);
    await this.hooks?.onRemove?.(id);
  }
}
