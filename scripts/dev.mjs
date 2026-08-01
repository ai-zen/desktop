import { exec } from "child_process";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const isWin = process.platform === "win32";
const ext = isWin ? ".cmd" : "";
const concurrently = resolve(ROOT, "node_modules/.bin/concurrently" + ext);
const electron = resolve(ROOT, "packages/main/node_modules/.bin/electron" + ext);

// exec 直接传命令字符串给 shell，引号被 shell 正确解析
const cmd = [
  `"${concurrently}" -k -n compile:main,render,electron -c cyan,magenta,yellow`,
  `"pnpm --filter @ai-zen/desktop-main dev"`,
  `"pnpm --filter @ai-zen/desktop-render dev"`,
  // nodemon --exec 参数整体用引号包裹
  `"nodemon --watch packages/main/dist/main.mjs --exec \\"${electron} --remote-debugging-port=9222 packages/main/dist/main.mjs\\""`,
].join(" ");

const child = exec(cmd, {
  cwd: ROOT,
  env: { ...process.env, NODE_ENV: "development" },
});

child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
child.on("exit", (code) => process.exit(code));
