/**
 * SQLite 数据库（异步版）— 通过 worker_threads 把 node:sqlite（仅同步 DatabaseSync）
 * 隔离到独立线程，主线程用异步消息调用，避免同步 SQL 阻塞事件循环。
 *
 * 以类形式承载状态（worker / pending / nextId），实例由 DesktopApp 单根创建并
 * 注入给各 Repository（依赖从根出发，不在此处导出模块级单例）。
 *
 * 对外三个语义化方法（泛型，Repository 直接使用，无需类型断言）：
 *   db.all<T>(sql, params)   → 多行查询
 *   db.get<T>(sql, params)   → 单行查询
 *   db.run(sql, params)      → 写操作
 */

import { Worker } from "node:worker_threads";
import { type SQLInputValue } from "node:sqlite";

type Mode = "all" | "get" | "run";

/** 写操作返回（lastInsertRowid 已由 worker 统一转 number，保证可序列化） */
export interface RunResult {
  changes: number;
  lastInsertRowid: number;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

export class Database {
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();

  constructor(private readonly dbPath: string) {}

  /** 查询多行 */
  all<T = unknown>(
    sql: string,
    params: SQLInputValue[] = [],
  ): Promise<T[]> {
    return this.call("all", sql, params) as Promise<T[]>;
  }

  /** 查询单行（无结果返回 undefined） */
  get<T = unknown>(
    sql: string,
    params: SQLInputValue[] = [],
  ): Promise<T | undefined> {
    return this.call("get", sql, params) as Promise<T | undefined>;
  }

  /** 写操作（INSERT / UPDATE / DELETE） */
  run(sql: string, params: SQLInputValue[] = []): Promise<RunResult> {
    return this.call("run", sql, params) as Promise<RunResult>;
  }

  /** 优雅关闭：终止 worker（进程退出时非必需，Worker 随主进程退出自动结束） */
  async close(): Promise<void> {
    const w = this.worker;
    if (w) {
      // 先断引用再终止：exit 事件的 failAll 不会误清后续新建的 worker
      this.worker = null;
      await w.terminate();
    }
  }

  /** worker 崩溃/退出：reject 全部等待中的请求，并清空引用以便下次自动重建 */
  private failAll(error: Error): void {
    for (const [, p] of this.pending) p.reject(error);
    this.pending.clear();
    this.worker = null;
  }

  private getWorker(): Worker {
    if (!this.worker) {
      this.worker = new Worker(new URL("./dbWorker.mjs", import.meta.url), {
        workerData: { dbPath: this.dbPath },
      });
      this.worker.on("message", (msg: { id: number; ok: boolean; result?: unknown; error?: string }) => {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.ok) p.resolve(msg.result);
        else p.reject(new Error(msg.error));
      });
      this.worker.on("error", (err) => this.failAll(err instanceof Error ? err : new Error(String(err))));
      this.worker.on("exit", () => this.failAll(new Error("SQLite worker 退出")));
    }
    return this.worker;
  }

  /** 统一执行通道：发消息 + 按 id 收 Promise */
  private call(mode: Mode, sql: string, params: SQLInputValue[]): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.getWorker().postMessage({ id, mode, sql, params });
      } catch (err) {
        // worker 不可用（如启动失败/已终止未触发 exit）：立即失败并清掉挂起项
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }
}
