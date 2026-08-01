/**
 * SQLite 数据库（node:sqlite，Node 内置，零 native 依赖）。
 *
 * - 单例：getDb() 首次调用时建库 + 建表 + 迁移旧 JSON 数据（仅一次）。
 * - 表：workspaces（轻量）、conversations（meta 结构化列 + messages JSON blob）。
 * - 元数据与消息分离：列表/排序/搜索只读结构化列，不解析大 JSON。
 */

import { join } from "path";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
} from "fs";
import { DatabaseSync } from "node:sqlite";
import {
  CONVERSATIONS_DIR,
  DESKTOP_DIR,
  WORKSPACES_DIR,
} from "../config.js";

const DB_PATH = join(DESKTOP_DIR, "ai-zen.db");

let db: DatabaseSync | null = null;

/** 数据库单例（懒初始化：建库 + 建表 + 迁移旧数据） */
export function getDb(): DatabaseSync {
  if (!db) {
    if (!existsSync(DESKTOP_DIR)) {
      mkdirSync(DESKTOP_DIR, { recursive: true });
    }
    db = new DatabaseSync(DB_PATH);
    db.exec("PRAGMA journal_mode = WAL;");
    createSchema(db);
    migrateJsonData(db);
  }
  return db;
}

export function closeDb() {
  db?.close();
  db = null;
}

function createSchema(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS workspaces (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      cwd        TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id            TEXT PRIMARY KEY,
      workspace_id  TEXT NOT NULL,
      agent_id      TEXT NOT NULL,
      model_id      TEXT NOT NULL,
      name          TEXT NOT NULL,
      message_count INTEGER NOT NULL DEFAULT 0,
      messages      TEXT NOT NULL DEFAULT '[]',
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_conversations_ws_updated
      ON conversations(workspace_id, updated_at DESC);
  `);
}

/**
 * 迁移旧 JSON 数据（~/.ai-zen/desktop/{workspaces,conversations}）→ SQLite。
 * 仅执行一次（meta.migrated 标记）；旧文件保留不删。
 */
function migrateJsonData(db: DatabaseSync) {
  const migrated = db
    .prepare("SELECT value FROM meta WHERE key = ?")
    .get("migrated") as { value?: string } | undefined;
  if (migrated) return;

  // workspaces
  if (existsSync(WORKSPACES_DIR)) {
    const insWs = db.prepare(`
      INSERT OR REPLACE INTO workspaces(id, name, cwd, created_at)
      VALUES (?, ?, ?, ?)
    `);
    for (const file of readdirSync(WORKSPACES_DIR).filter((f) => f.endsWith(".json"))) {
      try {
        const ws = JSON.parse(readFileSync(join(WORKSPACES_DIR, file), "utf-8"));
        if (ws?.id && ws?.name) {
          insWs.run(
            ws.id,
            ws.name,
            ws.cwd ?? "",
            ws.createdAt ?? new Date().toISOString(),
          );
        }
      } catch {
        // 单个文件损坏不影响整体迁移
      }
    }
  }

  // conversations（按 workspace 分子目录）
  if (existsSync(CONVERSATIONS_DIR)) {
    const insConv = db.prepare(`
      INSERT OR REPLACE INTO conversations(
        id, workspace_id, agent_id, model_id, name,
        message_count, messages, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const wsDir of readdirSync(CONVERSATIONS_DIR)) {
      const dir = join(CONVERSATIONS_DIR, wsDir);
      try {
        if (!statSync(dir).isDirectory()) continue;
      } catch {
        continue;
      }
      for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
        try {
          const c = JSON.parse(readFileSync(join(dir, file), "utf-8"));
          if (c?.id && c?.workspaceId) {
            insConv.run(
              c.id,
              c.workspaceId,
              c.agentId ?? "",
              c.modelId ?? "",
              c.name ?? "",
              Array.isArray(c.messages) ? c.messages.length : 0,
              JSON.stringify(c.messages ?? []),
              c.createdAt ?? new Date().toISOString(),
              c.updatedAt ?? new Date().toISOString(),
            );
          }
        } catch {
          // 单个文件损坏不影响整体迁移
        }
      }
    }
  }

  db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)").run(
    "migrated",
    "1",
  );
}
