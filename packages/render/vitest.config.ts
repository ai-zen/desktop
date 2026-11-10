import { defineConfig } from "vitest/config";

/**
 * render 侧的**最小**测试环境：只测纯逻辑（`src/stores/agentView.ts` 这类零运行时依赖的
 * 模块），不渲染组件、不跑 DOM —— 那需要 jsdom + @vue/test-utils，属于另一笔投入。
 *
 * 与 main 同口径：用例文件贴着被测模块放（`src/**\/*.test.ts`），不做单独的 test 目录。
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
});
