import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import type { ServiceContext } from "../servicesManager.js";
import type { Workspace } from "@ai-zen/desktop-shared";

const DESKTOP_DIR = join(
  process.env.AI_ZEN_DIR || join(process.env.HOME || process.env.USERPROFILE || "", ".ai-zen"),
  "desktop",
);
const WORKSPACES_FILE = join(DESKTOP_DIR, "workspaces.json");

export class WorkspaceService {
  constructor(private context: ServiceContext) {}

  private ensureDir() {
    if (!existsSync(DESKTOP_DIR)) mkdirSync(DESKTOP_DIR, { recursive: true });
  }

  private read(): Workspace[] {
    this.ensureDir();
    if (!existsSync(WORKSPACES_FILE)) return [];
    return JSON.parse(readFileSync(WORKSPACES_FILE, "utf-8"));
  }

  private write(workspaces: Workspace[]): void {
    this.ensureDir();
    writeFileSync(WORKSPACES_FILE, JSON.stringify(workspaces, null, 2), "utf-8");
  }

  list(): Workspace[] {
    return this.read();
  }

  add(name: string, path?: string): Workspace[] {
    const workspaces = this.read();
    const id = name.replace(/[\\/:*?"<>|]/g, "_");
    workspaces.push({ id, name, path: path || "" });
    this.write(workspaces);
    return workspaces;
  }

  remove(id: string): Workspace[] {
    const workspaces = this.read().filter((w) => w.id !== id);
    this.write(workspaces);
    return workspaces;
  }
}
