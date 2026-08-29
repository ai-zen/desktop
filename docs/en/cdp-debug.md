---
title: CDP Debugging
description: Methods and toolset for debugging the Desktop renderer process via the Chrome DevTools Protocol
---

# CDP Remote Debugging Guide

Electron enables the Chrome DevTools Protocol at startup via `--remote-debugging-port=9222`.

## Recommended approach: use the CDP toolset

The project provides 7 CDP debugging tools in the `.ai-zen/tools/` directory, which AI Agents can automatically discover and invoke:

| Tool | Function |
|------|----------|
| `cdp_list_pages` | List all debuggable pages |
| `cdp_evaluate` | Execute JS code in the page |
| `cdp_screenshot` | Save a page screenshot as PNG |
| `cdp_get_dom` | Get the page DOM structure |
| `cdp_get_css_vars` | Get CSS custom properties |
| `cdp_console` | Listen to console log output |
| `cdp_diagnose` | Comprehensive diagnostics (page info, Vue structure, theme, performance, errors) |

These tools use Node.js native `WebSocket` and `fetch` (requires Node.js ≥ 21), zero external dependencies.

## Manual debugging approach

### Access DevTools in the browser

```
http://127.0.0.1:9222/json
```

Returns a JSON list; click `devtoolsFrontendUrl` to open the full DevTools.

### Call CDP directly over WebSocket (Node.js ≥ 21)

```js
const ws = new WebSocket("ws://127.0.0.1:9222/devtools/page/{PAGE_ID}");

let id = 0;
function send(method, params = {}) {
  ws.send(JSON.stringify({ id: ++id, method, params }));
}

ws.onopen = () => {
  // Get the DOM structure
  send("Runtime.evaluate", {
    expression: `document.body.innerHTML.substring(0, 3000)`,
  });

  // Or take a screenshot
  send("Page.captureScreenshot", { format: "png" });
};

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.result) console.log(msg.result);
};
```

> Node.js ≥ 21 provides built-in `globalThis.WebSocket`, no need to install the `ws` package.

## Common CDP methods

| Method | Purpose |
|--------|---------|
| `DOM.getDocument` | Get the full DOM tree |
| `Runtime.evaluate` | Execute JS code |
| `Page.captureScreenshot` | Take a page screenshot |
| `Console.enable` | Listen to console logs |
| `Network.enable` | Listen to network requests |

## Notes

- Prefer the CDP toolset in `.ai-zen/tools/` (auto-discovered by AI Agents)
- CDP is only enabled when `NODE_ENV=development` or `pnpm start` (port 9222)
- Port 9222 may be occupied; modify it in `package.json`
- Remember to close the Electron process after use to avoid port occupation
