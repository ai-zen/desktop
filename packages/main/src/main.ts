/**
 * 主进程入口 — 只做启动：所有状态/服务/行为封装在 DesktopApp（见 app.ts）。
 *
 * `start()` 的 promise 不浮空：启动路径上失败（`whenReady` 之后、注册 IPC、建窗口）时，
 * 唯一正确的表现是**一行日志**，而不是 Electron 那边一条 unhandled rejection ——
 * 「双击没反应」是最难查的一种症状，日志至少能指出它没起来。
 * 连接本身不在这条链上（它自己 catch，见 `app.ts` 的启动顺序）。
 */

import { DesktopApp } from "./app.js";

void new DesktopApp()
  .start()
  .catch((error: unknown) => {
    console.error(`桌面端启动失败：${String(error)}`);
  });
