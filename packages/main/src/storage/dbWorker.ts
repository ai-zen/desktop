/**
 * SQLite worker 线程 — 独立线程持有 DatabaseSync（node:sqlite 仅同步 API），
 * 通过消息与主线程异步通信，避免同步 SQL 阻塞主进程事件循环。
 *
 * 设计：
 *   - 只做 SQL 执行（all / get / run 三种模式），参数与结果走结构化克隆
 *   - 不 import 任何 electron 依赖（dbPath 由主线程 workerData 注入）
 *   - 懒启动、常驻，随主进程退出自动终止
 */

import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";

const { dbPath } = workerData as { dbPath: string };

// 兜底确保数据目录存在（主线程也会建，双保险）
try {
  mkdirSync(dirname(dbPath), { recursive: true });
} catch {
  // 目录已存在或不可创建，交给 DatabaseSync 报错
}

const db = new DatabaseSync(dbPath);
db.exec("PRAGMA journal_mode = WAL;");
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

interface WorkerRequest {
  id: number;
  mode: "all" | "get" | "run";
  sql: string;
  params: SQLInputValue[];
}

/** 语句缓存：SQL 均来自固定仓储语句，数量有限；避免热路径每次 prepare 重新编译 */
const stmtCache = new Map<string, StatementSync>();

function prepare(sql: string): StatementSync {
  let stmt = stmtCache.get(sql);
  if (!stmt) {
    stmt = db.prepare(sql);
    stmtCache.set(sql, stmt);
  }
  return stmt;
}

parentPort!.on("message", (msg: WorkerRequest) => {
  try {
    const stmt = prepare(msg.sql);
    let result: unknown;
    if (msg.mode === "all") {
      result = stmt.all(...msg.params);
    } else if (msg.mode === "get") {
      result = stmt.get(...msg.params);
    } else {
      const r = stmt.run(...msg.params);
      // lastInsertRowid 可能是 bigint，转 number 保证可序列化
      result = {
        changes: r.changes,
        lastInsertRowid:
          typeof r.lastInsertRowid === "bigint"
            ? Number(r.lastInsertRowid)
            : r.lastInsertRowid,
      };
    }
    parentPort!.postMessage({ id: msg.id, ok: true, result });
  } catch (err) {
    parentPort!.postMessage({
      id: msg.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});
