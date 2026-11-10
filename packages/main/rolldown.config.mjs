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
