import { defineConfig } from "vitest/config";

/**
 * 与 agents 仓的 `server` / `client` / `protocol` 同口径：**保持默认隔离**（每个用例自己起
 * 一个真 Daemon + 一个临时目录）。
 *
 * 只收 `src` 下的 `*.test.ts`：这一层的验收手段就是「真 daemon 驱动」，用例文件贴着被测
 * 模块放（`src/server/*.test.ts`），不做单独的 test 目录 —— 改了哪块，旁边就有它的用例。
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
});
