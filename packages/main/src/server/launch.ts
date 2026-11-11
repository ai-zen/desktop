/**
 * 拉起**随包分发**的服务端。
 *
 * ## 为什么桌面端不用 `npx`
 *
 * CLI 那边用 `npx -y @ai-zen/agents-server@…` 现下现起，前提是那台机器有 Node.js 和 npm。
 * 桌面端的客户机不保证有 —— 所以 `rolldown.config.mjs` 把服务端（连同 core / sdk /
 * openai / MCP SDK）打成一个自包含的 `dist/server.mjs`，这里用 **Electron 自带的 Node**
 * 把它跑起来：不需要系统装任何东西。
 *
 * ## 为什么优先用「系统里已经跑着的」
 *
 * 这件事**不在本文件**：`ensureServer` 先读发现文件（`<aiZenDir>/run/server.json`）、
 * `ping` 一次，通了就直接连过去。拉进程只发生在「没有活着的服务端」时。所以本文件是
 * `startServerProcess` 这个注入点的实现，不是「启动策略」本身。
 *
 * ## `ELECTRON_RUN_AS_NODE`
 *
 * `process.execPath` 在 Electron 里指向的是**应用**，不是 node。这个环境变量让它退化成
 * 普通 Node 解释器 —— 于是同一份二进制既能跑应用也能跑服务端，不必随包再带一个 Node。
 */

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 随包分发的服务端入口 —— 与 `main.mjs` 同级（见 `rolldown.config.mjs` 的 `server` 入口）。
 *
 * `import.meta.url` 在**打包后**指向 `dist/main.mjs`，本模块已被内联进去；打进 asar 时
 * 它变成 `…/app.asar/dist/main.mjs`，`join` 出来的路径同样可用（Electron 的 fs 认 asar）。
 */
const SERVER_ENTRY = join(dirname(fileURLToPath(import.meta.url)), "server.mjs");

/** 拉一个 detached 的服务端进程；与 client 包里 `npx` 那份同签名 */
export async function startBundledServer({ aiZenDir }: { aiZenDir: string }): Promise<void> {
  const child = spawn(process.execPath, [SERVER_ENTRY, "serve", "--ai-zen-dir", aiZenDir], {
    detached: true,
    // 服务端自己写 `<aiZenDir>/logs/server.log`，绝不能把输出混进 Electron 的 stdout
    stdio: "ignore",
    env: {
      ...process.env,
      AI_ZEN_DIR: aiZenDir,
      ELECTRON_RUN_AS_NODE: "1",
    },
  });

  // 等 `spawn` 事件而不是直接返回：入口文件缺失这类错误当场报，不用等满 10s 探活超时
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", () => resolve());
    child.once("error", reject);
  });
  child.unref();
}
