/**
 * config api — 设置页（对应 main ServerConfigService）。
 */

import type { ConfigSettings, ConfigUpdateReport } from "@ai-zen/desktop-shared";
import { invokeService } from "./base.js";

export function getConfigSettings(): Promise<ConfigSettings> {
  return invokeService("config", "get");
}

/**
 * 保存设置。返回值是**这次真的写进去了什么**（`ConfigUpdateReport`）：main 有两处故意不写
 * （匹配不上的端点、空的默认值），它会如实报回来 —— 界面拿它说真话，而不是假定「发了就等于
 * 写进去了」。
 */
export function updateConfigSettings(
  input: Partial<ConfigSettings>,
): Promise<ConfigUpdateReport> {
  return invokeService("config", "update", input);
}
