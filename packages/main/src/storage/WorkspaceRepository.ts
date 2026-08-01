/**
 * 工作空间仓储 — SQLite 实现（表 workspaces）。
 * 接口保持与原来 EntityRepository 一致：list/read/write/delete。
 */

import type { Workspace } from "@ai-zen/desktop-shared";
import { getDb } from "./db.js";

interface WorkspaceRow {
  id: string;
  name: string;
  cwd: string;
}

function rowToWorkspace(row: WorkspaceRow): Workspace {
  return { id: row.id, name: row.name, cwd: row.cwd };
}

export class WorkspaceRepository {
  async list(): Promise<Workspace[]> {
    const rows = getDb()
      .prepare("SELECT id, name, cwd FROM workspaces ORDER BY created_at")
      .all() as unknown as WorkspaceRow[];
    return rows.map(rowToWorkspace);
  }

  async read(id: string): Promise<Workspace | null> {
    const row = getDb()
      .prepare("SELECT id, name, cwd FROM workspaces WHERE id = ?")
      .get(id) as unknown as WorkspaceRow | undefined;
    return row ? rowToWorkspace(row) : null;
  }

  /** upsert：插入时记 created_at，更新时保留原 created_at */
  async write(workspace: Workspace): Promise<void> {
    getDb()
      .prepare(
        `INSERT INTO workspaces(id, name, cwd, created_at)
         VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, cwd = excluded.cwd`,
      )
      .run(workspace.id, workspace.name, workspace.cwd);
  }

  async delete(id: string): Promise<void> {
    getDb().prepare("DELETE FROM workspaces WHERE id = ?").run(id);
  }
}
