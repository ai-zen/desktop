/**
 * 服务端门面的组装根 —— 六个 Service + 事件翻译器 + 那一条常驻连接。
 *
 * ## 为什么组装写在这里而不是 `app.ts`
 *
 * `app.ts` 是 Electron 的组装根（窗口、IPC、原生对话框）。这一层要能被 vitest + 真
 * daemon 直接验，就不能碰 electron，也不该被 electron 的细节污染 —— 于是它需要一个
 * **自己的入口**：调用方只递进来四样非 electron 的事实（配置根、握手身份、默认工作目录、
 * 事件出口），拿回一个 `ServicesManager` 和一对 `start/dispose`。
 *
 * 依赖注入是显式手写的：要连哪台服务端、默认目录取哪、事件往哪推，全在参数里看得见，
 * 没有隐式全局。
 *
 * ## 连接只在**这里**建一次，但「一条」不等于「永远那一条」
 *
 * 一个进程一条连接（`ServerConnection`，来自 `@ai-zen/agents-client` 的
 * `transport/connection.ts`）。本文件只组装它一次、`dispose()` 时关掉它；**它死了之后怎么
 * 长回来是它自己的事**：每次取用都判 `closed`、断了重建、并在新连接上重放 `events.watch`。
 *
 * 本层以前自己实现过那点逻辑（缓存在 `pending ??=`、建成后不复查 `closed`），代价写在
 * `daemon 重启 → 桌面端永久失能` 那次事故里：所有 IPC 一律 `client is closed`，而界面上看
 * 起来只是「没反应」（没有重连、没有提示、也没有错误）。所以这件事不该有第二份实现 ——
 * 它归包里那一个，本仓只负责组装与收摊。
 *
 * ## 组装根为什么不需要再判一次「要不要重建」
 *
 * 「连的是哪台服务端」由**发现文件**回答（`<aiZenDir>/run/server.json`）：重启后的服务端
 * 会把它换成新端口，`ensureServer` 于是自然连到新的那个。本层不缓存端口、也不记 pid。
 */

import type { ClientInfo } from "@ai-zen/agents-client";
import { ServerConnection } from "@ai-zen/agents-client";
import type { ChatStreamEvent } from "@ai-zen/desktop-shared";
import { ServicesManager } from "./ServicesManager.js";
import { protocolCall } from "./call.js";
import { ChatEventBridge } from "./events.js";
import {
  ServerAgentService,
  ServerChatService,
  ServerConfigService,
  ServerConversationService,
  ServerModelService,
  ServerWorkspaceService,
} from "./services.js";

export interface ServerLayerOptions {
  /** 配置根目录（`AI_ZEN_DIR`）：服务发现文件在工作它下面（`run/server.json`） */
  aiZenDir: string;
  /** 握手首帧自报的身份（应用名 + 版本） */
  clientInfo: ClientInfo;
  /** 用户不填工作目录时的默认值（桌面端 = `app.getPath("desktop")`，由调用方注入） */
  defaultCwd: () => string;
  /** `chat:push` 的出口（桌面端 = `webContents.send`） */
  push: (event: ChatStreamEvent) => void;
}

export interface ServerLayer {
  /** `invokeService(service, method, ...)` 的动态分发（分发键与旧实现完全一致） */
  manager: ServicesManager;
  /** 连上服务端并开始收事件（必须早于第一次 `chat.send`） */
  start: () => Promise<void>;
  /** 退出时收摊（断开连接；事件订阅随连接一起失效） */
  dispose: () => void;
}

export function createServerLayer(options: ServerLayerOptions): ServerLayer {
  // 「连哪台、断了怎么办」全在这一个对象里（发现 → 探活 → 复用 / 拉起 → 断了重建）。
  // 组装根拿到的只是它的 `client` / `watch` / `onOpen` 三面，**发请求的入口是另一个**：
  // 收在一个 `call` 上（见 `./call.ts`），六处调用点就不可能各自存一份会过期的 client
  const connection = new ServerConnection({
    aiZenDir: options.aiZenDir,
    clientInfo: options.clientInfo,
  });
  const call = protocolCall(connection);
  const events = new ChatEventBridge({ connection, call, push: options.push });

  const manager = new ServicesManager({
    workspace: new ServerWorkspaceService({ call, defaultCwd: options.defaultCwd }),
    conversation: new ServerConversationService({ call }),
    agent: new ServerAgentService({ call }),
    model: new ServerModelService({ call }),
    chat: new ServerChatService({ call, events }),
    config: new ServerConfigService({ call }),
  });

  return {
    manager,
    start: async () => await events.start(),
    dispose: () => {
      events.dispose();
      connection.close();
    },
  };
}
