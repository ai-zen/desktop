/**
 * 桌面端的连接配置 —— **规则一条都不在这里**，这里只有「两边字段名的对不上」这一件事。
 *
 * ## 为什么这里几乎不实现
 *
 * 读写（`0600` + `.tmp` → `rename`）、校验（地址形状那一份）、读不炸（坏文件回 `null`）、
 * `local` ⇒ 目标为空（空串在连接层里的语义是「显式给了个空值」）以及界面上那一行字，全部在
 * `@ai-zen/agents-client` 的 `settings.ts`。CLI 用的是同一份 —— 这套东西写第二遍的下场是**其中一份
 * 先修**：一端 0600、另一端 0644，而症状要等到某天有人 `cat` 完才知道。
 *
 * ## 为什么要映射一次字段名
 *
 * 客户端的 `ConnectionSettings` 里那两个字段叫 `url` / `token`（它也要服务通用场景），而桌面端对
 * 外的 IPC 形状（render 的设置面板、`ConnectionControls`）一直叫 `hostUrl` / `hostToken`。
 * 那一份 IPC 形状不许改（render 一行不动），所以映射落在**这一处**：两个方向各一个函数，别的地方
 * 不许再拼一次。
 *
 * ## 落点
 *
 * `<AI_ZEN_DIR>/desktop/connection.json`（`cli/` 那份归 CLI）。两个客户端可能在两台机器上，也可能
 * 同机连着不同的宿主 —— 「我这个终端连哪台」与「我的桌面端连哪台」是两件事。
 * 放 `desktop/` 子目录下而不是根下：根下（`config.json` / `agents/` / `run/` / 库 / `assets/`）全是
 * **宿主的事实**，客户端往里写东西会模糊那条边界。
 */

import {
  describeSettings,
  parseSettings,
  readSettings as readClientSettings,
  settingsLabel,
  settingsPath,
  settingsToTarget,
  writeSettings as writeClientSettings,
  type ConnectionSettings as ClientConnectionSettings,
} from "@ai-zen/agents-client";
import type { ConnectionSettings } from "@ai-zen/desktop-shared";

export type { ConnectionSettings };

/** 配置文件路径（每次现拼：`aiZenDir` 是可注入的，模块顶层算出来就是一张快照） */
export function settingsFilePath(aiZenDir: string): string {
  return settingsPath(aiZenDir, "desktop");
}

/** 读配置：`null` = 没配过（文件不在 / 坏 JSON / 字段不合法）。**不抛错**是契约的一半 */
export async function readSettings(aiZenDir: string): Promise<ConnectionSettings | null> {
  const stored = await readClientSettings(settingsFilePath(aiZenDir));
  return stored ? fromClient(stored) : null;
}

/** 写配置（`0600` + 原子写由客户端库实现） */
export function writeSettings(aiZenDir: string, settings: ConnectionSettings): Promise<void> {
  return writeClientSettings(settingsFilePath(aiZenDir), toClient(settings));
}

/**
 * 把一份**外来**的设置校验成可落盘的那一份（IPC 边界用）。
 *
 * 校验本身问客户端库的 `parseSettings`（它是地址与模式的唯一判据，也负责给出人话错误）；这里只把
 * 桌面端那两个字段名换成它认的那两个。
 */
export function parseConnectionSettings(raw: unknown): ConnectionSettings {
  return fromClient(parseSettings(looseToClient(raw)));
}

/** 界面上那一行字（`本机宿主` / 那个地址）。**绝不包含凭证**（地址里的 userinfo 会被抹掉） */
export function labelOf(settings: ConnectionSettings): string {
  return settingsLabel(toClient(settings));
}

/** 一句话描述（**进日志**）：只印模式与地址 */
export function describe(settings: ConnectionSettings): string {
  return describeSettings(toClient(settings));
}

/**
 * 一份设置 → 递给连接层的两个值（`hostUrl` / `hostToken`）。
 *
 * **这是「`local` 传 `undefined` 而不是空串」的唯一实现处**：空串会被连接层理解成「显式给了一个
 * 空值」，于是它不走发现文件、也不读本机凭证 —— 那条路上没有人会让它成功。
 */
export function connectionConfigOf(settings: ConnectionSettings): {
  hostUrl?: string;
  hostToken?: string;
} {
  const target = settingsToTarget(toClient(settings));
  return { hostUrl: target.url, hostToken: target.token };
}

// ---------------------------------------------------------------------------
// 内部：两份形状之间的映射（只在这一段里出现字段名）
// ---------------------------------------------------------------------------

function toClient(settings: ConnectionSettings): ClientConnectionSettings {
  return {
    mode: settings.mode,
    ...(settings.hostUrl ? { url: settings.hostUrl } : {}),
    ...(settings.hostToken ? { token: settings.hostToken } : {}),
  };
}

function fromClient(settings: ClientConnectionSettings): ConnectionSettings {
  // `local` 只留 `mode`：库里为了「读坏文件不丢掉用户填的值」会把残留的 url/token 也读回来，
  // 而桌面端对外的口径是「local 模式下那两个字段不存在」（它们不会被使用，留着只会在面板上
  // 显示一个假的远程地址）
  if (settings.mode !== "remote") return { mode: "local" };
  return {
    mode: "remote",
    ...(settings.url ? { hostUrl: settings.url } : {}),
    ...(settings.token ? { hostToken: settings.token } : {}),
  };
}

/**
 * IPC 上来的那一份（`unknown`）→ 客户端库认的形状。
 *
 * `mode` 原样传下去：它不合法时该由 `parseSettings` 报那句话，这里不重复一遍校验；字段名缺失就是
 * `undefined`，与「用户没填」是同一件事。
 */
function looseToClient(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null) return raw;
  const input = raw as { mode?: unknown; hostUrl?: unknown; hostToken?: unknown };
  return {
    mode: input.mode,
    url: input.hostUrl,
    token: input.hostToken,
  };
}
