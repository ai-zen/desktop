/**
 * CDP 工具：获取页面 CSS 变量
 *
 * 通过 CDP 获取页面根元素（:root）上定义的 CSS 自定义属性值。
 * 可按前缀筛选，方便查看 Element Plus 主题变量或自定义设计令牌。
 */
import { findTargetPage, evaluate } from "./cdp-shared/index.mjs";

export default {
  function: {
    name: "cdp_get_css_vars",
    description: "获取 Electron 页面的 CSS 自定义属性（CSS 变量）值。可指定前缀筛选（如 '--el-' 查看 Element Plus 变量，'--color' 查看颜色变量）。用于调试主题、样式问题。",
    parameters: {
      type: "object",
      properties: {
        prefix: {
          type: "string",
          description: "CSS 变量前缀筛选（可选）。例如 '--el-' 只显示 Element Plus 变量，'--color' 只显示颜色相关变量。不指定则显示所有变量。",
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
          description: "CDP 调试端口，默认 9222（可用环境变量 CDP_PORT 覆盖）",
          default: Number(process.env.CDP_PORT) || 9222,
        },
        sortBy: {
          type: "string",
          description: "排序方式：'name'（按变量名）或 'value'（按值），默认 'name'",
          enum: ["name", "value"],
          default: "name",
        },
      },
      required: [],
    },
  },

  /**
   * @param {{ prefix?: string, title?: string, url?: string, index?: number, host?: string, port?: number, sortBy?: string }} args
   */
  exec: async function (args) {
    const {
      prefix,
      title,
      url,
      index,
      host = "127.0.0.1",
      port = Number(process.env.CDP_PORT) || 9222,
      sortBy = "name",
    } = args || {};

    const page = await findTargetPage({ host, port, title, url, index });

    const expression = `
      (() => {
        const s = getComputedStyle(document.documentElement);
        const vars = {};
        // 遍历所有 CSS 变量
        for (let i = 0; i < s.length; i++) {
          const name = s[i];
          if (name.startsWith('--')) {
            vars[name] = s.getPropertyValue(name).trim();
          }
        }
        return vars;
      })()
    `;

    const vars = await evaluate(page.webSocketDebuggerUrl, expression);

    if (!vars || Object.keys(vars).length === 0) {
      return "⚠️ 页面上没有找到任何 CSS 变量。";
    }

    // 按前缀筛选
    let entries = Object.entries(vars);
    if (prefix) {
      entries = entries.filter(([name]) => name.startsWith(prefix));
    }

    if (entries.length === 0) {
      return `⚠️ 没有找到前缀为 '${prefix}' 的 CSS 变量。`;
    }

    // 排序
    if (sortBy === "name") {
      entries.sort((a, b) => a[0].localeCompare(b[0]));
    } else {
      entries.sort((a, b) => a[1].localeCompare(b[1]));
    }

    const lines = entries.map(([name, value]) => {
      const displayValue = value.length > 60 ? value.slice(0, 60) + "..." : value;
      return `  ${name}: ${displayValue}`;
    });

    const prefixInfo = prefix ? ` (前缀: '${prefix}')` : "";

    return [
      `🎨 CSS 变量${prefixInfo}（页面: ${page.title || page.url}）`,
      `   共 ${entries.length} 个变量`,
      ``,
      ...lines,
    ].join("\n");
  },
};
