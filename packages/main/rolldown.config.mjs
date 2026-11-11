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
    input: "src/main.ts",
    output: {
      format: "esm",
      file: "dist/main.mjs",
      sourcemap: true,
    },
    platform: "node",
    external: ["electron", "@ai-zen/agents-core", "@ai-zen/agents-sdk", "@ai-zen/desktop-shared"],
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
     * `@ai-zen/agents-{core,sdk,server}`、`openai`、MCP SDK、`dayjs` 全部内联。
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
