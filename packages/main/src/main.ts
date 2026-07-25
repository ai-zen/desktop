import { app, BrowserWindow, ipcMain, Menu, nativeTheme } from "electron";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { existsSync, mkdirSync } from "fs";
import { servicesManager } from "./modules/servicesManager.js";
import { ConfigManager, Provider } from "@ai-zen/agents-sdk";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

// 数据目录
const AI_ZEN_DIR = process.env.AI_ZEN_DIR || join(app.getPath("home"), ".ai-zen");
const DESKTOP_DIR = join(AI_ZEN_DIR, "desktop");

function ensureDataDirs() {
  if (!existsSync(DESKTOP_DIR)) {
    mkdirSync(DESKTOP_DIR, { recursive: true });
  }
}

function createProvider(): Provider {
  // 初始化 ConfigManager（读取 ~/.ai-zen/config.json）
  const configManager = new ConfigManager(join(AI_ZEN_DIR, "config.json"));
  const { config } = configManager.bootstrap();

  return new Provider({
    config,
    agentsDir: join(AI_ZEN_DIR, "agents"),
    subAgentsPaths: [join(AI_ZEN_DIR, "sub-agents")],
    skillsPaths: [join(AI_ZEN_DIR, "skills")],
    toolsPaths: [join(AI_ZEN_DIR, "tools")],
    mcpPaths: [join(AI_ZEN_DIR, "mcp.json")],
    conversationsDir: join(DESKTOP_DIR, "conversations"),
    draftsDir: join(DESKTOP_DIR, "drafts"),
  });
}

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
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

  // 窗口外观跟随系统设置
  nativeTheme.themeSource = "system";

  // 去掉默认菜单栏
  Menu.setApplicationMenu(null);

  // 注册通用 IPC handler
  ipcMain.handle("invoke", (_event, service: string, method: string, ...args: unknown[]) => {
    return servicesManager.invoke(service, method, ...args);
  });

  // 初始化服务（传入 Provider）
  const provider = createProvider();
  await servicesManager.init(provider);

  createMainWindow();
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
