import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * 与 agents 仓的 sdk / host / client 同口径：`isolate: false`，同进程内复用模块图。
 * 每个用例自己搭自己的假件（`src/host/*.test.ts` 里的假连接 + 计数器），不靠「新进程」隔离。
 *
 * 只收 `src` 下的 `*.test.ts`：这一层的验收手段是「假连接 + 计数器」，用例文件贴着被测模块放
 * （`src/host/*.test.ts`），不做单独的 test 目录 —— 改了哪块，旁边就有它的用例。
 *
 * ## 为什么要一条别名
 *
 * `@ai-zen/agents-client` 是隔壁仓里那份**私有、不发版**的客户端库（R69）：它的 `package.json` 只有
 * `types`，没有 `main` / `exports` —— 它是被各宿主**捆进自己产物**的，不是给 Node 直接 resolve 的。
 * 所以运行期这一条边必须指到它的 TS 源文件（rolldown 那边是同一套别名，见 `rolldown.config.mjs`）。
 * tsconfig 的 `paths` 指的是同一个文件，三处一致。
 */
const CLIENT_ENTRY = fileURLToPath(
  new URL("../../../agents/packages/client/src/index.ts", import.meta.url),
);

export default defineConfig({
  resolve: {
    alias: { "@ai-zen/agents-client": CLIENT_ENTRY },
  },
  test: {
    include: ["src/**/*.test.ts"],
    isolate: false,
  },
});
