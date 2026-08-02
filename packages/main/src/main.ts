/**
 * 主进程入口 — 只做启动：所有状态/服务/行为封装在 DesktopApp（见 app.ts）。
 */

import { DesktopApp } from "./app.js";

new DesktopApp().start();
