/**
 * main 的配置面 —— 一个路径常量（`AI_ZEN_DIR`）与一组服务端连接配置（`SERVER_CONFIG`）。
 *
 * ## 为什么只需要根目录
 *
 * 桌面端是瘦客户端：会话执行、Agent 定义、模型配置、工作区存档全在常驻的
 * `agents-server` 那边，本进程不读写磁盘上的任何数据文件。它唯一需要的路径事实是
 * **ai-zen 的数据根在哪**，然后整根递给 `server/` 那一层（`createServerLayer({ aiZenDir })`），
 * 由它去做服务发现（`<AI_ZEN_DIR>/run/server.json`）和按需拉起服务端（`ensureServer`）
 * —— 根目录下面有什么（存档、desktop 子目录等）是**服务端的事实**，客户端不解释它。
 *
 * ## 为什么没有子路径常量
 *
 * 子路径（config.json / agents/ / workspaces/）都是**服务端的事实**，客户端不应该知道
 * 它们：多一个常量就多一处可以往本地磁盘写代码的入口。
 *
 * 环境变量 `AI_ZEN_DIR` 优先：用例要指向 `/tmp` 下的临时目录，桌面端跟着 Electron 的
 * home 走 —— 两者都不该改代码。
 */

import { app } from "electron";
import { join } from "path";

export const AI_ZEN_DIR = process.env.AI_ZEN_DIR || join(app.getPath("home"), ".ai-zen");

/**
 * 显式服务端地址与凭证 —— 字段名与 `@ai-zen/agents-client` 那两个（`serverUrl` /
 * `serverToken`）**逐字一致**：本仓不重新定义它们的含义，只是把它们从配置递到连接。
 *
 * 两个都是可选的：`undefined` = 「按老路走」（地址读发现文件 `<AI_ZEN_DIR>/run/server.json`，
 * 凭证读 `<AI_ZEN_DIR>/run/token`）。取值、优先级与降级全在客户端的
 * `resolve-target.ts` 那一处（决策 D9），桌面端只负责把用户配置原样传下去。
 */
export interface ServerConnectionConfig {
  /** 显式地址（`ws:` / `wss:` / `http:` / `https:`）：给了就**只连、不拉起**本机 server（D10） */
  serverUrl?: string;
  /** 显式凭证；没给就退回 `<AI_ZEN_DIR>/run/token` */
  serverToken?: string;
}

/**
 * 桌面端的服务端连接配置：**今天两个都是 `undefined`**（D14：只接能力，不做设置界面）。
 *
 * 为什么现在就把它摆出来，而不是等有了设置面板再加：能力那一半（透传 + 「给了地址就不拉起
 * 本机 server」）必须先在连接构造点成立，界面只是往这两个字段里填值 —— 反过来做的话，
 * 「连远端」这件事会在连接层再被发明一次（第二份 `ws://` 拼法、第二处凭证来源），而那正是
 * D8 / D9 要消掉的东西。
 *
 * 也**不**在这里读 `AI_ZEN_SERVER_URL` / `AI_ZEN_SERVER_TOKEN`：那两个环境变量属于 CLI
 * （决策 D11 与 D12），桌面端是双击启动的，进程环境里不会有它们 —— 假装支持，会让「用户设了
 * 却没生效」变成一条查不出来的死路。
 *
 * 凭证**绝不进日志**（包括「不拉起本机 server」那条）：地址是配置，凭证是钥匙。
 */
export const SERVER_CONFIG: ServerConnectionConfig = {
  serverUrl: undefined,
  serverToken: undefined,
};
