/**
 * agent api — Agent 列表（对应 main 的 AgentRepository，入口 Agent 单来源）。
 */

import type { AgentOption } from "@ai-zen/desktop-shared";
import { invokeService } from "./base.js";

export function listAgents(): Promise<AgentOption[]> {
  return invokeService("agent", "list");
}
