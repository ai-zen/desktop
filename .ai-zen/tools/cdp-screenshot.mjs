/**
 * CDP 工具：页面截图
 *
 * 通过 CDP 对目标页面进行截图，保存为 PNG 文件并返回文件路径。
 */
import { findTargetPage, captureScreenshot } from "./cdp-shared/index.mjs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

export default {
  function: {
    name: "cdp_screenshot",
    description: "对 Electron 页面进行截图，保存为 PNG 文件并返回文件路径。用于查看页面当前视觉效果、布局、UI 状态等。",
    parameters: {
      type: "object",
      properties: {
        output: {
          type: "string",
          description: "截图保存路径（可选，默认保存到临时目录并返回路径）",
        },
        title: {
          type: "string",
          description: "按页面标题模糊匹配目标页面（可选）",
        },
        url: {
          type: "string",
          description: "按页面 URL 模糊匹配目标页面（可选）",
        },
        index: {
          type: "number",
          description: "按索引选择目标页面（可选，默认 0）",
        },
        host: {
          type: "string",
          description: "CDP 主机地址，默认 127.0.0.1",
          default: "127.0.0.1",
        },
        port: {
          type: "number",
          description: "CDP 调试端口，默认 9222",
          default: 9222,
        },
        format: {
          type: "string",
          description: "图片格式，'png' 或 'jpeg'，默认 'png'",
          enum: ["png", "jpeg"],
          default: "png",
        },
      },
      required: [],
    },
  },

  /**
   * @param {{ output?: string, title?: string, url?: string, index?: number, host?: string, port?: number, format?: string }} args
   */
  exec: async function (args) {
    const {
      output,
      title,
      url,
      index,
      host = "127.0.0.1",
      port = 9222,
      format = "png",
    } = args || {};

    const page = await findTargetPage({ host, port, title, url, index });

    const base64Data = await captureScreenshot(page.webSocketDebuggerUrl, format);

    // 确定保存路径
    let outputPath = output;
    if (!outputPath) {
      const { mkdtempSync } = await import("node:fs");
      const { tmpdir } = await import("node:os");
      const tmpDir = mkdtempSync(join(tmpdir(), "ai-zen-cdp-"));
      const timestamp = Date.now();
      outputPath = join(tmpDir, `screenshot-${timestamp}.${format}`);
    }

    const buffer = Buffer.from(base64Data, "base64");
    await writeFile(outputPath, buffer);

    return [
      `📸 截图成功！`,
      ``,
      `   页面: ${page.title || page.url}`,
      `   格式: ${format.toUpperCase()}`,
      `   大小: ${(buffer.length / 1024).toFixed(1)} KB`,
      `   路径: ${outputPath}`,
      ``,
      `💡 可以使用 readFile 工具查看此图片，或直接打开文件。`,
    ].join("\n");
  },
};
