/**
 * 连接配置的**读写**：`<AI_ZEN_DIR>/desktop/connection.json`（D17）。
 *
 * ## 为什么桌面端终于要写一个文件了
 *
 * 别的东西（会话、Agent 定义、模型配置、工作区存档）全在常驻 `agents-server` 那边，桌面端
 * 只读不写。但「连哪台服务端」这个问题**必须**在本机有答案：先有鸡先有蛋 —— 服务端手上有
 * 配置，可我们得先决定连哪台服务端，才能问它要配置。所以它是本进程唯一一处自己的持久化，
 * 而且只存两样用户手填的东西：模式，以及（远程模式下的）地址与凭证。
 *
 * ## 三条硬要求
 *
 *   · **`0600`**：文件里有凭证。写法与 `agents/packages/server/src/wire/token.ts` 同一手法
 *     （`.tmp` + `rename` + 显式 `chmod`）—— 顺手 `cat` 一下的代价是零，把它贴出去的代价
 *     不该由「记得别贴」来兜；
 *   · **原子**：先写 `.tmp` 再 `rename`，于是进程被杀在中间也不会留下半个 JSON（半个 JSON
 *     的后果是「配置读不出来」→ 悄悄退回 `local`，用户以为自己填过）；
 *   · **读不炸**：文件不存在 / 坏 JSON / 字段不合法一律回默认 `{ mode: "local" }`，**绝不抛错**。
 *     读不到配置不该让应用起不来 —— 那会让一个手滑的文件变成「双击没反应」。
 *
 * ## 校验为什么用客户端包的 `parseServerUrl`
 *
 * 地址的形状只有一个定义处（`agents/packages/client/src/wire/server-url.ts`）：`ws:` / `wss:` /
 * `http:` / `https:`、缺省端口、IPv6 方括号、子路径。本仓多写一行校验就是一个能静默跑偏的
 * 第二份实现，所以这里只**调用**它，不自己判。
 *
 * 读路径（{@link readSettings}）也用同一份校验：一个 `mode: "remote"` 却填了垃圾地址的文件，
 * 与「坏 JSON」是同一类事实 —— 这份配置不可用。读不动的配置**退回 `local` 并继续启动**，
 * 比带着一个解析不了的地址去连、然后在连接层报一句莫名其妙的错要好。
 */

import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { parseServerUrl } from "@ai-zen/agents-client";
import type { ConnectionSettings } from "@ai-zen/desktop-shared";

/**
 * 默认配置：`local`（= 老路：发现文件 + 本机 `run/token`）。
 *
 * 它是**默认值**，也是读取失败时的兜底。每次用都 `{ ...DEFAULT_CONNECTION_SETTINGS }` 复制
 * 一份交出去：共享一个可变对象的话，谁改一下它，全进程的「默认」就跟着变了。
 */
export const DEFAULT_CONNECTION_SETTINGS: ConnectionSettings = { mode: "local" };

/**
 * 配置文件路径（每次现拼：`aiZenDir` 是可注入的，模块顶层算出来就是一张快照）。
 *
 * 放在 `<AI_ZEN_DIR>/desktop/` 下而不是根下：根下（`config.json` / `agents/` /
 * `workspaces/` / `run/`）全是**服务端的事实**，桌面端往里写东西会模糊那条边界；`desktop/`
 * 一眼就是「这个客户端自己的」。
 */
export function connectionSettingsPath(aiZenDir: string): string {
  return join(aiZenDir, "desktop", "connection.json");
}

/**
 * 读配置：读不到 / 坏 JSON / 字段不合法 → 默认值。
 *
 * **不抛错**是契约的一半（D17）：`readFile` 的任何失败（不存在、权限、目录是个文件）都
 * 走同一个兜底，因为对调用方来说它们都是同一件事 —— 「没有可用配置」。区分它们只会让启动
 * 路径多几条没人处理的分支。
 */
