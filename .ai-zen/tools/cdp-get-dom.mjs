/**
 * CDP 工具：获取页面 DOM 结构
 *
 * 通过 CDP 获取目标页面的 DOM 树或特定元素的 HTML。
 * 支持使用 CSS 选择器获取特定元素，或获取完整页面 DOM。
 */
import { findTargetPage, evaluate, sendCdpCommand } from "./cdp-shared/index.mjs";

export default {
  function: {
    name: "cdp_get_dom",
    description: "获取 Electron 页面的 DOM 结构。支持获取完整 DOM 或使用 CSS 选择器提取特定元素。用于了解页面布局、组件结构、数据状态等。",
    parameters: {
      type: "object",
      properties: {
        selector: {
          type: "string",
          description: "CSS 选择器（可选）。指定则只返回匹配元素的外层 HTML；不指定则返回完整 body 的 HTML。例如：'.sidebar'、'#app'、'.chat-panel .messages'",
        },
        maxLength: {
          type: "number",
          description: "返回内容最大字符数，默认 5000，防止返回过大",
          default: 5000,
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
        useDocument: {
          type: "boolean",
          description: "是否使用 DOM.getDocument 获取完整 DOM 树（返回 JSON 结构）。默认 false，使用 innerHTML 返回 HTML 字符串。",
          default: false,
        },
      },
      required: [],
    },
  },

  /**
   * @param {{ selector?: string, maxLength?: number, title?: string, url?: string, index?: number, host?: string, port?: number, useDocument?: boolean }} args
   */
  exec: async function (args) {
    const {
      selector,
      maxLength = 5000,
      title,
      url,
      index,
      host = "127.0.0.1",
      port = Number(process.env.CDP_PORT) || 9222,
      useDocument = false,
    } = args || {};

    const page = await findTargetPage({ host, port, title, url, index });

    let result;

    if (useDocument) {
      // 使用 DOM.getDocument 获取完整 DOM 树（JSON 结构）
      result = await sendCdpCommand(page.webSocketDebuggerUrl, "DOM.getDocument", {
        depth: 4,
        pierce: true,
      });
      const formatted = JSON.stringify(result, null, 2);
      const preview = formatted.length > maxLength
        ? formatted.slice(0, maxLength) + `\n\n... (结果过长，已截断 ${maxLength} 字符)`
        : formatted;
      return [
        `🌳 DOM 树结构（页面: ${page.title || page.url}）`,
        ``,
        preview,
      ].join("\n");
    }

    // 使用 Runtime.evaluate 获取 HTML
    const expression = selector
      ? `(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return "【未找到】选择器 '${selector}' 没有匹配任何元素";
          return el.outerHTML;
        })()`
      : `document.body?.innerHTML || "(无 body)"`;

    const html = await evaluate(page.webSocketDebuggerUrl, expression);

    const preview = html.length > maxLength
      ? html.slice(0, maxLength) + `\n\n... (结果过长，已截断 ${maxLength} 字符)`
      : html;

    const desc = selector
      ? `选择器 '${selector}' 的 DOM`
      : "页面完整 body HTML";

    return [
      `🌳 ${desc}（页面: ${page.title || page.url}）`,
      `   长度: ${html.length} 字符`,
      ``,
      preview,
    ].join("\n");
  },
};
