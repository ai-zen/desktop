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
 */

import type { ClientInfo, ServerClient } from "@ai-zen/agents-client";
import type { ChatStreamEvent } from "@ai-zen/desktop-shared";
import { ServicesManager } from "./ServicesManager.js";
import { ServerConnection } from "./connection.js";
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
  /** 配置根目录（`AI_ZEN_DIR`） */
  aiZenDir: string;
  /** 握手首帧自报的身份（应用名 + 版本） */
  clientInfo: ClientInfo;
  /** 用户不填工作目录时的默认值（桌面端 = `app.getPath("desktop")`，由调用方注入） */
  defaultCwd: () => string;
  /** `chat:push` 的出口（桌面端 = `webContents.send`） */
  push: (event: ChatStreamEvent) => void;
  /** 注入一条现成的连接（用例用：指向自己起的 Daemon） */
  client?: ServerClient;
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
  const connection = new ServerConnection({
    aiZenDir: options.aiZenDir,
    clientInfo: options.clientInfo,
    ...(options.client ? { client: options.client } : {}),
  });
  const events = new ChatEventBridge({ connection, push: options.push });

  const manager = new ServicesManager({
    workspace: new ServerWorkspaceService({ connection, defaultCwd: options.defaultCwd }),
    conversation: new ServerConversationService({ connection }),
    agent: new ServerAgentService({ connection }),
    model: new ServerModelService({ connection }),
    chat: new ServerChatService({ connection, events }),
    config: new ServerConfigService({ connection }),
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
