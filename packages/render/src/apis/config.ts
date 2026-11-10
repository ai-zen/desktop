/**
 * config api — 设置页（对应 main ServerConfigService）。
 */

import type { ConfigSettings } from "@ai-zen/desktop-shared";
import { invokeService } from "./base.js";

export function getConfigSettings(): Promise<ConfigSettings> {
  return invokeService("config", "get");
}

export function updateConfigSettings(
  input: Partial<ConfigSettings>,
): Promise<void> {
  return invokeService("config", "update", input);
}
