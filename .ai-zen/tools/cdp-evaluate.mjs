/**
 * CDP 工具：在页面中执行 JavaScript 代码
 *
 * 通过 CDP WebSocket 连接在目标页面上执行任意 JS 表达式，
 * 并返回执行结果。可用于检查应用状态、调用函数、获取数据等。
 */
import { findTargetPage, evaluate } from "./cdp-shared/index.mjs";

export default {
  function: {
    name: "cdp_evaluate",
    description: "在 Electron 页面上执行 JavaScript 代码并返回结果。可用于获取应用状态、调用组件方法、检查数据等。",
    parameters: {
      type: "object",
      properties: {
        expression: {
          type: "string",
          description: "要执行的 JavaScript 表达式或代码。例如：'document.title'、'JSON.stringify(window.__APP_STATE__)'、'document.querySelector(\".sidebar\").outerHTML'",
        },
        title: {
          type: "string",
          description: "按页面标题模糊匹配目标页面（可选，默认选择第一个非 DevTools 页面）",
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
        timeout: {
          type: "number",
          description: "超时时间（毫秒），默认 10000",
          default: 10000,
        },
      },
      required: ["expression"],
    },
  },

  /**
   * @param {{ expression: string, title?: string, url?: string, index?: number, host?: string, port?: number, timeout?: number }} args
   */
  exec: async function (args) {
    const {
      expression,
      title,
      url,
      index,
      host = "127.0.0.1",
      port = 9222,
      timeout = 10000,
    } = args || {};

    if (!expression) {
      throw new Error("缺少必要参数 expression");
    }

    const page = await findTargetPage({ host, port, title, url, index });

    let result;
    try {
      result = await evaluate(page.webSocketDebuggerUrl, expression, true, timeout);
    } catch (err) {
      return `❌ 执行失败: ${err.message}`;
    }

    // 格式化输出
    const formatted = typeof result === "object"
      ? JSON.stringify(result, null, 2)
      : String(result);

    const preview = formatted.length > 2000
      ? formatted.slice(0, 2000) + "\n\n... (结果过长，已截断 2000 字符)"
      : formatted;

    return [
      `✅ 执行成功（页面: ${page.title || page.url}）`,
      ``,
      `📤 表达式:`,
      `  ${expression}`,
      ``,
      `📥 结果:`,
      `  ${preview}`,
    ].join("\n");
  },
};
