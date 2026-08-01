/**
 * 工作空间仓储 — 每个工作空间一个 JSON 文件（{workspacesDir}/{id}.json）。
 * 复用 SDK 的 EntityRepository（list/read/write/delete，目录自动创建）。
 */

import { EntityRepository } from "@ai-zen/agents-sdk";
import type { Workspace } from "@ai-zen/desktop-shared";

export class WorkspaceRepository extends EntityRepository<Workspace> {}
