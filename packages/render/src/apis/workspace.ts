/**
 * workspace api — 工作空间（对应 main WorkspaceService）。
 */

import type { Workspace } from "@ai-zen/desktop-shared";
import { invokeService } from "./base.js";

export function listWorkspaces(): Promise<Workspace[]> {
  return invokeService("workspace", "list");
}

export function createWorkspace(input: {
  name: string;
  cwd: string;
}): Promise<Workspace> {
  return invokeService("workspace", "create", input.name, input.cwd);
}

export function renameWorkspace(id: string, name: string): Promise<void> {
  return invokeService("workspace", "rename", id, name);
}

export function removeWorkspace(id: string): Promise<void> {
  return invokeService("workspace", "remove", id);
}
