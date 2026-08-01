/**
 * main 路径常量 — 与 CLI 共享 ~/.ai-zen 根目录。
 *
 * 目录结构：
 *   ~/.ai-zen/
 *   ├── config.json        ← 全局配置（端点、模型等，CLI/Desktop 共享）
 *   ├── agents/            ← Agent 定义（共享）
 *   └── desktop/           ← Desktop 运行时数据
 *       └── workspaces/    ← 工作空间（每 workspace 一个 JSON 文件）
 */

import { app } from "electron";
import { join } from "path";

export const AI_ZEN_DIR = process.env.AI_ZEN_DIR || join(app.getPath("home"), ".ai-zen");
export const CONFIG_FILE = join(AI_ZEN_DIR, "config.json");
export const AGENTS_DIR = join(AI_ZEN_DIR, "agents");

export const DESKTOP_DIR = join(AI_ZEN_DIR, "desktop");
export const WORKSPACES_DIR = join(DESKTOP_DIR, "workspaces");
export const CONVERSATIONS_DIR = join(DESKTOP_DIR, "conversations");
