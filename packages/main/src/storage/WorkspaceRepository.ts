/**
 * 工作空间仓储 — SQLite 实现（表 workspaces，经 worker 异步访问）。
 * 接口保持与原来一致：list/read/write/delete。
 */

import type { Workspace } from "@ai-zen/desktop-shared";
import type { Database } from "./Database.js";

interface WorkspaceRow {
  id: string;
  name: string;
  cwd: string;
}

function rowToWorkspace(row: WorkspaceRow): Workspace {
  return { id: row.id, name: row.name, cwd: row.cwd };
}

export class WorkspaceRepository {
  constructor(private readonly db: Database) {}

  async list(): Promise<Workspace[]> {
    const rows = await this.db.all<WorkspaceRow>(
      "SELECT id, name, cwd FROM workspaces ORDER BY created_at",
    );
    return rows.map(rowToWorkspace);
  }

  async read(id: string): Promise<Workspace | null> {
    const row = await this.db.get<WorkspaceRow>(
      "SELECT id, name, cwd FROM workspaces WHERE id = ?",
      [id],
    );
    return row ? rowToWorkspace(row) : null;
  }

  /** upsert：插入时记 created_at，更新时保留原 created_at */
  async write(workspace: Workspace): Promise<void> {
    await this.db.run(
      `INSERT INTO workspaces(id, name, cwd, created_at)
       VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, cwd = excluded.cwd`,
      [workspace.id, workspace.name, workspace.cwd],
    );
  }

  async delete(id: string): Promise<void> {
    await this.db.run("DELETE FROM workspaces WHERE id = ?", [id]);
  }
}
