/**
 * 桌面端的连接配置 —— **只是把包里那一份绑到本仓的落点上**，规则一条都不在这里。
 *
 * ## 为什么这里没有实现
 *
 * 读写（`0600` + `.tmp` → `rename`）、校验（`parseServerUrl` 那一份）、读不炸（坏文件回
 * `null`）、`local` ⇒ `undefined`（空串在连接层里的语义是「显式给了个空值」）以及界面上那一行
 * 字，全部在 `@ai-zen/agents-client` 的 `connection-settings.ts`。CLI 用的是同一份 —— 这套东西
 * 写第二遍的下场是**其中一份先修**：一端 0600、另一端 0644，而症状要等到某天有人 `cat` 完
 * 才知道。
 *
 * ## 这里只剩两件事
 *
 * 1. **落点**：`<AI_ZEN_DIR>/desktop/connection.json`（`cli/` 那份归 CLI）。两个客户端可能在两台
 *    机器上，也可能同机连着不同的服务端 —— 「我这个终端连哪台」与「我的桌面端连哪台」是两件事。
 *    放在 `desktop/` 子目录下而不是根下：根下（`config.json` / `agents/` / `workspaces/` /
 *    `run/`）全是**服务端的事实**，客户端往里写东西会模糊那条边界。
 * 2. **「没配过」的第三种情形**：`readSettings` 返回 `ConnectionSettings | null`，`null` 表示这份
 *    文件不存在或不可用 —— 首启的判据。别用 `{ mode: "local" }` 兜底：那会把首启压成「用户选过
 *    本地」，于是应用一启动就去拉起一个本地服务端，引导屏永远出不来。
 */

import {
  connectionSettingsPath,
  readConnectionSettings,
  writeConnectionSettings,
  type ConnectionSettings,
} from "@ai-zen/agents-client";

// 规则从包里转出（本仓不再有第二份）
export {
  connectionLabel as labelOf,
  connectionSettingsToTarget as connectionConfigOf,
  describeConnection as describe,
  parseConnectionSettings,
} from "@ai-zen/agents-client";

export type { ConnectionSettings };

/** 配置文件路径（每次现拼：`aiZenDir` 是可注入的，模块顶层算出来就是一张快照） */
export function connectionSettingsPathOf(aiZenDir: string): string {
  return connectionSettingsPath(aiZenDir, "desktop");
}

/** 读配置：`null` = 没配过（文件不在 / 坏 JSON / 字段不合法）。**不抛错**是契约的一半 */
export function readSettings(aiZenDir: string): Promise<ConnectionSettings | null> {
  return readConnectionSettings(connectionSettingsPathOf(aiZenDir));
}

/** 写配置（`0600` + 原子写由包里实现） */
export function writeSettings(aiZenDir: string, settings: ConnectionSettings): Promise<void> {
  return writeConnectionSettings(connectionSettingsPathOf(aiZenDir), settings);
}
