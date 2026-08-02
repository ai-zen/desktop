/**
 * Provider 池 — 每 workspace 一个 Provider（cwd 注入），懒加载 + 缓存。
 *
 * 对应 render 的 apis/chat.ts，是 ChatService 的底层支撑。
 * 能力发现路径：workspace.cwd 下的项目级 + ~/.ai-zen 共享级。
 */

import { access } from "node:fs/promises";
import { join } from "node:path";
import { ConfigManager, Provider } from "@ai-zen/agents-sdk";
import type { Workspace } from "@ai-zen/desktop-shared";

export class ProviderPool {
  private providers = new Map<string, Promise<Provider>>();

  constructor(
    private configManager: ConfigManager,
    private agentsDir: string,
    private aiZenDir: string,
  ) {}

  get(workspace: Workspace): Promise<Provider> {
    let provider = this.providers.get(workspace.id);
    if (!provider) {
      provider = this.create(workspace);
      this.providers.set(workspace.id, provider);
    }
    return provider;
  }

  private async create(workspace: Workspace): Promise<Provider> {
    const cwd = workspace.cwd;
    const project = (...sub: string[]) => join(cwd, ...sub);
    const shared = (sub: string) => join(this.aiZenDir, sub);
    const userAgentsDir = join(
      process.env.HOME || process.env.USERPROFILE || "",
      ".agents",
    );

    /** 过滤出存在的路径（异步 fs.access） */
    const existing = async (paths: string[]): Promise<string[]> => {
      const checked = await Promise.all(
        paths.map(async (p) => {
          try {
            await access(p);
            return p;
          } catch {
            return null;
          }
        }),
      );
      return checked.filter((p): p is string => p !== null);
    };

    // MCP 配置优先级：项目 > 共享
    const mcpPaths = await existing([
      project(".mcp.json"),
      project(".ai-zen", "mcp.json"),
      project(".agents", "mcp.json"),
      shared("mcp.json"),
      join(userAgentsDir, "mcp.json"),
    ]);

    // Skills 目录优先级：项目 > 共享
    const skillsPaths = await existing([
      project(".ai-zen", "skills"),
      project(".agents", "skills"),
      shared("skills"),
      join(userAgentsDir, "skills"),
    ]);

    const subAgentsPaths = await existing([
      project(".ai-zen", "sub-agents"),
      shared("sub-agents"),
    ]);

    const toolsPaths = await existing([
      project(".ai-zen", "tools"),
      shared("tools"),
    ]);

    const config = await this.configManager.read();

    return Provider.create({
      config,
      agentsDir: this.agentsDir,
      subAgentsPaths,
      skillsPaths,
      toolsPaths,
      mcpPaths,
      cwd,
    });
  }
}
