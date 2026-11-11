import { contextBridge, ipcRenderer } from "electron/renderer";
import type { ConnectionSettings } from "@ai-zen/desktop-shared";

contextBridge.exposeInMainWorld("electronAPI", {
  invokeService: (service: string, method: string, ...args: unknown[]) =>
    ipcRenderer.invoke("invokeService", service, method, ...args),

  on: (channel: string, callback: (...args: unknown[]) => void) => {
    ipcRenderer.on(channel, (_event, ...args) => callback(...args));
  },

  off: (channel: string, callback: (...args: unknown[]) => void) => {
    ipcRenderer.removeListener(channel, callback);
  },

  // 原生目录选择器（默认桌面，记住上次选择）
  selectDirectory: () => ipcRenderer.invoke("dialog:selectDirectory"),

  // 窗口控制
  window: {
    minimize: () => ipcRenderer.invoke("window:minimize"),
    maximize: () => ipcRenderer.invoke("window:maximize"),
    close: () => ipcRenderer.invoke("window:close"),
    isMaximized: () => ipcRenderer.invoke("window:isMaximized"),
  },

  /**
   * 连接设置（本地 / 远程）—— 五条**专用**通道，与 `invokeService` 那张服务表无关。
   *
   * 为什么不是 `invokeService("connection", "get")`：那张表的六个键是**服务端的方法**
   * （协议一一对应），而「连哪台服务端」在服务端还不存在的时候就要回答（先有鸡先有蛋）。
   * 混进去会让「六个键 = 服务端调用面」这条边界失效，而且它根本没法被转发 —— 转发要一条
   * 连着的服务端，而它正是决定连哪条的那一个。
   *
   * 语义（校验、落盘、换层顺序、试连、状态机与重试）全在 main 的 `ConnectionController` 里，
   * 这里只过一手。
   *
   * `state` / `reconnect` 是这一批新加的两条（D26）：
   *
   *   · `state()` —— **查询**当前状态。窗口现在比连接先出来，它挂载的那一刻可能已经错过了
   *     一次状态变化，光靠推送会漏，所以查询必须存在；
   *   · `reconnect()` —— 手动重试一次（`error` 态下那个按钮）。它立刻返回进入 `connecting`
   *     之后的那一瞬状态，整轮在后台跑（最多 8 秒），后续变化走推送。
   *
   * 推送复用上面那对通用的 `on` / `off`：通道名就叫 `connection:state`（与查询同名，
   * `on("connection:state", …)` 听的就是它）。
   */
  connection: {
    get: () => ipcRenderer.invoke("connection:get"),
    save: (settings: ConnectionSettings) => ipcRenderer.invoke("connection:save", settings),
    test: (candidate: { serverUrl: string; serverToken?: string }) =>
      ipcRenderer.invoke("connection:test", candidate),
    state: () => ipcRenderer.invoke("connection:state"),
    reconnect: () => ipcRenderer.invoke("connection:reconnect"),
  },
});
