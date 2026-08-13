/**
 * CDP 工具：列出所有可调试页面
 *
 * 连接到 Electron 的远程调试端口，获取所有可调试页面的信息。
 * 默认连接 127.0.0.1:9222。
 */
export default {
  function: {
    name: "cdp_list_pages",
    description: "连接到 Electron CDP 调试端口，列出所有可调试页面（WebSocket URL、标题、URL 等）。用于获取页面 ID 以便后续调试。",
    parameters: {
      type: "object",
      properties: {
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
        filterDevtools: {
          type: "boolean",
          description: "是否过滤掉 DevTools 内部页面，默认 true",
          default: true,
        },
      },
      required: [],
    },
  },

  /**
   * @param {{ host?: string, port?: number, filterDevtools?: boolean }} args
   */
  exec: async function (args) {
    const { host = "127.0.0.1", port = Number(process.env.CDP_PORT) || 9222, filterDevtools = true } = args || {};

    const url = `http://${host}:${port}/json`;
    let res;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    } catch (err) {
      if (err?.name === "TimeoutError" || err?.name === "AbortError") {
        throw new Error(
          `CDP HTTP 请求超时 (5000ms): ${url}。请确认 Electron 已以 --remote-debugging-port=${port} 启动且端口未被其他进程占用。`
        );
      }
      throw err;
    }

    if (!res.ok) {
      throw new Error(`CDP HTTP 请求失败: ${res.status} ${res.statusText}。请确认 Electron 已以 --remote-debugging-port=${port} 启动。`);
    }

    let pages = await res.json();

    if (filterDevtools) {
      pages = pages.filter((p) => !p.url?.startsWith("devtools://"));
    }

    if (pages.length === 0) {
      return "当前没有可调试的页面。请确认 Electron 应用已启动（pnpm start）。";
    }

    const lines = pages.map((p, i) => {
      return [
        `  [${i}] ${p.title || "(无标题)"}`,
        `        URL: ${p.url}`,
        `        WebSocket: ${p.webSocketDebuggerUrl}`,
        `        ID: ${p.id}`,
        `        DevTools: ${p.devtoolsFrontendUrl}`,
      ].join("\n");
    });

    return [
      `📄 共找到 ${pages.length} 个可调试页面：`,
      ...lines,
      "",
      `💡 提示：使用页面索引 [0]、页面标题或 URL 来指定目标页面。`,
    ].join("\n");
  },
};
