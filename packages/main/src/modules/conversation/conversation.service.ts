import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import type { ServiceContext } from "../servicesManager.js";
import type { Conversation, ConversationSummary } from "@ai-zen/desktop-shared";

const DESKTOP_DIR = join(
  process.env.AI_ZEN_DIR || join(process.env.HOME || process.env.USERPROFILE || "", ".ai-zen"),
  "desktop",
);
const CONVERSATIONS_DIR = join(DESKTOP_DIR, "conversations");
const INDEX_FILE = join(DESKTOP_DIR, "conversations-index.json");

interface IndexEntry {
  id: string;
  workspaceId: string;
  agentId: string;
  name: string;
  messageCount: number;
  updatedAt: string;
}

export class ConversationService {
  private indexCache: IndexEntry[] | null = null;

  constructor(private context: ServiceContext) {}

  private ensureDir() {
    if (!existsSync(CONVERSATIONS_DIR)) mkdirSync(CONVERSATIONS_DIR, { recursive: true });
  }

  private readIndex(): IndexEntry[] {
    this.ensureDir();
    if (this.indexCache) return this.indexCache;
    if (!existsSync(INDEX_FILE)) return [];
    this.indexCache = JSON.parse(readFileSync(INDEX_FILE, "utf-8"));
    return this.indexCache!;
  }

  private writeIndex(index: IndexEntry[]): void {
    this.ensureDir();
    this.indexCache = index;
    writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2), "utf-8");
  }

  list(workspaceId: string): ConversationSummary[] {
    return this.readIndex()
      .filter((e) => e.workspaceId === workspaceId)
      .map(({ id, workspaceId, agentId, name, messageCount, updatedAt }) => ({
        id, workspaceId, agentId, name, messageCount, updatedAt,
      }));
  }

  create(workspaceId: string, agentId: string, name?: string): string {
    const id = `conv-${Date.now()}`;
    const now = new Date().toISOString();
    const conv: Conversation = {
      id, workspaceId, agentId, modelId: "",
      name: name || `对话_${now.slice(0, 10)}`,
      messages: [], createdAt: now, updatedAt: now,
    };

    this.ensureDir();
    writeFileSync(join(CONVERSATIONS_DIR, `${id}.json`), JSON.stringify(conv, null, 2), "utf-8");

    const index = this.readIndex();
    index.push({
      id, workspaceId, agentId, name: conv.name, messageCount: 0, updatedAt: now,
    });
    this.writeIndex(index);

    return id;
  }

  get(id: string): Conversation | null {
    const filePath = join(CONVERSATIONS_DIR, `${id}.json`);
    if (!existsSync(filePath)) return null;
    return JSON.parse(readFileSync(filePath, "utf-8"));
  }
}
