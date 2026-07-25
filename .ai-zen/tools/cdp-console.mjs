/**
 * CDP 工具：监听页面控制台日志
 *
 * 通过 CDP 连接监听目标页面的 console 输出、异常等信息。
 * 用于调试 JavaScript 错误、查看应用日志、监控运行时状态。
 */
import { findTargetPage, observeConsole } from "./cdp-shared/index.mjs";

export default {
  function: {
    name: "cdp_console",
    description: "监听 Electron 页面的控制台输出（console.log/warn/error、JS 异常等）。用于调试 JavaScript 错误、查看应用运行时日志。可指定监听时长和日志级别过滤。",
    parameters: {
      type: "object",
      properties: {
        duration: {
          type: "number",
          description: "监听时长（毫秒），默认 3000（3 秒）。建议 2000-10000 之间",
          default: 3000,
        },
        level: {
          type: "string",
          description: "按级别过滤：'all'（全部）、'error'（仅错误）、'warn'（警告+错误）、'info'（信息+警告+错误）。默认 'all'",
          enum: ["all", "error", "warn", "info"],
          default: "all",
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
      },
      required: [],
    },
  },

  /**
   * @param {{ duration?: number, level?: string, title?: string, url?: string, index?: number, host?: string, port?: number }} args
   */
  exec: async function (args) {
    const {
      duration = 3000,
      level = "all",
      title,
      url,
      index,
      host = "127.0.0.1",
      port = 9222,
    } = args || {};

    const page = await findTargetPage({ host, port, title, url, index });

    const logs = await observeConsole(page.webSocketDebuggerUrl, duration);

    if (logs.length === 0) {
      return `📭 监听 ${duration}ms 内没有捕获到控制台输出（页面: ${page.title || page.url}）。`;
    }

    // 按级别过滤
    let filtered = logs;
    if (level === "error") {
      filtered = logs.filter((l) => l.level === "error");
    } else if (level === "warn") {
      filtered = logs.filter((l) => ["warn", "error"].includes(l.level));
    } else if (level === "info") {
      filtered = logs.filter((l) => ["info", "log", "warn", "error"].includes(l.level));
    }

    if (filtered.length === 0) {
      return `📭 在 ${logs.length} 条日志中，没有匹配级别 '${level}' 的日志。`;
    }

    const levelLabels = {
      log: "📝",
      info: "ℹ️ ",
      warn: "⚠️ ",
      error: "❌",
      debug: "🔍",
    };

    const lines = filtered.map((l, i) => {
      const icon = levelLabels[l.level] || "📝";
      const location = l.url ? ` (${l.url}${l.line != null ? `:${l.line}` : ""})` : "";
      return `  [${i + 1}] ${icon} [${l.level.toUpperCase()}]${location}\n       ${l.text}`;
    });

    const summary = logs.length > filtered.length
      ? `（共捕获 ${logs.length} 条，显示 ${filtered.length} 条）`
      : `（共 ${logs.length} 条）`;

    return [
      `📋 控制台日志 ${summary}`,
      `   页面: ${page.title || page.url}`,
      `   监听时长: ${duration}ms`,
      ``,
      ...lines,
    ].join("\n");
  },
};
