/**
 * 配置服务 — 对应 render 的 apis/config.ts。
 *
 * 供「设置页」读写全局 ~/.ai-zen/config.json（复用 SDK ConfigManager）。
 * 仅暴露设置页所需的最小字段：API Key / 默认模型 / 默认 Agent / 数据目录。
 * 数据目录只读（AI_ZEN_DIR 路径常量），不参与用户编辑。
 */

import { ConfigManager } from "@ai-zen/agents-sdk";
import type { ConfigSettings, EndpointSettings } from "@ai-zen/desktop-shared";

export class ConfigService {
  constructor(
    private configManager: ConfigManager,
    /** 数据目录（只读展示，来自 config.ts 的 AI_ZEN_DIR） */
    private dataDir: string,
  ) {}

  /** 读取设置页所需配置（API Key 明文返回，桌面本地应用场景可接受） */
  async get(): Promise<ConfigSettings> {
    const config = await this.configManager.read();
    const endpoints: EndpointSettings[] = config.endpoints.map((e) => ({
      id: e.id,
      name: e.name,
      baseUrl: e.baseUrl,
      apiKey: e.apiKey ?? "",
      description: e.description,
    }));
    return {
      endpoints,
      defaultModel: config.defaultModel ?? "",
      defaultAgent: config.defaultAgent ?? "",
      dataDir: this.dataDir,
    };
  }

  /**
   * 更新设置。input 为部分字段：
   *   - defaultModel / defaultAgent：直接覆盖；
   *   - endpoints：按 id 匹配更新对应 endpoint 的 apiKey / baseUrl / name。
   */
  async update(input: Partial<ConfigSettings>): Promise<void> {
    const config = await this.configManager.read();

    if (input.defaultModel !== undefined) {
      config.defaultModel = input.defaultModel;
    }
    if (input.defaultAgent !== undefined) {
      config.defaultAgent = input.defaultAgent || undefined;
    }
    if (input.endpoints) {
      for (const ep of input.endpoints) {
        const target = config.endpoints.find((e) => e.id === ep.id);
        if (!target) continue;
        if (ep.apiKey !== undefined) target.apiKey = ep.apiKey;
        if (ep.baseUrl !== undefined) target.baseUrl = ep.baseUrl;
        if (ep.name !== undefined) target.name = ep.name;
      }
    }

    await this.configManager.write(config);
  }
}
