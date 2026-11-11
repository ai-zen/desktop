/**
 * 用户敲的地址 → 一条能交给 `parseServerUrl` 的地址。
 *
 * 只做一件事：**没写 scheme 就补 `ws://`**。用户在面板里敲 `10.0.0.5:8790` 是最自然的写法，
 * 而地址形状的唯一判据（包里 `parseServerUrl`）要求带 scheme —— 不补的话他会得到一句「不是合法
 * 的服务端地址」，而真正的问题只是少敲了六个字符。
 *
 * **不猜加密**：写了 `https://` / `wss://` 就按他的（包里有 `http→ws`、`https→wss` 的映射），
 * 没写就当内网明文 —— 反过来「自动给你升成 wss」会在连一个没配证书的服务端时得到一条与地址
 * 无关的 TLS 报错。
 *
 * ## 为什么它在这里，而不是直接从包里 import
 *
 * 这条规则与 `cli/src/connection.ts` 的同名函数一字不差，本来该只有一份。但 `agents-client` 是
 * **Node 包**（读文件、拉起子进程），render 侧（浏览器环境）import 它会把这些拖进产物。所以
 * 共享的那一份落在本包（零依赖、两端都认），代价是这五行在跨仓的两个地方各有一份 ——
 * 真要再出现第三处，就把它挪进包里给 `parseServerUrl` 做邻居。
 */
export function normalizeServerAddress(raw: string): string {
  const text = raw.trim();
  if (text === "") return text;
  return text.includes("://") ? text : `ws://${text}`;
}
