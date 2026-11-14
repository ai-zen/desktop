/**
 * 宿主门面的组装根 —— 六个 Service + 事件翻译器 + 那一条连接。
 *
 * ## 为什么组装写在这里而不是 `app.ts`
 *
 * `app.ts` 是 Electron 的组装根（窗口、IPC、原生对话框）。这一层要能被 vitest 直接验，就不能碰
 * electron，也不该被 electron 的细节污染 —— 于是它需要一个**自己的入口**：调用方只递进来四样非
 * electron 的事实（数据根、握手身份、默认工作目录、事件出口），拿回一个 `ServicesManager` 和一对
 * `start` / `dispose`。
 *
 * ## 「连哪台」：本地起得来、远程只连不拉
 *
 * 两种情况由**有没有显式地址**区分，判断本身在客户端库里（`ensureHost`，PRD D26）：
 *
 * ```
 * 没有显式地址 → 本机：读 <数据根>/run/host.json 拿地址、run/token 拿凭证；
 *                     没有活着的实例就 spawn 随包分发的那份，轮询到「握手成功」为止
 * 有显式地址   → 只连，一次都不拉起（本机拉起来的一定不在那个地址上）
 * ```
 *
 * 本层不缓存端口、也不记 pid：重启后的宿主会把发现文件换成新端口，`ensureHost` 于是自然连到
 * 新的那个。
 *
 * ## 一条连接，`Client` 对象活到底
 *
 * `Client`（`@ai-zen/agents-client`）自己管重连与补拉：socket 断了它换一条，`track` 过的对话在
 * 连上之后按 `conversation.state` + `message.list({after})` 补回来。本层只做三件事：建它、把事件
 * 挂上去（`ChatEventBridge.attach`）、退出时关掉它。**没有第二份重连实现** —— 那种东西在本仓写过
 * 一次，代价是「daemon 重启 → 桌面端永久失能，界面上看起来只是没反应」。
 */

import type {
  ClientInfo,
  MethodCallArgs,
  MethodName,
  HostHelloResult,
} from "@ai-zen/agents-client";
import { ensureHost } from "@ai-zen/agents-client";
import type { ChatStreamEvent } from "@ai-zen/desktop-shared";
import { CONNECTION_LANGUAGE } from "../language.js";
import type { ContractCall, ContractConnection } from "./contract.js";
import { ChatEventBridge } from "./events.js";
import { HOST_ENTRY, spawnBundledHost, type SpawnHostContext } from "./launch.js";
import { ServicesManager } from "./ServicesManager.js";
import {
  HostAgentService,
  HostChatService,
  HostConfigService,
  HostConversationService,
  HostModelService,
  HostWorkspaceService,
  type ServiceContext,
} from "./services.js";

export interface HostLayerOptions {
  /** 数据根（`AI_ZEN_DIR`）：发现文件与本地凭证都在它下面 */
  aiZenDir: string;
  /** 握手首帧自报的身份（应用名 + 版本） */
  clientInfo: ClientInfo;
  /** 用户不填工作目录时的默认值（桌面端 = `app.getPath("desktop")`，由调用方注入） */
  defaultCwd: () => string;
  /** `chat:push` 的出口（桌面端 = `webContents.send`） */
  push: (event: ChatStreamEvent) => void;
  /**
   * 显式宿主地址：给了就**只连、永不拉起**本机宿主。来源是用户的连接设置
   * （`ConnectionSettings` → `connectionConfigOf()`）；`local` 模式下是 `undefined`。
   *
   * 不在这里解析它（不 parse、不补 `ws://`）：地址的形状只有一个定义处（客户端库的
   * `address.ts`），本层多写一行就是一个能静默跑偏的第二份实现。
   */
  hostUrl?: string;
  /** 显式凭证：透传；不给就退回 `<数据根>/run/token`。凭证**绝不进日志** */
  hostToken?: string;
  /** 拉起宿主（缺省 {@link spawnBundledHost}；用例注入一个计数器） */
  spawnHost?: (context: SpawnHostContext) => Promise<void>;
  /** 宿主入口（缺省随包分发的 `dist/host.mjs`） */
  hostEntry?: string;
  /**
   * 「确保有一个能连的宿主」（缺省库里那个 `ensureHost`；用例注入一个假的）。
   *
   * 这一层与连接库之间只有这一个不可替换的动作是 I/O（读发现文件、拉起进程、握手），把它开成
   * 注入点，组装逻辑（本文件那二十行）才能不起真宿主就验得到。
   */
  ensure?: typeof ensureHost;
  /** 日志出口（缺省 `console.info`）。**只许说模式与地址，凭证一个字都不许进** */
  log?: (message: string) => void;
}

/**
 * 宿主**自报的身份**里 render 用得到的那两位（`hello` 回执）。
 *
 * 只留 `protocol` / `version`：回执还带 `capabilities` / `limits` / `startedAt`，而它们对界面
 * 没有意义（一个字段只要没人读，就会有人以为它该被读）。
 */
