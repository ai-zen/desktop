/**
 * CDP 连接共享辅助模块
 *
 * 提供 Chrome DevTools Protocol 的通用连接和调用能力。
 * 以下划线开头，不会被 discoverUserTools 识别为工具。
 *
 * Node.js ≥ 21 内置 globalThis.WebSocket 和 fetch，无需安装任何依赖。
 */

const DEFAULT_HOST = "127.0.0.1";
// CDP 端口：默认 9222，可通过环境变量 CDP_PORT 覆盖
const DEFAULT_PORT = Number(process.env.CDP_PORT) || 9222;

/**
 * 通过 HTTP 获取所有可调试页面列表
 * GET http://host:port/json
 *
 * @param {string} [host]   - CDP 主机地址
 * @param {number} [port]   - CDP 调试端口
 * @param {number} [timeout=5000] - 请求超时毫秒数，防止端口被占用/挂起时无限等待
 */
export async function listPages(host = DEFAULT_HOST, port = DEFAULT_PORT, timeout = 5000) {
  const url = `http://${host}:${port}/json`;
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(timeout) });
  } catch (err) {
    if (err?.name === "TimeoutError" || err?.name === "AbortError") {
      throw new Error(
        `CDP HTTP 请求超时 (${timeout}ms): ${url}。请确认 Electron 已以 --remote-debugging-port=${port} 启动且端口未被其他进程占用。`
      );
    }
    throw err;
  }
  if (!res.ok) throw new Error(`CDP HTTP 错误: ${res.status} ${res.statusText}`);
  return res.json();
}

/**
 * 根据条件查找目标页面
 * @param {Object} opts
 * @param {string} [opts.host]
 * @param {number} [opts.port]
 * @param {string} [opts.title]   - 按标题模糊匹配
 * @param {string} [opts.url]     - 按 URL 模糊匹配
 * @param {number} [opts.index]   - 按索引选择（默认 0，即第一个非 DevTools 页面）
 * @returns {Promise<Object>} 页面信息对象
 */
export async function findTargetPage(opts = {}) {
  const { host = DEFAULT_HOST, port = DEFAULT_PORT, title, url, index } = opts;
  const pages = await listPages(host, port);

  if (pages.length === 0) {
    throw new Error(`CDP: 没有找到可调试页面 (${host}:${port})`);
  }

  let filtered = pages;

  // 按标题筛选
  if (title) {
    filtered = filtered.filter((p) => p.title?.includes(title));
  }

  // 按 URL 筛选
  if (url) {
    filtered = filtered.filter((p) => p.url?.includes(url));
  }

  // 默认过滤掉 DevTools 页面
  if (title === undefined && url === undefined) {
    filtered = filtered.filter((p) => !p.url?.startsWith("devtools://"));
  }

  if (filtered.length === 0) {
    throw new Error(`CDP: 没有找到匹配的页面`);
  }

  const idx = index ?? 0;
  if (idx >= filtered.length) {
    throw new Error(`CDP: 索引 ${idx} 超出范围，共 ${filtered.length} 个匹配页面`);
  }

  return filtered[idx];
}

/**
 * 建立 WebSocket 连接到指定页面，发送一个 CDP 命令并等待返回结果
 *
 * @param {string} webSocketDebuggerUrl - 如 ws://127.0.0.1:9222/devtools/page/xxx
 * @param {string} method               - CDP 方法名，如 "Runtime.evaluate"
 * @param {Object} params               - 方法参数
 * @param {number} [timeout=10000]      - 超时毫秒数
 * @returns {Promise<Object>} CDP 返回结果（msg.result）
 */
export async function sendCdpCommand(webSocketDebuggerUrl, method, params = {}, timeout = 10000) {
  return new Promise((resolve, reject) => {
    let ws;
    try {
      ws = new WebSocket(webSocketDebuggerUrl);
    } catch (err) {
      return reject(new Error(`创建 WebSocket 失败: ${err.message}`));
    }

    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error(`CDP 命令超时 (${timeout}ms): ${method}`));
    }, timeout);

    let msgId = 0;

    ws.onopen = () => {
      msgId++;
      ws.send(JSON.stringify({ id: msgId, method, params }));
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        // 只处理对应 ID 的响应（忽略推送事件）
        if (msg.id === msgId) {
          clearTimeout(timer);
          ws.close();
          if (msg.error) {
            reject(new Error(`CDP 错误: ${JSON.stringify(msg.error)}`));
          } else {
            resolve(msg.result);
          }
        }
      } catch (err) {
        // 忽略解析错误
      }
    };

    ws.onerror = (err) => {
      clearTimeout(timer);
      reject(new Error(`WebSocket 错误: ${err.message || "未知错误"}`));
    };

    ws.onclose = (event) => {
      if (event.code !== 1000 && event.code !== 1005) {
        clearTimeout(timer);
        reject(new Error(`WebSocket 意外关闭: code=${event.code}`));
      }
    };
  });
}

