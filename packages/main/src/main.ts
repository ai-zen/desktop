/**
 * Desktop 主进程入口。
 *
 * 已接入：Workspace / Agent / Model 服务（invokeService 动态分发）。
 * 待接入：Conversation / Chat 服务（Provider 池、流式推送）。
 */

import { app, BrowserWindow, ipcMain, Menu, nativeTheme } from "electron";
import { join } from "path";
import { fileURLToPath } from "url";
import { existsSync, mkdirSync } from "fs";
import { AgentRepository, ConfigManager } from "@ai-zen/agents-sdk";
import { AGENTS_DIR, AI_ZEN_DIR, CONFIG_FILE, CONVERSATIONS_DIR, DESKTOP_DIR, WORKSPACES_DIR } from "./config.js";
import { WorkspaceRepository } from "./storage/WorkspaceRepository.js";
import { ConversationRepository } from "./storage/ConversationRepository.js";
import { WorkspaceService } from "./services/WorkspaceService.js";
import { ConversationService } from "./services/ConversationService.js";
import { AgentService } from "./services/AgentService.js";
import { ModelService } from "./services/ModelService.js";
import { ChatService } from "./services/ChatService.js";
import { ProviderPool } from "./services/ProviderPool.js";
import { ServicesManager } from "./services/ServicesManager.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

function ensureDataDirs() {
  if (!existsSync(DESKTOP_DIR)) {
    mkdirSync(DESKTOP_DIR, { recursive: true });
  }
}

// ==================== 服务组装（手动 DI） ====================

const configManager = new ConfigManager(CONFIG_FILE);
const agentRepository = new AgentRepository(AGENTS_DIR);

/** 当前主窗口（创建后赋值，用于向 render 推送 chat:push 事件） */
let mainWindow: BrowserWindow | null = null;

const servicesManager = new ServicesManager({
  workspace: new WorkspaceService(new WorkspaceRepository(WORKSPACES_DIR)),
  conversation: new ConversationService(
    new ConversationRepository(CONVERSATIONS_DIR),
    agentRepository,
    configManager,
  ),
  agent: new AgentService(agentRepository),
  model: new ModelService(configManager),
  chat: new ChatService(
    new WorkspaceRepository(WORKSPACES_DIR),
    new ConversationRepository(CONVERSATIONS_DIR),
    new ProviderPool(configManager, AGENTS_DIR, AI_ZEN_DIR),
    (evt) => mainWindow?.webContents.send("chat:push", evt),
  ),
});

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    frame: false,
    backgroundMaterial: "mica",
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (process.env.NODE_ENV === "development") {
    win.loadURL("http://localhost:5173");
    win.webContents.openDevTools({ mode: "detach" });
  } else {
    win.loadFile(join(__dirname, "static", "index.html"));
  }

  return win;
}

app.whenReady().then(async () => {
  ensureDataDirs();

  // 初始化共享配置目录 + 默认 Agent / SubAgent（已有文件不覆盖）
  await configManager.bootstrap();

  // 窗口外观跟随系统设置
  nativeTheme.themeSource = "system";

  // 去掉默认菜单栏
  Menu.setApplicationMenu(null);

  // ==================== 业务服务 IPC ====================
  ipcMain.handle(
    "invokeService",
    (_event, service: string, method: string, ...args: unknown[]) =>
      servicesManager.invokeService(service, method, ...args),
  );

  // ==================== 窗口控制 IPC ====================
  ipcMain.handle("window:minimize", (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize();
  });

  ipcMain.handle("window:maximize", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win?.isMaximized()) {
      win.unmaximize();
    } else {
      win?.maximize();
    }
  });

  ipcMain.handle("window:close", (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close();
  });

  ipcMain.handle("window:isMaximized", (event) => {
    return BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false;
  });

  // ==================== 创建窗口 ====================
  const mainWin = createMainWindow();
  mainWindow = mainWin;

  // 监听窗口最大化/还原变化，通知渲染进程更新按钮图标
  mainWin.on("maximize", () => {
    mainWin.webContents.send("window:maximizeChange", true);
  });
  mainWin.on("unmaximize", () => {
    mainWin.webContents.send("window:maximizeChange", false);
  });
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createMainWindow();
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
