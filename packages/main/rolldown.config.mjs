import { defineConfig } from "rolldown";

export default defineConfig([
  {
    input: "src/main.ts",
    output: {
      format: "esm",
      file: "dist/main.mjs",
    },
    platform: "node",
    external: ["electron", "@ai-zen/agents-sdk", "@ai-zen/desktop-shared"],
  },
  {
    input: "src/preload.ts",
    output: {
      format: "iife",
      file: "dist/preload.js",
      globals: {
        "electron/renderer": "electron_renderer",
      },
    },
    platform: "browser",
    external: ["electron", "electron/renderer"],
  },
]);
