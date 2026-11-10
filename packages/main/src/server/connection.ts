/**
 * 到 `agents-server` 的那一条连接 —— 本层唯一与「传输」打交道的地方。
 *
 * ## 为什么要有这个文件（而不是每个 Service 各连各的）
 *
 * 服务端是**常驻**进程，连接也是常驻的：`ensureServer` 自己会「有就上、没有就 detached
 * 拉一个」，所以这里只该被调用一次，之后所有服务共用同一条 socket。每个 Service 自己
 * `ensureServer` 一遍的后果是 N 条连接、N 次服务发现，而且 `events.watch` 是**连接级**
 * 订阅 —— 事件会推给哪一条连接，取决于用户碰巧先触发了哪个服务。
 *
 * ## 为什么 `aiZenDir` / `clientInfo` 由调用方注入
 *
 * 它们是**应用级**事实：「这台机器上 ai-zen 的数据在哪」和「我是谁、哪个版本」。本层是
 * 库，读进程级全局（env / `app.getPath`）就再也改不了目录 —— 用例要拿临时目录起真
 * daemon，桌面端要跟着 Electron 的 home 走。两者都由组装根（`app.ts`）读一次再递进来。
 *
 * ## 为什么留一个 `client` 注入口
 *
 * 用例要连的是**自己起的那个 daemon**（`port: 0` 的系统分配端口），发现文件那条路
 * （`<aiZenDir>/run/server.json`）在这里走不通也不该走 —— 那会把用例变成「先起一个真
 * bin」的慢测。注入的连接由调用方负责生命周期，本类只负责「别的地方都拿到同一条」。
 */

import { ensureServer, type ClientInfo, type ServerClient } from "@ai-zen/agents-client";

export interface ServerConnectionOptions {
  /** 配置根目录（`AI_ZEN_DIR`）—— 服务发现文件与工作区存档都在它下面 */
  aiZenDir: string;
  /** 握手首帧自报的身份（只进日志与服务端回执，不参与鉴权） */
  clientInfo: ClientInfo;
  /** 注入一条现成的连接（用例用：指向自己起的 Daemon） */
  client?: ServerClient;
}

export class ServerConnection {
  /** 正在建 / 已建好的那条连接；`null` = 还没建过（或上次建失败） */
  private pending: Promise<ServerClient> | null = null;
  /** 已经交给调用方的那一条（`close()` 要它） */
  private current: ServerClient | null = null;

  constructor(private readonly options: ServerConnectionOptions) {}

  /** 拿连接：注入的优先，其次 `ensureServer`（有就上、没有就拉一个），建好复用 */
  async client(): Promise<ServerClient> {
    const injected = this.options.client;
    if (injected) return injected;

    this.pending ??= ensureServer({
      aiZenDir: this.options.aiZenDir,
      clientInfo: this.options.clientInfo,
    }).then(
      (result) => {
        this.current = result.client;
        return result.client;
      },
      (error: unknown) => {
        // 建连失败**不缓存**：一次瞬时故障（服务端正在重启）不该让整个进程永久失能
        this.pending = null;
        throw error;
      },
    );
    return await this.pending;
  }

  /** 调一个协议方法（参数与结果类型都来自协议包：改了协议这边编译不过） */
  async call<T>(method: string, params?: unknown): Promise<T> {
    const client = await this.client();
    return await client.call<T>(method, params);
  }

  /** 退出时断开（服务端是常驻的，不跟着桌面端退出） */
  close(): void {
    this.current?.close();
    this.current = null;
    this.pending = null;
  }
}
