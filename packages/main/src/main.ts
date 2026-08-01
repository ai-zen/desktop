/**
 * Desktop 主进程入口（骨架）
 *
 * 当前仅保留：窗口生命周期、窗口控制 IPC、数据目录初始化。
 * 业务部分（Workspace/Conversation/Chat 服务、Provider 池、事件推送）按
 * docs/desktop-design.md 的实现顺序逐步接入。
 */

import { app, BrowserWindow, ipcMain, Menu, nativeTheme } from "electron";
import { join } from "path";
import { fileURLToPath } from "url";
import { existsSync, mkdirSync } from "fs";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

// 数据目录（存储骨架，业务实现时使用）
const AI_ZEN_DIR = process.env.AI_ZEN_DIR || join(app.getPath("home"), ".ai-zen");
const DESKTOP_DIR = join(AI_ZEN_DIR, "desktop");

function ensureDataDirs() {
  if (!existsSync(DESKTOP_DIR)) {
    mkdirSync(DESKTOP_DIR, { recursive: true });
  }
}

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

app.whenReady().then(() => {
  ensureDataDirs();

  // 窗口外观跟随系统设置
  nativeTheme.themeSource = "system";

  // 去掉默认菜单栏
  Menu.setApplicationMenu(null);

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
