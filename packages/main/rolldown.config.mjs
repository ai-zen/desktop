import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { defineConfig } from "rolldown";

const require = createRequire(import.meta.url);

/**
 * `@ai-zen/agents-server` 的 bin 入口与版本 —— 从它自己的 `package.json` 读。
 *
 * 不写死 `dist/cli.js`：dist 布局是服务端的实现细节，写死等于把两个仓的目录结构焊在一起。
 */
function serverPackage() {
  const packageJsonPath = require.resolve("@ai-zen/agents-server/package.json");
  const { bin, version } = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
  const root = dirname(packageJsonPath);
  return {
    entry: join(root, bin["agents-server"]),
    // SQLite 跑在一个 worker 线程里（`storage/Database.ts`），worker 入口是**另一个文件**：
    // 服务端自己按 `import.meta.url` 去找 `./dbWorker.js`。打成一个文件时它找不到 —— 于是本机
    // 服务端能起来却在开库那一刻死（“Cannot find module …/dbWorker.js”）。所以它也得是一个产物。
    workerEntry: join(root, "src", "storage", "dbWorker.ts"),
    version,
  };
}

const server = serverPackage();

/**
 * 客户端库（`@ai-zen/agents-client`）的**源文件入口**。
 *
 * 它是隔壁仓里那份 `private: true`、**不发版**的连接层（R69）。指到 `src/index.ts` 而不是它的
 * `dist`：那个包的 `package.json` 里只有 `types`、没有 `main` / `exports`（它就是给各宿主捆进自己
 * 产物的，不是给 Node 直接 resolve 的），而且指源码意味着**不必先把它 build 一遍**，也不会出现
 * 「类型来自 dist、运行期来自 src」那种各说各话。同样的路径在 `tsconfig.json` 的 `paths` 与
 * `vitest.config.ts` 的 alias 里各有一份，三处指向同一个文件。
 */
const CLIENT_ENTRY = fileURLToPath(
  new URL("../../../agents/packages/client/src/index.ts", import.meta.url),
);

export default defineConfig([
  {
    /**
     * 主进程：**只有 electron 与 Node 内建模块是外部**，
     * `@ai-zen/{agents-client,agents-core,desktop-shared}` 全部内联。
     *
     * 分发形态决定这一条：打包后的应用里没有 `node_modules`（`electron-builder.yml` 的 `files`
     * 只放 `dist/**`），asar 里的模块解析不走 pnpm 那套符号链接；而这几个包在本仓是 `link:` /
     * `file:` 到隔壁 `agents` 仓的**相对路径**，让打包器沿着真实路径去收，等于把另一个 git 仓的
     * 目录结构焊进产物。内联之后 `dist/main.mjs` 除了 `electron` 与 `node:*` 什么都不用解析 ——
     * 少一类「装机后才炸」的失败。代价只是一份静态代码，没有运行时开销。
     *
     * `@ai-zen/agents-client` 走 `resolve.alias` 指到源码（见上面 `CLIENT_ENTRY`）：它是
     * **私有、不发版**的共享代码（R69），产物里不许留下任何「去 node_modules 里找它」的路径 ——
     * 这一条由 `scripts/check-inlined.mjs` 在构建之后钉住。
     */
    input: "src/main.ts",
    output: {
      format: "esm",
      file: "dist/main.mjs",
      sourcemap: true,
    },
    platform: "node",
    // `node:*` 由 rolldown 在 `platform: "node"` 下自动外置，不必手写一份内建模块清单
    external: ["electron"],
    resolve: {
      alias: { "@ai-zen/agents-client": CLIENT_ENTRY },
    },
  },
  {
    input: "src/preload.ts",
    output: {
      format: "cjs",
      file: "dist/preload.js",
      sourcemap: true,
    },
    platform: "browser",
    external: ["electron", "electron/renderer"],
  },
  {
    /**
     * 服务端：**自包含**一份打进来。
     *
     * 桌面端是唯一能替用户「准备好服务端」的形态 —— 客户机上可能连 Node.js 和 npm 都没有
     * （CLI 那边用 `npx` 现下现起，这里没有那个奢侈）。所以 `external` 一个都不给：
     * `@ai-zen/agents-{core,sdk,server}`、`openai`、MCP SDK、`dayjs`、`ws` 全部内联。
     *
     * `ws` 是服务端换 WebSocket 之后的运行期依赖（`agents/packages/server` 的 `dependencies`）。
     * 它必须走这条内联：客户机上没有 `node_modules`，一经外置就是「装机后第一次连服务端才炸」。
     * 它内部那两处 `require("bufferutil")` / `require("utf-8-validate")` 是**可选的原生加速件**，
     * 各自包在 `try/catch` 里，打进来之后照旧是「没有就不用」—— 不是外置依赖。
     *
     * 代价是体积（几十 MB 量级），而 Electron 应用本来就按这个量级分发。
     */
    input: { server: server.entry },
    output: {
      format: "esm",
      file: "dist/server.mjs",
      sourcemap: true,
    },
    platform: "node",
    // 打包后服务端读不回自己的 `package.json`（那时的 `../package.json` 是**宿主的**），
    // 版本在这里定死
    transform: { define: { __SERVER_VERSION__: JSON.stringify(server.version) } },
    treeshake: { moduleSideEffects: false },
  },
  {
    /**
     * 服务端的 SQLite worker：与 `server.mjs` 同级的一个独立产物（`dist/dbWorker.js`）。
     *
     * 服务端在 `storage/Database.ts` 里按「自己这个模块所在目录 + `./dbWorker.js`」找它，所以
     * 文件名与位置都不能变。不产它，装机后的第一次开库就是这个死法：
     * `Cannot find module '<asar>/dist/dbWorker.js'`。
     */
    input: { dbWorker: server.workerEntry },
    output: {
      format: "esm",
      file: "dist/dbWorker.js",
      sourcemap: true,
    },
    platform: "node",
    treeshake: { moduleSideEffects: false },
  },
]);