export interface LayerHello {
  /** 协议版本（`hello` 里是字符串 `"1"`，这里转成数字给界面） */
  protocol: number;
  /** 宿主的版本串 */
  version: string;
}

export interface HostLayer {
  /** `invokeService(service, method, ...)` 的动态分发（六个分发键即 render 的调用面） */
  manager: ServicesManager;
  /** 连上宿主并开始收事件（必须早于第一次 `chat.send`） */
  start: () => Promise<void>;
  /**
   * 握手回执里那份身份（`start()` 成功之后才有；拿不到就是 `null`）。
   *
   * 谁要它：`ConnectionController` 把 `protocol` / `version` 填进 `ready` 状态，render 直接显示，
   * 不自己猜版本。
   */
  hello: () => LayerHello | null;
  /** 退出时收摊（断开连接；事件订阅随连接一起失效） */
  dispose: () => void;
}

export function createHostLayer(options: HostLayerOptions): HostLayer {
  const log = options.log ?? ((message: string) => console.info(message));

  /** 这条连接（`start()` 建、`dispose()` 关）。取不到时是「还没连上」这个事实本身 */
  let connection: ContractConnection | null = null;
  let hello: LayerHello | null = null;

  const requireConnection = (): ContractConnection => {
    if (!connection) throw new Error("还没连上宿主（连接尚未建立或已断开）");
    return connection;
  };
  const call: ContractCall = <M extends MethodName>(method: M, ...args: MethodCallArgs<M>) =>
    requireConnection().call(method, ...args);

  const events = new ChatEventBridge({
    call,
    push: options.push,
    log,
  });

  const ctx: ServiceContext = {
    call,
    connection: requireConnection,
    events,
    defaultCwd: options.defaultCwd,
  };

  const manager = new ServicesManager({
    workspace: new HostWorkspaceService(ctx),
    conversation: new HostConversationService(ctx),
    agent: new HostAgentService(ctx),
    model: new HostModelService(ctx),
    chat: new HostChatService(ctx),
    config: new HostConfigService(ctx),
  });

  return {
    manager,
    start: async () => {
      const spawned = options.spawnHost ?? spawnBundledHost;
      const ensure = options.ensure ?? ensureHost;
      const result = await ensure({
        dataRoot: options.aiZenDir,
        clientInfo: options.clientInfo,
        // 桌面端的界面文案是中文：连接要显式声明（否则宿主渲染的句子会是它的默认语言，
        // 缺省英文，同一块屏上两种语言）
        language: CONNECTION_LANGUAGE,
        // 显式地址 ⇒ 「远程」那条路（只连不拉起）；否则本机（发现文件 + 本机凭证）
        settings: options.hostUrl
          ? {
              mode: "remote",
              url: options.hostUrl,
              ...(options.hostToken ? { token: options.hostToken } : {}),
            }
          : { mode: "local" },
        spawnHost: (context) => {
          log(`本机没有活着的宿主，拉起随包分发的那份（数据根 ${context.dataRoot}）`);
          // 客户端库的拉起上下文里 `entry` 是可选的（没给就让它去 npx 现下现起），而桌面端**只走
          // 随包分发**这一条路：客户机不保证有 npm。这里把那一格固定成我们自己的那份，
          // 于是 `spawnBundledHost` 的契约（给它一个入口就起它）不必改。
          return spawned({ dataRoot: context.dataRoot, entry: context.entry ?? HOST_ENTRY });
        },
        hostEntry: options.hostEntry ?? HOST_ENTRY,
      });

      connection = result.client;
      const identity = helloOf(result.client.hello);
      hello = identity;
      events.attach(result.client);
      log(
        `已连上 ${result.target.host}:${result.target.port}` +
          `${result.started ? "（本次由桌面端拉起）" : ""}，宿主版本 ${identity?.version || "未知"}`,
      );
    },
    hello: () => hello,
    dispose: () => {
      events.dispose();
      const client = connection;
      connection = null;
      hello = null;
      // 关连接是异步的，但退出路径上没人能等它：`Client.close()` 先同步置 `closing`、再关 socket
      void client?.close();
    },
  };
}

/**
 * 握手回执 → 界面上那两位；拿不到就是 `null`（连上了但不知道自己连的是哪一版，比编一个数字诚实）。
 *
 * 导出给「试连」那条路（`connection/controller.ts`）复用：`protocolVersion` 怎么解析成数字
 * 只有一个口径，两处各写一遍时漏改一处就会出现「设置页显示 1、状态栏显示 0」。
 */
export function helloOf(hello: HostHelloResult | null): LayerHello | null {
  if (!hello) return null;
  const protocol = Number.parseInt(hello.protocolVersion, 10);
  return {
    protocol: Number.isFinite(protocol) ? protocol : 0,
    version: hello.hostVersion,
  };
}
