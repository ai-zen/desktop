/**
 * 拉起**随包分发**的服务端（`dist/server.mjs`）。
 *
 * ## 为什么桌面端不用 `npx`
 *
 * CLI 那边用 `npx -y @ai-zen/agents-server@…` 现下现起，前提是那台机器有 Node.js 和 npm。桌面端的
 * 客户机不保证有 —— 所以 `rolldown.config.mjs` 把服务端（连同 core / sdk / openai / MCP SDK / ws）
 * 打成一个自包含的 `dist/server.mjs`，这里用 **Electron 自带的 Node** 把它跑起来。
 *
 * ## 什么时候会被调到
 *
 * **只在「本机、且发现文件里没有活着的实例」时**。客户端库的 `ensureServer` 是这件事的唯一判据：
 * 显式地址那一条路它压根不会调用这个函数（本机拉起来的一定不在那个地址上，拉起只会白等一个指向
 * 错误方向的超时），本机那一条路先读 `<数据根>/run/server.json` 并试着握手，通了就直接连。
 *
 * ## `ELECTRON_RUN_AS_NODE`
 *
 * `process.execPath` 在 Electron 里指向的是**应用**，不是 node。这个环境变量让它退化成普通 Node
 * 解释器 —— 于是同一份二进制既能跑应用也能跑服务端，不必随包再带一个 Node。
 */

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 随包分发的服务端入口 —— 与 `main.mjs` 同级（见 `rolldown.config.mjs` 的 `server` 入口）。
 *
 * `import.meta.url` 在**打包后**指向 `dist/main.mjs`，本模块已被内联进去；打进 asar 时它变成
 * `…/app.asar/dist/main.mjs`，`join` 出来的路径同样可用（Electron 的 fs 认 asar）。
 */
export const SERVER_ENTRY = join(dirname(fileURLToPath(import.meta.url)), "server.mjs");

/** `ensureServer` 的 `spawnServer` 注入点形状（`{ dataRoot, entry }`，来自客户端库） */
export interface SpawnServerContext {
  /** 数据根（`AI_ZEN_DIR`）：服务端把库、素材、发现文件都放在它下面 */
  dataRoot: string;
  /** 服务端入口（我们给的是 {@link SERVER_ENTRY}） */
  entry: string;
}

/**
 * 拉一个 detached 的服务端进程。
 *
 * `stdio: "ignore"`：服务端自己写 `<数据根>/logs/server.log`，绝不能把输出混进 Electron 的 stdout。
 * 等 `spawn` 事件而不是直接返回：入口文件缺失这类错误当场报，不用等满 `ensureServer` 的启动时限。
 * 凭证**不进命令行** —— 那一串会进 `ps` 输出；本地实例的凭证由服务端自己生成并写 `run/token`。
 */
export async function spawnBundledServer(context: SpawnServerContext): Promise<void> {
  const child = spawn(
    process.execPath,
    [context.entry, "serve", "--ai-zen-dir", context.dataRoot],
    {
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        AI_ZEN_DIR: context.dataRoot,
        ELECTRON_RUN_AS_NODE: "1",
      },
    },
  );

  await new Promise<void>((resolve, reject) => {
    child.once("spawn", () => resolve());
    child.once("error", reject);
  });
  child.unref();
}
