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
 * 长回来是它自己的事**：每次取用都判 `closed`、断了重建、并在新连接上重新订阅事件。
 *
 * 在本层自己写这套逻辑（把连接缓存在 `pending ??=`、建成后不复查 `closed`）的代价是
 * `daemon 重启 → 桌面端永久失能`：所有 IPC 一律 `client is closed`，而界面上看起来只是
 * 「没反应」（没有重连、没有提示、也没有错误）。所以这件事不该有第二份实现 —— 它归包里那
 * 一个，本仓只负责组装与收摊。
 *
 * ## 组装根为什么不需要再判一次「要不要重建」
 *
 * 「连的是哪台服务端」**默认**由**发现文件**回答（`<aiZenDir>/run/server.json`）：重启后的
 * 服务端会把它换成新端口，`ensureServer` 于是自然连到新的那个。配置里给了 `serverUrl` 时
 * 地址来自那里、不走发现文件（见下一节）。本层不缓存端口、也不记 pid。
 *
 * ## 地址与凭证：只**透传**，不解释（D9 / D14）
 *
 * 调用方若给了显式地址 / 凭证（来源是用户的连接设置 `ConnectionSettings`，由
 * `connection/controller.ts` 在**每次建层**时映射进来；`mode: "local"` 时两个都是 `undefined`），
 * 本层原样递给 `ServerConnection` 的 `serverUrl` / `serverToken`，一个字段都不改：解析、
 * 优先级与「本机 token 兜底」全在客户端的 `resolve-target.ts`（那是唯一一份）。
 *
 * 本层唯一多做的一件事是 D10：给了显式地址就**不拉起本机 server** —— 这件事交给
 * `./launch.ts` 的 `createStartBundledServer`（它会留下一条只说地址、不说凭证的日志）。
 * 「连本地还是远程」由 `ConnectionController` 换层实现（换一层 = 再调一次本函数）：
 * 用户是怎么选的、什么时候重建，都是那个对象的事，本层不关心。
 */

import type { ClientInfo } from "@ai-zen/agents-client";
import { ServerConnection } from "@ai-zen/agents-client";
import type { ChatStreamEvent } from "@ai-zen/desktop-shared";
import type { ServerConnectionConfig } from "../config.js";
import { ServicesManager } from "./ServicesManager.js";
import { protocolCall } from "./call.js";
import { createStartBundledServer } from "./launch.js";
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
  /**
   * 显式服务端地址：给了就**只连、永不拉起**本机 server（D10）。来源是用户的连接设置
   * （`ConnectionSettings` → `connectionConfigOf()`）；`local` 模式下是 `undefined`。
   *
   * 不在这里解析它（不 parse、不补 `ws://`）：地址的形状只有一个定义处（客户端包的
   * `wire/server-url.ts`），本层多写一行就是一个能静默跑偏的第二份实现。
   */
  serverUrl?: string;
  /** 显式凭证：透传；不给就退回 `<aiZenDir>/run/token`（D9）。凭证**绝不进日志** */
  serverToken?: string;
}

/**
 * 服务端**自报的身份**里 render 用得到的那两位（`hello` 回执）。
 *
 * 只留 `protocol` / `version`：`HelloResult` 还带 `name` / `pid` / `startedAt`，而它们对界面
 * 没有意义（谁都不需要知道对面进程的 pid）—— 一个字段只要没人读，就会有人以为它该被读。
 */
export interface LayerHello {
  /** 服务端说的协议版本（正整数） */
  protocol: number;
  /** 服务端的版本串（`0.1.0` 这种） */
  version: string;
}

