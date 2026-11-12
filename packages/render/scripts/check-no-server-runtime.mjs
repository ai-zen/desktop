/**
 * 构建后自检：**render 的产物里没有服务端契约包的运行时引用**。
 *
 * ## 这条检查守的是什么
 *
 * `packages/shared` 与 `packages/render` 各自有一条指向 `agents/packages/server` 的 `link:` 依赖，
 * 用途只有一个：`import type` 拿到服务端 `wire/` 里那份形状，不再自己抄一遍。那条依赖是**开发时**
 * 的 —— render 是浏览器产物，运行期一个字节都不该要它（也没有 node 的模块解析可依赖）。
 *
 * 能静默退化的方式只有一种，而且不会让任何用例变红：有人把 `import type` 写成 `import`。那时
 * 类型检查照样绿、单测照样绿（vitest 在 node 里跑，`node_modules` 里那份链接还在），只有**产物**
 * 能回答「这条依赖到底有没有被要」。所以判据落在这里，`pnpm build` 之后跑。
 *
 * ## 判据
 *
 * · 出现 `from "…"` / `import "…"` / `require("…")` / `import("…")` 指向那两个包 → 真的被解析了；
 * · 甚至只是出现了那两个名字 → `import type` 应当被完全擦除，留下痕迹就说明它没被擦干净；
 * · 出现 `node:*` 的解析 → render 是浏览器产物，内建模块一个都不该要。
 *
 * 名字里的 `.` 与 `/` 都按字面处理（转义后再进正则），免得 `@ai-zen/agents-client` 里的 `-` 被当成
 * 字符集。注释里出现这个词的情况极罕见；真出现时脚本会打印上下文，看一眼就知道要不要改词。
 */

import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** render 的产物目录（vite 的 `build.outDir` 指到 main 的 `dist/static`） */
const OUT_DIR = join(here, "..", "..", "main", "dist", "static");

/** 只在这两条依赖上做「开发时」：类型可以来它们，运行期不许要它们 */
const FORBIDDEN = ["@ai-zen/agents-server", "@ai-zen/agents-client"];

/** 产物里必须能找到的 render 自己的代码（找不到就说明查错了地方，这条检查等于没跑） */
const MARKERS = ["invokeService", "electronAPI"];

/** 产物里被检查的文件类型（`.map` 不算：它是给调试器看的源映射，不进运行期） */
const CHECKED = [".js", ".mjs", ".html", ".css"];

/** 会把一个模块名真的交给解析器的那几种写法 */
function resolutionPatterns(name) {
  const literal = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [
    new RegExp(`from\\s*["']${literal}["']`),
    new RegExp(`import\\s*["']${literal}["']`),
    new RegExp(`require\\(\\s*["']${literal}["']\\s*\\)`),
    new RegExp(`import\\(\\s*["']${literal}["']\\s*\\)`),
  ];
}

/** `node:*` 内建模块的解析（同样只认「真的交给解析器」的那几种写法） */
const NODE_SPECIFIER = /(?:from\s*|import\s*|require\(\s*|import\(\s*)["']node:/;

/** 目录下（递归）所有要检查的文件 */
async function listFiles(dir) {
  const found = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await listFiles(path)));
      continue;
    }
    if (CHECKED.some((extension) => entry.name.endsWith(extension))) found.push(path);
  }
  return found;
}

/** 命中的那一小段上下文（判断「是解析还是注释」时看这一句就够） */
function snippetOf(text, index) {
  const start = Math.max(0, index - 60);
  return text.slice(start, index + 120).replace(/\s+/g, " ");
}

const files = await listFiles(OUT_DIR);
if (files.length === 0) {
  console.error(`✗ ${OUT_DIR} 里没有产物：先跑一次 build`);
  process.exit(1);
}

const problems = [];
let totalBytes = 0;
let renderCode = "";

for (const file of files) {
  const text = await readFile(file, "utf8");
  totalBytes += text.length;
  renderCode += text;
  const where = relative(OUT_DIR, file);

  for (const name of FORBIDDEN) {
    for (const pattern of resolutionPatterns(name)) {
      const match = pattern.exec(text);
      if (match) {
        problems.push(`${where} 里有对 ${name} 的运行时解析：${snippetOf(text, match.index)}`);
      }
    }
    // 名字出现但解析规则一条都没命中：`import type` 没被擦干净（或者它出现在一句话里）
    const index = text.indexOf(name);
    if (index >= 0 && !resolutionPatterns(name).some((pattern) => pattern.test(text))) {
      problems.push(`${where} 里留下了 ${name} 的字样（import type 应当被完全擦除）：${snippetOf(text, index)}`);
    }
  }

  const nodeMatch = NODE_SPECIFIER.exec(text);
  if (nodeMatch) {
    problems.push(`${where} 里有 node 内建模块的解析（render 是浏览器产物）：${snippetOf(text, nodeMatch.index)}`);
  }
}

const missing = MARKERS.filter((marker) => !renderCode.includes(marker));
if (missing.length > 0) {
  problems.push(`产物里找不到 render 自己的代码：${missing.join("、")}（查的是不是别的目录？）`);
}

if (problems.length > 0) {
  console.error(`✗ ${OUT_DIR} 没通过「运行期零依赖」自检：`);
  for (const problem of problems) console.error(`  · ${problem}`);
  process.exit(1);
}

console.log(`✓ render 产物不含服务端/客户端库的运行时引用（${files.length} 个文件，${(totalBytes / 1024).toFixed(1)} kB）`);
console.log(`  · ${FORBIDDEN.join(" / ")}：一个解析路径、一处字样都没有`);
console.log(`  · 没有 node:* 的解析路径；render 自己的代码特征串 ${MARKERS.length} 个都在`);
