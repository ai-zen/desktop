import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { resolve } from "path";

export default defineConfig({
  plugins: [vue()],
  base: "./",
  root: ".",
  build: {
    outDir: "../main/dist/static",
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
});
