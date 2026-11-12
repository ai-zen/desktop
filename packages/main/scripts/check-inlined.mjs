/**
 * 构建后自检：**共享的客户端库真的被捆进产物了吗**，以及产物有没有偷偷去解析它。
 *
 * ## 为什么这件事要一个脚本，而不是「看一眼 dist」
 *
 * 这一波能静默退化的方式只有两种，而且都不会让任何用例变红：
 *
 *   1. 有人把 `@ai-zen/agents-client` 加回 `external`（或删掉别名）：本地跑得好好的，因为
 *      `node_modules` 里那份链接还在 —— 到了客户机上（asar 里没有 `node_modules`）才炸；
 *   2. 有人换回 `import { Client } from "@ai-zen/agents-client"` 的**发布路径**写法：产物里于是留下
 *      一条对 npm 包的解析，而 R69 说的是「不许依赖已发布的共享包」。
 *
 * 两种情况在源码里都看不出来（源码本来就要 import 它），只有**产物**能回答。所以判据落在这里，
 * 并且在 `pnpm build` 之后就能跑（`pnpm check:inline`）。
 *
 * ## 判据
 *
 * · 有没有 `require("…")` / `import … from "…"` 指向 `@ai-zen/agents-client` 或 `agents-protocol`
 *   —— 有就是外置了，退出码 1；
 *   （注释里出现这个名字不算：那是文档，不是解析。所以只认 `from "` / `require("` 紧邻的那一处。）
 * · 客户端库里那几段独有代码在不在产物里 —— 不在就说明别名没生效，或者被 tree-shake 掉了。
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const bundle = join(here, "..", "dist", "main.mjs");

/** 产物里出现这些特征串，说明客户端库的代码确实在里面 */
const CLIENT_MARKERS = [
  // `connection.ts`：本机发现文件 + 拉起服务端
  "run/server.json",
  "readLocalToken",
  "server_did_not_start",
  // `client.ts`：重连之后按 track 过的对话补拉
  "resumeTracked",
  // `frames.ts` / `address.ts`：线上那一层
  "webSocketUrl",
  "addressLabel",
  // `reconnect.ts`
  "reconnectUntilConnected",
];

/** 产物里**不允许**留下的解析路径（R69：不发包、不依赖已发布的共享包） */
const FORBIDDEN = ["@ai-zen/agents-client", "@ai-zen/agents-protocol"];

const text = await readFile(bundle, "utf8");
const problems = [];

for (const name of FORBIDDEN) {
  // 只认真正会去解析它的那两种写法；注释里的名字与 `import type` 被擦除后的痕迹都不算
  const patterns = [
    new RegExp(`from\\s*["']${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`),
    new RegExp(`require\\(\\s*["']${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']\\s*\\)`),
    new RegExp(`import\\(\\s*["']${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']\\s*\\)`),
  ];
  for (const pattern of patterns) {
    if (pattern.test(text)) problems.push(`产物里还有对 ${name} 的解析：${pattern}`);
  }
}

const missing = CLIENT_MARKERS.filter((marker) => !text.includes(marker));
if (missing.length > 0) problems.push(`产物里找不到客户端库的代码：${missing.join("、")}`);

if (problems.length > 0) {
  console.error(`✗ ${bundle} 没通过内联自检：`);
  for (const problem of problems) console.error(`  · ${problem}`);
  process.exit(1);
}

console.log(`✓ 客户端库已内联进 ${bundle}（${(text.length / 1024).toFixed(1)} kB）`);
console.log(`  · 特征串 ${CLIENT_MARKERS.length} 个全在`);
console.log(`  · 没有任何 ${FORBIDDEN.join(" / ")} 的运行时解析路径`);
