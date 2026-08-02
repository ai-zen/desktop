import { defineConfig } from "rolldown";

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
    // SQLite worker：独立线程持有 DatabaseSync，主线程经消息异步调用
    input: "src/storage/dbWorker.ts",
    output: {
      format: "esm",
      file: "dist/dbWorker.mjs",
      sourcemap: true,
    },
    platform: "node",
    external: ["node:sqlite", "node:worker_threads", "node:path", "node:fs"],
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
]);
