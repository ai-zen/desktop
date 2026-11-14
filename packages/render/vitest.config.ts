import { defineConfig } from "vitest/config";

/**
 * render 侧的**最小**测试环境：只测纯逻辑与 store 规则（`src/stores/agentView.ts`、
 * `src/stores/chat.ts` 的子 Agent 部分），不渲染组件、不跑 DOM —— 那需要 jsdom +
 * @vue/test-utils，属于另一笔投入。
 *
 * 与 main、agents 仓的 sdk / host / client 同口径：`isolate: false`，同进程内复用模块图。
 * 换掉「外面那一层」不再走 `vi.mock`（它按模块说明符**进程级**注册替身，共享模块图时会串到
 * 下一个文件），改成往 `src/deps.ts` 里注入 —— 用例自己 `stubDeps()` / `resetDeps()` 收放。
 *
 * 用例文件贴着被测模块放（`src/**\/*.test.ts`），不做单独的 test 目录。
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    isolate: false,
  },
});
