/**
 * DesktopApp — 主进程应用根（面向对象单根），**瘦客户端**形态。
 *
 * 这个进程现在只做四件事：窗口、原生对话框、IPC 转发、把服务端事件转给 render。
 * 会话执行（Agent / 模型 / 工具 / 存档）全部在常驻的 `agents-server` 那边，本进程
 * 一条连接过去、按协议调方法（`server/` 这一层）。
 *
 * 组装是显式手写 DI（无反射/扫描）：`createServerLayer()` 拿走的全是**非 electron 的
 * 事实**（配置根、握手身份、默认工作目录、事件出口），electron 的东西（`app.getPath`、
 * `dialog`、`webContents.send`）只出现在本文件里，以参数/回调的形式递进去 —— 那条边界
 * 就是「服务端门面能被 vitest + 真 daemon 直接验」的前提。
 *
 * ## 「当前连着哪一层」不在本文件
 *
 * 以前这里是 `private readonly server = createServerLayer({…})`：字段初始化，永远一份，换连接
 * 只能重启 App。现在换成 `ConnectionController`（`connection/controller.ts`）：它同样只拿
 * 非 electron 的事实（全部注入），于是「先落盘再换层」那套顺序能拿假层单测咬死；本文件只负责
 * 把 electron 的三个事实递进去（含状态推送与计时器），并在 IPC 里认领五条连接通道。
 *
 * ## 启动顺序：**窗口先出来，连接放后面**（D25）
 *
 * 这一段的顺序是本文件唯一必须按字面读的东西：
 *
 * ```
 * await app.whenReady()
 * nativeTheme / Menu
 * registerIpc()                 ← 仍要早于窗口：render 一挂载就会 invoke
 * createMainWindow()            ← 窗口先出来（它曾经在连接之后，见下）
 * void this.connection.start()  ← 后台连，**不 await**
 * ```
 *
 * 改动前的顺序是「先 await 连接 → 再建窗口」，而那个 await 没有 try/catch：远程服务端在
 * 启动时不可达 ⇒ `start()` rejects ⇒ 后面两行都不执行 ⇒ **窗口根本不出现**，用户看到的是
 * 「双击没反应」，而「改回本地」的设置页就在那个不存在的窗口里 —— 只能手删 `connection.json`。
 *
 * 现在连接在窗口之后、且在后台跑：连不上是**窗口里的一件事**（`ConnectionState` 的
 * `connecting` / `error` 加上「重连」按钮），不再是「应用没起来」。`start()` 的 promise 自己
 * 带 `.catch`（不浮空、不冒到顶），失败只记日志 + 交给状态机。
 */


import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme } from "electron";
import { join } from "path";
import { fileURLToPath } from "url";
import { AI_ZEN_DIR } from "./config.js";
import { ConnectionController } from "./connection/controller.js";
import { readSettings, writeSettings } from "./connection/settings.js";
import { createServerLayer } from "./server/index.js";
import type { ChatStreamEvent, ConnectionSettings, ConnectionState } from "@ai-zen/desktop-shared";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

export class DesktopApp {
  // ==================== 服务端门面（唯一的业务出口） ====================
  /**
   * 「此刻连着哪一层」全在这一个对象里（D21）：`local` / `remote` 的切换是**换层**（dispose 旧
   * 的 → 建新的 → start），不是改一个字段。`layer()` 给 IPC 转发，`save()` 换掉它。
   */
  private readonly connection = new ConnectionController({
    aiZenDir: AI_ZEN_DIR,
    clientInfo: { name: "@ai-zen/desktop", version: app.getVersion() },
    // 用户不填工作目录时的默认值：桌面端就是"桌面"，这是 electron 的事实，注入进去
    defaultCwd: () => app.getPath("desktop"),
    push: (event) => this.pushChatEvent(event),
    // 建层仍是 `server/` 那一层的事，本文件只做组装
    createLayer: (options) => createServerLayer(options),
    // 连接设置落在 `<AI_ZEN_DIR>/desktop/connection.json`（D17），路径拼法在 settings 里
    readSettings: () => readSettings(AI_ZEN_DIR),
    writeSettings: (settings) => writeSettings(AI_ZEN_DIR, settings),
    // 状态变化 → 推给 render（`connection:state`，与查询同名：`subscribeServiceEvent(channel)`
    // 于是对「查一次」与「听变化」是同一个名字）。窗口还没建时这里是个空操作，
    // 那一段的真相由 `connection:state` 的查询补上（D26 说了为什么两条都要有）
    onStateChange: (state) => this.pushConnectionState(state),
  });