/**
 * 在目标页面上执行 JavaScript 代码
 *
 * @param {string} wsUrl       - WebSocket URL
 * @param {string} expression  - 要执行的 JS 表达式
 * @param {boolean} [returnByValue=true] - 是否返回值（false 则返回对象引用）
 * @returns {Promise<*>} 执行结果
 */
export async function evaluate(wsUrl, expression, returnByValue = true, timeout = 10000) {
  const result = await sendCdpCommand(wsUrl, "Runtime.evaluate", {
    expression,
    returnByValue,
  }, timeout);

  if (result.exceptionDetails) {
    const exc = result.exceptionDetails;
    const text = exc.text || exc.exception?.description || "未知错误";
    throw new Error(`JS 执行错误: ${text}`);
  }

  return result.result?.value;
}

/**
 * 获取页面截图（Base64 格式）
 */
export async function captureScreenshot(wsUrl, format = "png") {
  const result = await sendCdpCommand(wsUrl, "Page.captureScreenshot", {
    format,
    fromSurface: true,
  });
  return result.data; // Base64 字符串
}

/**
 * 启用控制台日志监听，收集一段时间内的日志
 */
export async function observeConsole(wsUrl, durationMs = 3000) {
  return new Promise((resolve, reject) => {
    let ws;
    try {
      ws = new WebSocket(wsUrl);
    } catch (err) {
      return reject(new Error(`创建 WebSocket 失败: ${err.message}`));
    }

    const logs = [];
    let id = 0;

    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      resolve(logs);
    }, durationMs);

    ws.onopen = () => {
      // 启用控制台
      id++;
      ws.send(JSON.stringify({ id, method: "Console.enable", params: {} }));

      // 也要启用 Runtime 以捕获异常
      id++;
      ws.send(JSON.stringify({ id, method: "Runtime.enable", params: {} }));

      // 注入 console 拦截脚本
      id++;
      ws.send(JSON.stringify({
        id,
        method: "Runtime.evaluate",
        params: {
          expression: `
            (() => {
              const orig = {};
              ['log','info','warn','error','debug'].forEach(m => {
                orig[m] = console[m];
                console[m] = (...args) => {
                  orig[m].apply(console, args);
                  // 通过 CDP 通知
                };
              });
              return 'console hook installed';
            })()
          `,
          returnByValue: true,
        },
      }));
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);

        // 处理 Console.messageAdded 事件
        if (msg.method === "Console.messageAdded") {
          const { level, text, url, line, column } = msg.params.message;
          logs.push({ level, text, url, line, column, timestamp: new Date().toISOString() });
        }

        // 处理 Runtime.consoleAPICalled 事件
        if (msg.method === "Runtime.consoleAPICalled") {
          const { type, args, stackTrace } = msg.params;
          const text = args.map((a) => a.value ?? a.description ?? JSON.stringify(a)).join(" ");
          logs.push({
            level: type,
            text,
            url: stackTrace?.callFrames?.[0]?.url,
            line: stackTrace?.callFrames?.[0]?.lineNumber,
            timestamp: new Date().toISOString(),
          });
        }

        // 处理 Runtime.exceptionThrown 事件
        if (msg.method === "Runtime.exceptionThrown") {
          const { exceptionDetails } = msg.params;
          logs.push({
            level: "error",
            text: exceptionDetails.text || exceptionDetails.exception?.description || "未知异常",
            url: exceptionDetails.url,
            line: exceptionDetails.lineNumber,
            timestamp: new Date().toISOString(),
          });
        }
      } catch {
        // 忽略解析错误
      }
    };

    ws.onerror = (err) => {
      clearTimeout(timer);
      reject(new Error(`WebSocket 错误: ${err.message || "未知错误"}`));
    };

    ws.onclose = () => {
      clearTimeout(timer);
      resolve(logs);
    };
  });
}