export async function readSettings(aiZenDir: string): Promise<ConnectionSettings> {
  const fallback = { ...DEFAULT_CONNECTION_SETTINGS };

  let raw: string;
  try {
    raw = await fs.readFile(connectionSettingsPath(aiZenDir), "utf-8");
  } catch {
    // 文件不在是**正常状态**（第一次启动之前就是它）
    return fallback;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // 坏 JSON（手改坏了、写到一半被 kill）：当作没有配置，别让应用起不来
    return fallback;
  }

  return normalizeStored(parsed) ?? fallback;
}

/**
 * 写配置：**先写 `.tmp` 再 `rename`**，权限 `0600`。
 *
 * 关键在 `rename`：同一个文件系统内的 rename 是原子的，所以读方要么看到旧内容、要么看到
 * 新内容，永远看不到半份。`mode` 只在「这次新建的文件」上生效，`.tmp` 若是上一轮崩溃留下的
 * （进程被杀在 rename 之前），它的权限不会自己变回 0600 —— 所以再显式 `chmod` 一次，与
 * `wire/token.ts` 的 `ensureToken` 逐字同一手法。
 *
 * 校验不在这里做：本函数只负责「把给我的这份写下去」。校验在 {@link parseConnectionSettings}
 * （IPC 边界用）与 {@link normalizeStored}（读路径用）—— 一处负责「收进来的」，一处负责
 * 「读回来的」，写只负责落地。
 */
export async function writeSettings(
  aiZenDir: string,
  settings: ConnectionSettings,
): Promise<void> {
  const file = connectionSettingsPath(aiZenDir);
  await fs.mkdir(dirname(file), { recursive: true });

  const tmp = `${file}.tmp`;
  // 末尾留一个换行：这份文件可能被人 `cat` / 手改，一行结束得像个文本文件
  const content = `${JSON.stringify(settings, null, 2)}\n`;
  await fs.writeFile(tmp, content, { encoding: "utf-8", mode: 0o600 });
  await fs.chmod(tmp, 0o600);
  await fs.rename(tmp, file);
}

/**
 * 把一份**外来**的设置校验成可落盘的那一份（IPC 边界用：`connection:save`）。
 *
 * 与 {@link normalizeStored} 的区别是**失败方式**：读路径上「不可用」= 退回默认（应用要继续
 * 启动）；保存路径上「不可用」= 抛人话（用户刚刚在面板里敲的，静默改掉他的输入比报错更糟）。
 *
 * 校验规则：
 *
 *   · `mode` 只能是 `local` / `remote`；
 *   · `remote` 必须有地址，而且必须是 `parseServerUrl` 认得的地址；
 *   · `local` 下 `serverUrl` / `serverToken` **不被使用**（{@link connectionConfigOf} 对 `local`
 *     一律给连接层 `undefined`）。本函数对它们**只照存、不主动抹**：入参里带了就照抄进返回值。
 *     但**落盘是整份替换、不是合并**（{@link writeSettings} 只是把给它的这一份 `stringify`
 *     下去），所以**调用方不传 = 从盘上清掉这两个字段**。今天设置页在 `local` 下只发
 *     `{ mode: "local" }`，于是实际行为是「切到本地并保存 → 远端地址与凭证从盘上消失」。
 *     这是**有意的**（切到本地 = 不再用那台远程机，没必要把凭证留在盘上），不是这里的
 *     「保留」承诺 —— 别读成「传了就一定还在」；想让它们留下的调用方得自己传；
 *   · `serverToken` 允许留空（空 = 用本机 `run/token`，是 D9 明文支持的一条路，不许在校验里禁掉）。
 */