  // ==================== 运行状态 ====================
  private mainWindow: BrowserWindow | null = null;
  /** 目录选择器记住的上次位置（默认桌面） */
  private lastSelectedDir: string | null = null;

  /**
   * 启动：就绪 → 注册 IPC → 窗口先出来 → 连接放后面（后台跑）→ 绑定生命周期。
   *
   * 顺序与理由见文件头（D25）。这里只剩一个必须口述的点：`connection.start()` 的 promise
   * **自己 catch**（不浮空、不冒到顶）。它其实不会 reject（失败由状态机接住并进重试），
   * 这一道是兜底 —— 启动路径上任何一处失败都只该变成一行日志，而不是「双击没反应」。
   */
  async start(): Promise<void> {
    await app.whenReady();

    // 窗口外观跟随系统设置 + 去掉默认菜单栏
    nativeTheme.themeSource = "system";
    Menu.setApplicationMenu(null);

    // IPC 先注册：render 一挂载就会 `invokeService`，晚一步就是「界面上什么都没有」
    this.registerIpc();

    // 窗口先出来：远程不可达时它也一样出现（连不上的事交给窗口里的状态，不是交给启动失败）
    this.createMainWindow();

    // 连接放后面、且**不 await**：结果靠 `connection:state` 的推送 + 查询
    void this.connection.start().catch((error: unknown) => {
      console.error(`连接启动失败（状态由 ConnectionController 记录）：${String(error)}`);
    });

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
    // 退出前断开连接（服务端是常驻的，不跟着桌面端退出）；顺手清掉挂起的重试计时器
    app.on("will-quit", () => {
      this.connection.dispose();
    });
  }

  // ==================== 事件推送 ====================

  private pushChatEvent(evt: ChatStreamEvent): void {
    this.mainWindow?.webContents.send("chat:push", evt);
  }

  /**
   * 连接状态 → render（`connection:state`，与查询通道同名）。
   *
   * 窗口还没建时是空操作：那一段的真相由 `connection:state` 的**查询**补上 —— 窗口挂载时
   * 先查一次，之后再听这条推送（D26 说的就是这个组合）。
   */
  private pushConnectionState(state: ConnectionState): void {
    this.mainWindow?.webContents.send("connection:state", state);
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

  // ==================== IPC ====================
  private registerIpc(): void {
    // 业务服务动态分发（分发键：workspace / conversation / agent / model / chat / config）
    ipcMain.handle(
      "invokeService",
      (_event, service: string, method: string, ...args: unknown[]) =>
        this.connection.layer().manager.invokeService(service, method, ...args),
    );

    // 连接设置（本地 / 远程）：五条**专用**通道，**不进** `invokeService` 的 service 表（D20）。
    // 那六个分发键 = 服务端的方法表，而「连哪台服务端」在服务端还不存在的时候就要回答
    // （先有鸡先有蛋）—— 混进去会让「六个键 = 服务端调用面」这条边界失效。
    ipcMain.handle("connection:get", () => this.connection.get());
    ipcMain.handle("connection:save", (_event, settings: ConnectionSettings) =>
      this.connection.save(settings),
    );
    ipcMain.handle(
      "connection:test",
      (_event, candidate: { serverUrl: string; serverToken?: string }) =>
        this.connection.test(candidate),
    );
    // 状态查询：窗口可能比第一次状态变化更晚挂载（D25 之后这是常态），光靠推送会漏
    ipcMain.handle("connection:state", () => this.connection.state());
    // 手动重试：清掉挂起的计时器、attempt 归零、立刻再试一轮；返回进入 connecting 的那一瞬
    ipcMain.handle("connection:reconnect", () => this.connection.reconnect());

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
