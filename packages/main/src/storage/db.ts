/**
 * SQLite 数据库（node:sqlite，Node 内置，零 native 依赖）。
 *
 * - 单例：getDb() 首次调用时建库 + 建表。
 * - 表：workspaces（轻量）、conversations（meta 结构化列 + messages JSON blob）。
 * - 元数据与消息分离：列表/排序/搜索只读结构化列，不解析大 JSON。
 */

import { join } from "path";
import { existsSync, mkdirSync } from "fs";
import { DatabaseSync } from "node:sqlite";
import { DESKTOP_DIR } from "../config.js";

const DB_PATH = join(DESKTOP_DIR, "ai-zen.db");

let db: DatabaseSync | null = null;

/** 数据库单例（懒初始化：建库 + 建表） */
export function getDb(): DatabaseSync {
  if (!db) {
    if (!existsSync(DESKTOP_DIR)) {
      mkdirSync(DESKTOP_DIR, { recursive: true });
    }
    db = new DatabaseSync(DB_PATH);
    db.exec("PRAGMA journal_mode = WAL;");
    createSchema(db);
  }
  return db;
}

export function closeDb() {
  db?.close();
  db = null;
}

function createSchema(db: DatabaseSync) {
  db.exec(`
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