export function parseConnectionSettings(raw: unknown): ConnectionSettings {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("连接设置必须是一个对象");
  }
  const input = raw as Partial<ConnectionSettings>;
  if (input.mode !== "local" && input.mode !== "remote") {
    throw new Error(
      `连接设置里的 mode 只能是 local 或 remote（收到：${JSON.stringify(input.mode)}）`,
    );
  }

  const serverUrl = trimmed(input.serverUrl);
  const serverToken = trimmed(input.serverToken);

  if (input.mode === "remote") {
    if (!serverUrl) {
      throw new Error("选了远程模式，但没填服务端地址");
    }
    // 地址的合法性只问客户端包那一个实现（错误信息里带原串，用户认得出自己填了什么）
    parseServerUrl(serverUrl);
  }

  return {
    mode: input.mode,
    ...(serverUrl ? { serverUrl } : {}),
    ...(serverToken ? { serverToken } : {}),
  };
}

/**
 * 一份设置 → 递给连接层的两个值（`ServerLayerOptions.serverUrl` / `serverToken`）。
 *
 * ## 这就是「`local` 传 `undefined` 而不是空串」的唯一实现处
 *
 * 客户端把空串理解成「显式给了一个空值」：给了空地址 ⇒ 不走发现文件；给了空凭证 ⇒ 不退回
 * `run/token`。所以 `local` 模式下这里必须吐出 `undefined`，而「两个字段都是空串」
 * 也得同样折成 `undefined`。
 *
 * 输入在 save 时已校验、读回时已归一化，这里只做映射，不再判合法性。
 */
export function connectionConfigOf(settings: ConnectionSettings): {
  serverUrl?: string;
  serverToken?: string;
} {
  if (settings.mode !== "remote") {
    // `local` = 老路：两个值都是「没给」，而不是「给了空的」
    return { serverUrl: undefined, serverToken: undefined };
  }
  return {
    serverUrl: trimmed(settings.serverUrl),
    serverToken: trimmed(settings.serverToken),
  };
}

// ==================================================================
// 内部
// ==================================================================

/**
 * 读回来那份的**宽松**归一化：认不出来就返回 `null`（调用方退回默认值），任何情况下不抛。
 *
 * 与 {@link parseConnectionSettings} 的两处差别，都是有意的：
 *
 *   · 不认得 = `null`（不是抛错）：读路径不能把一份手滑的文件变成一次启动失败；
 *   · `local` 模式下**不校验**残留的 `serverUrl`：它不会被使用（{@link connectionConfigOf}
 *     对 local 一律吐 `undefined`），为一段用不上的字符串拒掉整份配置只会让人莫名其妙。
 *     「不校验」与「会被清掉」不矛盾：清理发生在**保存路径**上（设置页在 `local` 下只发
 *     `{ mode: "local" }`，理由见 {@link parseConnectionSettings} 那条规则），而这里是读路径
 *     —— 盘上真有一份手改出来的 `mode: "local"` + 残留 `serverUrl`，就照读、照留着；
 *     从面板保存一次就没了。
 */
function normalizeStored(raw: unknown): ConnectionSettings | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const input = raw as Partial<ConnectionSettings>;
  if (input.mode !== "local" && input.mode !== "remote") return null;

  const serverUrl = trimmed(input.serverUrl);
  const serverToken = trimmed(input.serverToken);
  if (input.mode === "remote") {
    // 远程模式没有可解析的地址 = 这份配置不可用（与坏 JSON 同一类事实）
    if (!serverUrl) return null;
    try {
      parseServerUrl(serverUrl);
    } catch {
      return null;
    }
  }

  return {
    mode: input.mode,
    ...(serverUrl ? { serverUrl } : {}),
    ...(serverToken ? { serverToken } : {}),
  };
}

/**
 * 去首尾空白；不是字符串 / 空串 → `undefined`。
 *
 * 空串在这套配置里没有含义（空地址、空凭证都是「没填」），折成 `undefined` 让下游只剩一种
 * 「没有」的写法 —— 类型上也就不会出现「有值、但值是空的」这种半截状态。
 */
function trimmed(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text === "" ? undefined : text;
}
