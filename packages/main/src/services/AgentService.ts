/**
 * Agent 服务 — 对应 render 的 apis/agent.ts。
 * 入口 Agent 单来源：~/.ai-zen/agents（复用 SDK AgentRepository）。
 */

import { AgentRepository } from "@ai-zen/agents-sdk";
import type { AgentOption } from "@ai-zen/desktop-shared";

export class AgentService {
  constructor(private repo: AgentRepository) {}

  async list(): Promise<AgentOption[]> {
    const agents = await this.repo.list();
    return agents
      .filter((a) => !a.function) // 只列入口 Agent（排除 SubAgent 定义）
      .map((a) => ({ id: a.id, name: a.name, description: a.description }));
  }
}
