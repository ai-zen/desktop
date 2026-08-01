/**
 * 模型服务 — 对应 render 的 apis/model.ts。
 * 模型列表来自全局 config.json 的 models（复用 SDK ConfigManager）。
 */

import { ConfigManager } from "@ai-zen/agents-sdk";
import type { ModelOption } from "@ai-zen/desktop-shared";

export class ModelService {
  constructor(private configManager: ConfigManager) {}

  async list(): Promise<ModelOption[]> {
    const config = await this.configManager.read();
    return config.models.map((m) => ({ id: m.id, name: m.name }));
  }
}
