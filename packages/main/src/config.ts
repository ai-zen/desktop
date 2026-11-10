/**
 * main 的路径常量 —— 只剩一个：`AI_ZEN_DIR`。
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
