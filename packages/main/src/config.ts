/**
 * main 的配置面 —— 一个路径常量（`AI_ZEN_DIR`），仅此一个。
 *
 * ## 为什么只需要根目录
 *
 * 桌面端是瘦客户端：会话执行、助手定义、模型配置、对话历史全在常驻的 `agents-server` 那边，本进程
 * 不读写那里的任何数据文件。它需要的路径事实是**ai-zen 的数据根在哪**，然后整根递给 `server/` 那一
 * 层（`createServerLayer({ aiZenDir })`），由客户端库的 `ensureServer` 去做服务发现
 * （`<数据根>/run/server.json`）与按需拉起 —— 根目录下面有什么（库、assets、agents/）是**服务端的
 * 事实**，客户端不解释它。
 *
 * ## 唯一的例外：连接设置
 *
 * `<AI_ZEN_DIR>/desktop/connection.json` 的路径也不在本文件拼 —— 唯一实现处是
 * `connection/settings.ts`。它必须落在**本机**而不是服务端，理由是**先有鸡先有蛋**：服务端手上有
 * 「该连哪儿」的全部业务配置，可要问它，得先知道**连哪台**；把「连哪台」也存到服务端，就等于要求
 * 用户先连上服务端才能选服务端。
 *
 * 除这一处，本进程不新增任何往本地写数据的入口 —— 有意的例外，不是松绑。
 *
 * 环境变量 `AI_ZEN_DIR` 优先：用例与多实例都要指向不同目录，那不该改代码。
 */

import { app } from "electron";
import { join } from "path";

export const AI_ZEN_DIR = process.env.AI_ZEN_DIR || join(app.getPath("home"), ".ai-zen");
