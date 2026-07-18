import { app, BrowserWindow, ipcMain } from "electron";
import { join } from "path";
import { fileURLToPath } from "url";
import { servicesManager } from "./modules/servicesManager.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (process.env.NODE_ENV === "development") {
    win.loadURL("http://localhost:5173");
    win.webContents.openDevTools();
  } else {
    win.loadFile(join(__dirname, "static", "index.html"));
  }

  return win;
}

app.whenReady().then(async () => {
  // 注册通用 IPC handler
  ipcMain.handle("invoke", (_event, service: string, method: string, ...args: unknown[]) => {
    return servicesManager.invoke(service, method, ...args);
  });

  // 初始化服务
  await servicesManager.init();

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
