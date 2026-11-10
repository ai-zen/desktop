---
title: CDP 调试
description: 通过 Chrome DevTools Protocol 调试 Desktop 渲染进程的方法与工具集使用
---

# CDP 远程调试指南

Electron 启动时通过 `--remote-debugging-port=9222` 开启了 Chrome DevTools Protocol。

## 推荐方式：使用 CDP 工具集

项目提供了 7 个 CDP 调试工具，位于 `.ai-zen/tools/` 目录下，可供 AI Agent 自动发现和调用：

| 工具 | 功能 |
|------|------|
| `cdp_list_pages` | 列出所有可调试页面 |
| `cdp_evaluate` | 在页面中执行 JS 代码 |
| `cdp_screenshot` | 页面截图保存为 PNG |
| `cdp_get_dom` | 获取页面 DOM 结构 |
| `cdp_get_css_vars` | 获取 CSS 自定义属性 |
| `cdp_console` | 监听控制台日志输出 |
| `cdp_diagnose` | 综合诊断（页面信息、Vue 结构、主题、性能、错误） |

这些工具使用 Node.js 原生 `WebSocket` 和 `fetch`（需 Node.js ≥ 21），零外部依赖。

## 手动调试方式

### 浏览器访问 DevTools

```
http://127.0.0.1:9222/json
```

返回 JSON 列表，点击 `devtoolsFrontendUrl` 即可打开完整 DevTools。

### 通过 WebSocket 直接调用 CDP（Node.js ≥ 21）

```js
const ws = new WebSocket("ws://127.0.0.1:9222/devtools/page/{PAGE_ID}");

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

- 推荐优先使用 `.ai-zen/tools/` 中的 CDP 工具集（会被 AI Agent 自动发现）
- 调试端口由启动命令传入：`pnpm dev`（`scripts/dev.mjs` 转给 electron）与 `packages/main/package.json` 的 `start` 都用 `--remote-debugging-port`
- 端口默认 `9222`，被占用时用环境变量 `CDP_PORT` 换一个（`CDP_PORT=9333 pnpm dev`）；在代码里 `app.commandLine.appendSwitch` 无效
- 使用完记得关闭 Electron 进程，避免端口占用
