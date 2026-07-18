import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { BrowserWindow } from "electron";
import type { ServiceContext } from "../servicesManager.js";
import type { Conversation, Message } from "@ai-zen/desktop-shared";
import type { SdkAgent } from "@ai-zen/agents-sdk";

const DESKTOP_DIR = join(
  process.env.AI_ZEN_DIR || join(process.env.HOME || process.env.USERPROFILE || "", ".ai-zen"),
  "desktop",
);
const CONVERSATIONS_DIR = join(DESKTOP_DIR, "conversations");

export class ChatService {
  /** 活跃的对话 Agent 实例缓存 */
  private activeAgents = new Map<string, SdkAgent>();

  constructor(private context: ServiceContext) {}

  async send(conversationId: string, content: string): Promise<void> {
    const filePath = join(CONVERSATIONS_DIR, `${conversationId}.json`);
    if (!existsSync(filePath)) throw new Error(`Conversation '${conversationId}' not found`);

    const conv: Conversation = JSON.parse(readFileSync(filePath, "utf-8"));

    let agent = this.activeAgents.get(conversationId);
    if (!agent) {
      const { createAgent: sdkCreateAgent } = await import("@ai-zen/agents-sdk");
      agent = sdkCreateAgent(this.context.provider, conv.agentId || "default");
      agent.messages.push(...conv.messages.map((m) => ({
        role: m.role as any,
        content: m.content,
      })));
      this.activeAgents.set(conversationId, agent);

      agent.events.on("chunk", (chunk: any) => {
        const win = BrowserWindow.getAllWindows()[0];
        win?.webContents.send("chat:chunk", { conversationId, chunk });
      });
    }

    const userMsg: Message = {
      id: `msg-${Date.now()}`,
      role: "user",
      content,
      createdAt: new Date().toISOString(),
    };
    conv.messages.push(userMsg);

    await agent.send(content);

    writeFileSync(filePath, JSON.stringify(conv, null, 2), "utf-8");
  }
}
