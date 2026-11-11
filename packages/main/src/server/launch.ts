/**
 * 拉起**随包分发**的服务端；配置里给了显式地址时**一次都不拉**（D10）。
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
 * ## 显式地址 ⇒ 不拉起（D10）
 *
 * 本机拉起来的一定不在那个地址上，拉起只会白等满 `ensureServer` 的 10 秒，然后报一个
 * **指向错误方向**的超时（用户以为是「远端那台起不来」，其实是「本机根本没有它的进程」）。
 *
 * 这件事在客户端包里已经成立一次（`ensureServer` 走显式那条路时压根不会调用本函数），
 * 这里再挡一次并**留下一条可观测的日志**：跳过拉起这件事只体现在「什么都没发生」上，
 * 而「什么都没发生」在故障排查时是最贵的证据。日志里只许出现**地址**，永远不许出现
 * 凭证（D4：凭证不进任何会被 `cat` 出去的东西）。
 *
 * ## `ELECTRON_RUN_AS_NODE`
 *
 * `process.execPath` 在 Electron 里指向的是**应用**，不是 node。这个环境变量让它退化成
 * 普通 Node 解释器 —— 于是同一份二进制既能跑应用也能跑服务端，不必随包再带一个 Node。
 */

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerConnectionConfig } from "../config.js";

/**
 * 随包分发的服务端入口 —— 与 `main.mjs` 同级（见 `rolldown.config.mjs` 的 `server` 入口）。
 *
 * `import.meta.url` 在**打包后**指向 `dist/main.mjs`，本模块已被内联进去；打进 asar 时
 * 它变成 `…/app.asar/dist/main.mjs`，`join` 出来的路径同样可用（Electron 的 fs 认 asar）。
 */
const SERVER_ENTRY = join(dirname(fileURLToPath(import.meta.url)), "server.mjs");

/** 拉一个 detached 的服务端进程；与 client 包里 `npx` 那份同签名 */
export async function spawnBundledServer({
  aiZenDir,
}: {
  aiZenDir: string;
}): Promise<void> {
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

/**
 * 造一个 `startServerProcess`（`ServerConnection` 那个注入点的形状）。
 *
 * 三个参数全是为了「可观测」：
 *
 *   - `config` —— 组装根手上那份配置原样递进来（`config.ts` 的 `SERVER_CONFIG`）。本函数**只读
 *     `serverUrl`**：凭证在这里没有任何用途，于是它也不可能被写进日志（用例钉着这一条）；
 *   - `spawn` —— 真正的拉进程动作，用例注入一个计数器，「跳过拉起」才有判据（否则它只
 *     表现为「什么都没发生」）；
 *   - `log` —— 日志出口（桌面端没接日志文件之前就是 `console.info`，与 `Electron` 的主进程
 *     输出走同一条流）。
 *
 * 语义：配置里有地址 → 打一条日志、**不拉起**；没有 → 照旧拉起随包分发的那份。
 */
export function createStartBundledServer(
  options: {
    config?: ServerConnectionConfig;
    spawn?: (deps: { aiZenDir: string }) => Promise<void>;
    log?: (message: string) => void;
  } = {},
): (deps: { aiZenDir: string }) => Promise<void> {
  const spawnServer = options.spawn ?? spawnBundledServer;
  const log = options.log ?? ((message: string) => console.info(message));

  return async ({ aiZenDir }) => {
    const serverUrl = options.config?.serverUrl;
    if (serverUrl) {
      // D10：连的是配置里那台，本机这一份与它无关。日志只说地址（凭证一个字都不带）。
      log(`连的是配置里的服务端 ${serverUrl}，不拉起本机 server`);
      return;
    }
    await spawnServer({ aiZenDir });
  };
}
