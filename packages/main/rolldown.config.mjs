import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
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
  return { entry: join(dirname(packageJsonPath), bin["agents-server"]), version };
}

const server = serverPackage();

export default defineConfig([
  {
    /**
     * 主进程：**只有 electron 是外部**，`@ai-zen/{agents-core,agents-sdk,desktop-shared}` 全部内联。
     *
     * 分发形态决定这一条：打包后的应用里没有 `node_modules`（`electron-builder.yml` 的 `files`
     * 只放 `dist/**`），asar 里的模块解析不走 pnpm 那套符号链接；而这三个包在本仓是 `link:`
     * 到隔壁 `agents` 仓的**相对路径**，让打包器沿着真实路径去收，等于把另一个 git 仓的目录
     * 结构焊进产物。内联之后 `dist/main.mjs` 除了 `electron` 什么都不用解析 —— 少一类「装机后
     * 才炸」的失败。代价只是一份静态代码，没有运行时开销。
     *
     * 服务端入口（下面第三个）本来就是全内联，两边口径一致。
     */
    input: "src/main.ts",
    output: {
      format: "esm",
      file: "dist/main.mjs",
      sourcemap: true,
    },
    platform: "node",
    external: ["electron"],
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
     * `@ai-zen/agents-{core,sdk,server}`、`openai`、MCP SDK、`dayjs`、**`ws`** 全部内联。
     *
     * `ws` 是服务端换 WebSocket 之后**新增的运行期依赖**（`agents/packages/server` 的
     * `dependencies`）。它必须走这条内联：客户机上没有 `node_modules`，一经外置就是
     * 「装机后第一次连服务端才炸」。它内部那两处 `require("bufferutil")` /
     * `require("utf-8-validate")` 是**可选的原生加速件**，各自包在 `try/catch` 里，
     * 打进来之后照旧是「没有就不用」—— 不是外置依赖。
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
]);
