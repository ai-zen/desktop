/**
 * model api — 模型列表（对应 main 的 ConfigManager / config.models）。
 */

import type { ModelOption } from "@ai-zen/desktop-shared";
import { invokeService } from "./base.js";

export function listModels(): Promise<ModelOption[]> {
  return invokeService("model", "list");
}