export interface ServerLayer {
  /** `invokeService(service, method, ...)` 的动态分发（六个分发键即 render 的调用面） */
  manager: ServicesManager;
  /** 连上服务端并开始收事件（必须早于第一次 `chat.send`） */
  start: () => Promise<void>;
  /**
   * 握手回执里那份身份（`start()` 成功之后才有；拿不到就是 `null`）。
   *
   * 谁要它：`ConnectionController` 把 `protocol` / `version` 填进 `ready` 状态（D23），
   * render 直接显示，不自己猜版本。
   *
   * 为什么是「记下来再给」而不是「现发一次 `hello`」：服务端**握手只认一次**，握过之后
   * 再发 `hello` 会被回 `invalid-request`（`Daemon` 的 `handshaken` 分支）—— 那条路根本
   * 走不通。所以身份只能在握手那一刻从连接上读下来，而 `start()` 就是那个时刻。
   */
  hello: () => LayerHello | null;
  /** 退出时收摊（断开连接；事件订阅随连接一起失效） */
  dispose: () => void;
}

export function createServerLayer(options: ServerLayerOptions): ServerLayer {
  // 「连哪台、断了怎么办」全在这一个对象里（发现 → 探活 → 复用 / 拉起 → 断了重建）。
  // 组装根拿到的只是它的 `client` / `watch` / `onOpen` 三面，**发请求的入口是另一个**：
  // 收在一个 `call` 上（见 `./call.ts`），六处调用点就不可能各自存一份会过期的 client
  // 配置原样收成一份（既喂连接、也喂拉起器）：两个值走的是同一条路，不会出现
  // 「连接用配置里的地址、拉起器却以为没有配置」这种半截状态
  const config: ServerConnectionConfig = {
    serverUrl: options.serverUrl,
    serverToken: options.serverToken,
  };

  const connection = new ServerConnection({
    aiZenDir: options.aiZenDir,
    clientInfo: options.clientInfo,
    // 显式地址 / 凭证：透传给包里那个唯一的解析点（D9），本层不判断、不降级
    serverUrl: config.serverUrl,
    serverToken: config.serverToken,
    // 拉起的是**随包分发**的那份（客户机可能连 Node.js 都没有）。
    // 「优先用系统里已经在跑的」不在这里：`ensureServer` 先读发现文件并 ping，通了就直接连。
    // 给了显式地址时它只打一条日志、不拉起（D10）。
    startServerProcess: createStartBundledServer({ config }),
  });
  const call = protocolCall(connection);
  const events = new ChatEventBridge({ connection, call, push: options.push });

  const manager = new ServicesManager({
    workspace: new ServerWorkspaceService({
      call,
      defaultCwd: options.defaultCwd,
    }),
    conversation: new ServerConversationService({ call }),
    agent: new ServerAgentService({ call }),
    model: new ServerModelService({ call }),
    chat: new ServerChatService({ call, events }),
    config: new ServerConfigService({ call }),
  });

  /**
   * 握手回执里那份身份（见 {@link ServerLayer.hello}）。`start()` 那一刻从连接上读一次，
   * 之后一直是它：这条连接这辈子就握了这一次手。
   */
  let hello: LayerHello | null = null;

  return {
    manager,
    start: async () => {
      await events.start();
      // `events.start()` 里已经取过连接了：这一次 `client()` 拿到的是同一条（还活着就复用），
      // 不会多建一条连接，也不会多发一帧 `events.watch`
      hello = await readHello(connection);
    },
    hello: () => hello,
    dispose: () => {
      events.dispose();
      connection.close();
    },
  };
}

/**
 * 从一条**已经连上**的连接上读服务端自报的身份。
 *
 * `ServerClient` 的门面上没有 `server` —— 那是 `SocketServerClient` 的 getter（握手回执一到
 * 就填好）。本仓只允许改 `desktop/`，所以这里做一次**窄断言**：拿的就是那个 getter，读不到
 * （换成别的实现、或还没握手）就当没有。
 *
 * 失败一律回 `null`，**不抛**：拿不到版本串不该把「连上了」变成「连不上」—— 界面上少显示
 * 一行版本，比一个明明能用的连接被报成失败要好得多。
 */
async function readHello(connection: ServerConnection): Promise<LayerHello | null> {
  try {
    const client = await connection.client();
    const info = (client as unknown as { server?: { protocol?: unknown; version?: unknown } })
      .server;
    if (!info || typeof info.protocol !== "number") return null;
    return {
      protocol: info.protocol,
      version: typeof info.version === "string" ? info.version : "",
    };
  } catch {
    return null;
  }
}
