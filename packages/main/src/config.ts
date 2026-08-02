/**
 * main 路径常量 — 与 CLI 共享 ~/.ai-zen 根目录。
 *
 * 目录结构：
 *   ~/.ai-zen/
 *   ├── config.json        ← 全局配置（端点、模型等，CLI/Desktop 共享）
 *   ├── agents/            ← Agent 定义（共享）
 *   └── desktop/           ← Desktop 运行时数据
 *       └── ai-zen.db      ← 主存储（SQLite：workspaces + conversations）
 */

import { app } from "electron";
import { join } from "path";

export const AI_ZEN_DIR = process.env.AI_ZEN_DIR || join(app.getPath("home"), ".ai-zen");
export const CONFIG_FILE = join(AI_ZEN_DIR, "config.json");
export const AGENTS_DIR = join(AI_ZEN_DIR, "agents");

export const DESKTOP_DIR = join(AI_ZEN_DIR, "desktop");
/** 主存储 SQLite 文件路径（由 DesktopApp 单根创建 Database 实例） */
export const DB_FILE = join(DESKTOP_DIR, "ai-zen.db");
