/**
 * DesktopApp — 主进程应用根（面向对象单根）。
 *
 * 所有 main 端状态与行为收拢于此对象：
 *   - 基础设施：ConfigManager / Repositories / ProviderPool
 *   - 服务：Workspace / Conversation / Agent / Model / Chat（+ ServicesManager 分发）
 *   - 运行状态：主窗口引用、目录选择记忆
 * main.ts 只做入口：`new DesktopApp().start()`。
 *
 * 组装是显式手写 DI（无反射/扫描）：依赖通过构造函数注入，跨服务协作
 * （删除会话 → 释放运行中 agent）用构造钩子显式声明，不隐藏。
 */

import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme } from "electron";
import { join } from "path";
import { fileURLToPath } from "url";
import { existsSync, mkdirSync } from "fs";
import { AgentRepository, ConfigManager } from "@ai-zen/agents-sdk";
import { AGENTS_DIR, AI_ZEN_DIR, CONFIG_FILE, DESKTOP_DIR } from "./config.js";
import { WorkspaceRepository } from "./storage/WorkspaceRepository.js";
import { ConversationRepository } from "./storage/ConversationRepository.js";
import { WorkspaceService } from "./services/WorkspaceService.js";
import { ConversationService } from "./services/ConversationService.js";
import { AgentService } from "./services/AgentService.js";
import { ModelService } from "./services/ModelService.js";
import { ChatService } from "./services/ChatService.js";
import { ProviderPool } from "./services/ProviderPool.js";
import { ServicesManager } from "./services/ServicesManager.js";
import type { ChatStreamEvent } from "@ai-zen/desktop-shared";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

export class DesktopApp {
  // ==================== 基础设施 ====================
  private readonly configManager = new ConfigManager(CONFIG_FILE);
  private readonly agentRepository = new AgentRepository(AGENTS_DIR);
  private readonly workspaceRepository = new WorkspaceRepository();
  private readonly conversationRepository = new ConversationRepository();
  private readonly providerPool = new ProviderPool(
    this.configManager,
    AGENTS_DIR,
    AI_ZEN_DIR,
  );

  // ==================== 服务 ====================
  private readonly agentService = new AgentService(this.agentRepository);
  private readonly modelService = new ModelService(this.configManager);
  private readonly chatService: ChatService;
  private readonly workspaceService: WorkspaceService;
  private readonly conversationService: ConversationService;
  private readonly servicesManager: ServicesManager;

  // ==================== 运行状态 ====================
  private mainWindow: BrowserWindow | null = null;
  /** 目录选择器记住的上次位置（默认桌面） */
  private lastSelectedDir: string | null = null;

  constructor() {
    this.chatService = new ChatService({
      workspaceRepo: this.workspaceRepository,
      conversationRepo: this.conversationRepository,
      providers: this.providerPool,
      push: (evt) => this.pushChatEvent(evt),
    });

    // 删除会话/工作空间 → 释放其运行中的 agent（钩子注入，删除联动显式化）
    this.conversationService = new ConversationService(
      this.conversationRepository,
      this.agentRepository,
      this.configManager,
      { onRemove: (_wsId, id) => this.chatService.release(id) },
    );
    this.workspaceService = new WorkspaceService(
      this.workspaceRepository,
      () => app.getPath("desktop"),
      this.conversationRepository,
      { onRemove: (id) => this.chatService.releaseWorkspace(id) },
    );

    this.servicesManager = new ServicesManager({
      workspace: this.workspaceService,
      conversation: this.conversationService,
      agent: this.agentService,
      model: this.modelService,
      chat: this.chatService,
    });
  }

  /** 启动：就绪 → 初始化 → 注册 IPC → 创建窗口 → 绑定生命周期 */
  async start(): Promise<void> {
    await app.whenReady();

    this.ensureDataDirs();
    // 初始化共享配置目录 + 默认 Agent / SubAgent（已有文件不覆盖）
    await this.configManager.bootstrap();

    // 窗口外观跟随系统设置 + 去掉默认菜单栏
    nativeTheme.themeSource = "system";
    Menu.setApplicationMenu(null);

    this.registerIpc();
    this.createMainWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        this.createMainWindow();
      }
    });
    app.on("window-all-closed", () => {
      if (process.platform !== "darwin") {
        app.quit();
      }
    });
  }

  // ==================== 事件推送（render 订阅 chat:push） ====================
  private pushChatEvent(evt: ChatStreamEvent): void {
    this.mainWindow?.webContents.send("chat:push", evt);
  }

  // ==================== 窗口 ====================
  private createMainWindow(): void {
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
    this.mainWindow = win;

    if (process.env.NODE_ENV === "development") {
      win.loadURL("http://localhost:5173");
      win.webContents.openDevTools({ mode: "detach" });
    } else {
      win.loadFile(join(__dirname, "static", "index.html"));
    }

    // 最大化/还原变化 → 通知渲染进程更新按钮图标
    win.on("maximize", () => {
      win.webContents.send("window:maximizeChange", true);
    });
    win.on("unmaximize", () => {
      win.webContents.send("window:maximizeChange", false);
    });
    // 窗口销毁后清引用，避免 chat:push 发到已销毁窗口
    win.on("closed", () => {
      if (this.mainWindow === win) this.mainWindow = null;
    });
  }

  private ensureDataDirs(): void {
    if (!existsSync(DESKTOP_DIR)) {
      mkdirSync(DESKTOP_DIR, { recursive: true });
    }
  }

  // ==================== IPC ====================
  private registerIpc(): void {
    // 业务服务动态分发
    ipcMain.handle(
      "invokeService",
      (_event, service: string, method: string, ...args: unknown[]) =>
        this.servicesManager.invokeService(service, method, ...args),
    );

    // 窗口控制
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

    // 原生目录选择器
    ipcMain.handle("dialog:selectDirectory", async (event) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win) return null;
      const result = await dialog.showOpenDialog(win, {
        title: "选择工作空间目录",
        defaultPath: this.lastSelectedDir ?? app.getPath("desktop"),
        properties: ["openDirectory", "createDirectory"],
      });
      if (result.canceled || result.filePaths.length === 0) return null;
      this.lastSelectedDir = result.filePaths[0];
      return this.lastSelectedDir;
    });
  }
}
