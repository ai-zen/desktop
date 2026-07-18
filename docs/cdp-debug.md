# CDP 远程调试指南

Electron 启动时通过 `--remote-debugging-port=9222` 开启了 Chrome DevTools Protocol。

## 连接方式

### 浏览器访问
```
http://127.0.0.1:9222/json
```
返回 JSON 列表，点击 `devtoolsFrontendUrl` 即可打开完整 DevTools。

### 通过 WebSocket 获取 DOM（Node.js ≥ 21 原生支持）

```js
const PAGE_ID = "xxxxxxxxxxxx"; // 从 /json 接口获取

const ws = new WebSocket(
  `ws://127.0.0.1:9222/devtools/page/${PAGE_ID}`
);

let id = 0;
function send(method, params = {}) {
  ws.send(JSON.stringify({ id: ++id, method, params }));
}

ws.onopen = () => {
  // 获取 DOM 结构
  send("Runtime.evaluate", {
    expression: `document.body.innerHTML.substring(0, 3000)`,
  });

  // 或截图
  send("Page.captureScreenshot", { format: "png" });
};

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.result) console.log(msg.result);
};
```

> Node.js ≥ 21 内置 `globalThis.WebSocket`，无需安装 `ws` 包。

## 常用 CDP 方法

| 方法 | 用途 |
|------|------|
| `DOM.getDocument` | 获取完整 DOM 树 |
| `Runtime.evaluate` | 执行 JS 代码 |
| `Page.captureScreenshot` | 页面截图 |
| `Console.enable` | 监听控制台日志 |
| `Network.enable` | 监听网络请求 |

## 注意事项

- CDP 仅在 `NODE_ENV=development` 或 `pnpm start` 时开启
- 端口 `9222` 可能被占用，可在 `package.json` 中修改
- 使用完记得关闭 Electron 进程，避免端口占用
