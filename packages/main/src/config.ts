/**
 * main 的配置面 —— 一个路径常量（`AI_ZEN_DIR`）与「显式地址 + 凭证」那两个字段的形状。
 *
 * ## 为什么只需要根目录
 *
 * 桌面端是瘦客户端：会话执行、Agent 定义、模型配置、工作区存档全在常驻的
 * `agents-server` 那边，本进程不读写那里的任何数据文件。它需要的路径事实是
 * **ai-zen 的数据根在哪**，然后整根递给 `server/` 那一层（`createServerLayer({ aiZenDir })`），
 * 由它去做服务发现（`<AI_ZEN_DIR>/run/server.json`）和按需拉起服务端（`ensureServer`）
 * —— 根目录下面有什么（存档、agents/、workspaces/）是**服务端的事实**，客户端不解释它。
 *
 * ## 为什么没有子路径常量（本批起有且只有**一个**例外）
 *
 * 子路径（`config.json` / `agents/` / `workspaces/`）仍然是**服务端的事实**：客户端多知道一个
 * 就多一处可以往本地磁盘写代码的入口。
 *
 * 唯一的例外是 `<AI_ZEN_DIR>/desktop/connection.json`（连接设置，D17）。它的路径也不在本文件
 * 拼——唯一实现处是 `connection/settings.ts` 的 `connectionSettingsPath()`，本文件不重复一遍。
 * 这个文件必须落在**本机**而不是服务端，理由是**先有鸡先有蛋**：
 *
 *   · 服务端手上有「该连哪儿」的全部业务配置，可要问它，得先知道**连哪台**；
 *   · 把「连哪台」也存到服务端，就等于要求用户先连上服务端，才能选服务端；
 *   · 所以它是客户端唯一一处自己的持久化，只存两样用户手填的东西（模式 + 远程地址 / 凭证），
 *     `0600`、原子写、凭证绝不进日志（D22）。
 *
 * 环境变量 `AI_ZEN_DIR` 优先：用例要指向 `/tmp` 下的临时目录，桌面端跟着 Electron 的
 * home 走 —— 两者都不该改代码。
 */

import { app } from "electron";
import { join } from "path";

export const AI_ZEN_DIR = process.env.AI_ZEN_DIR || join(app.getPath("home"), ".ai-zen");

/**
 * 显式服务端地址与凭证 —— 字段名与 `@ai-zen/agents-client` 那两个（`serverUrl` /
 * `serverToken`）**逐字一致**：本仓不重新定义它们的含义，只是把它们从用户配置递到连接。
 *
 * 两个都是可选的：`undefined` = 「按老路走」（地址读发现文件 `<AI_ZEN_DIR>/run/server.json`，
 * 凭证读 `<AI_ZEN_DIR>/run/token`）。取值、优先级与降级全在客户端的
 * `resolve-target.ts` 那一处（决策 D9），桌面端只负责把用户配置原样传下去。
 *
 * 这两个值的来源是**用户配置**（`ConnectionSettings`，落盘在 `<AI_ZEN_DIR>/desktop/
 * connection.json`），由 `connection/controller.ts` 的 `ConnectionController` 在每次建层时
 * 映射进来：`mode: "local"` 时两个都是 `undefined`（老路），`"remote"` 时才是用户填的那两个。
 *
 * 也**不**在这里读 `AI_ZEN_SERVER_URL` / `AI_ZEN_SERVER_TOKEN`：那两个环境变量属于 CLI
 * （决策 D11 与 D12），桌面端是双击启动的，进程环境里不会有它们 —— 假装支持，会让「用户设了
 * 却没生效」变成一条查不出来的死路。
 *
 * 凭证**绝不进日志**（包括「不拉起本机 server」那条）：地址是配置，凭证是钥匙。
 */
export interface ServerConnectionConfig {
  /** 显式地址（`ws:` / `wss:` / `http:` / `https:`）：给了就**只连、不拉起**本机 server（D10） */
  serverUrl?: string;
  /** 显式凭证；没给就退回 `<AI_ZEN_DIR>/run/token` */
  serverToken?: string;
}
