/**
 * 工作空间服务 — 对应 render 的 apis/workspace.ts。
 */

import { randomUUID } from "node:crypto";
import type { Workspace } from "@ai-zen/desktop-shared";
import type { WorkspaceRepository } from "../storage/WorkspaceRepository.js";

export class WorkspaceService {
  constructor(
    private repo: WorkspaceRepository,
    /** 用户不填目录时的默认工作目录（main 侧注入，如桌面） */
    private defaultCwd: () => string,
  ) {}

  async list(): Promise<Workspace[]> {
    return this.repo.list();
  }

  async create(name: string, cwd: string): Promise<Workspace> {
    const workspace: Workspace = {
      id: randomUUID(),
      name,
      cwd: cwd?.trim() || this.defaultCwd(),
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
  }
}
