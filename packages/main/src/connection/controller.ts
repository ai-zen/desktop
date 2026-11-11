/**
 * ConnectionController —— 「此刻连着哪一层」的唯一持有者（D21）。
 *
 * ## 为什么要有这个对象
 *
 * 改动前 `app.ts` 上是 `private readonly server: ServerLayer = createServerLayer({…})`：**字段
 * 初始化，永远一份**。那种写法里「换个连接」只能靠重启 App，而需求是「面板上切本地 / 远程，
 * 立刻生效」。于是「当前是哪一层」必须收成一个有状态的对象 —— 但它不能待在 `app.ts` 里：
 * 那里有 electron（窗口、`app.getPath`、`webContents.send`），放进那个文件就等于「换层要不要
 * 动旧层、先落盘还是先关连接」这件事只能靠人肉点一遍 App 来验。
 *
 * 所以这里**一个 electron 的东西都没有**：配置根、握手身份、默认目录、事件出口、建层工厂、
 * 配置的读与写、日志出口，全部注入。用例拿假层 + 计数器就能把 D18 的顺序咬死（见
 * `controller.test.ts`），不必起真 daemon、也不必开窗口。
 *
 * ## 换层的顺序是硬要求（D18）
 *
 * **先落盘 → 再 `dispose()` 旧层 → 再新建 → 再 `start()`**，一步都不许提前：
 *
 *   · 落盘失败就**不许动连接**。否则界面上写着「远程」，实际还连着本地那条 —— 这是最难查的
 *     一种状态：看起来什么都没发生，而用户以为已经切过去了；
 *   · 旧层必须先 `dispose()`：一条连接活着的 `ServerConnection` 会继续收它那台服务端的事件，
 *     不关掉的话 `chat:push` 会同时来自两台机器（消息串台）；
 *   · `start()` 必须在建之后：`events.watch` 是连接级的订阅，晚一步就会漏掉第一条阶段事件。
 *
 * 重建期间在飞的请求允许失败（界面上会提示「进行中的回答会中断」）：没有一种顺序能让它不断，
 * 能选的只是「断得干净」还是「断得半截」。
 */

import type { ClientInfo } from "@ai-zen/agents-client";
import {
  explainUnauthorized,
  parseServerUrl,
  resolveToken,
  SocketServerClient,
} from "@ai-zen/agents-client";
import type {
  ChatStreamEvent,
  ConnectionControls,
  ConnectionProbe,
  ConnectionSettings,
} from "@ai-zen/desktop-shared";
import type { ServerLayerOptions } from "../server/index.js";
import { connectionConfigOf, parseConnectionSettings } from "./settings.js";

/**
 * 控制器眼里的「一层」：只有三件事。
 *
 * 刻意比 `ServerLayer` 更窄（`manager` 只留 `invokeService` 的形状），这样用例可以拿一个
 * 记事本似的假层顶上去 —— 而真件（`createServerLayer()` 的返回值）在结构上本来就满足它，
 * 不需要断言、不需要适配。
 */
export interface ConnectionLayer {
  /** IPC 转发入口：`invokeService(service, method, ...args)` */
  manager: {
    invokeService: (service: string, method: string, ...args: unknown[]) => Promise<unknown>;
  };
  /** 连上服务端并开始收事件 */
  start: () => Promise<void>;
  /** 收摊：断开连接、退订事件 */
  dispose: () => void;
}

/** 「测试连接」的候选值（形状由 IPC 契约定，见 shared 的 `ConnectionControls.test`） */
export type ConnectionTestCandidate = Parameters<ConnectionControls["test"]>[0];

export interface ConnectionControllerOptions {
  /** 配置根目录（`AI_ZEN_DIR`）：连接配置与发现文件都在它下面 */
  aiZenDir: string;
  /** 握手首帧自报的身份 */
  clientInfo: ClientInfo;
  /** 用户不填工作目录时的默认值（桌面端 = `app.getPath("desktop")`） */
  defaultCwd: () => string;
  /** `chat:push` 的出口 */
  push: (event: ChatStreamEvent) => void;
  /** 建一层（生产 = `createServerLayer`，用例 = 假层 + 计数器） */
  createLayer: (options: ServerLayerOptions) => ConnectionLayer;
  /** 读配置（生产 = `settings.ts` 的 `readSettings`，用例 = 一个内存变量） */
  readSettings: () => Promise<ConnectionSettings>;
  /** 写配置（生产 = `settings.ts` 的 `writeSettings`，用例 = 计数 + 可控失败） */
  writeSettings: (settings: ConnectionSettings) => Promise<void>;
  /** 日志出口（缺省 `console.info`）。**只许说模式与地址，凭证一个字都不许进**（D22） */
  log?: (message: string) => void;
}

export class ConnectionController {
  /**
   * 当前那一层。`null` = 还没 `start()` 或已经 `dispose()`。
   *
   * 它是**唯一**一处「此刻连着谁」的事实：`layer()` 交给 IPC 转发，`save()` 换掉它。
   */
  private current: ConnectionLayer | null = null;
  /** 写进日志的那一句话里只允许出现模式与地址（D22） */
  private readonly log: (message: string) => void;
  private readonly options: ConnectionControllerOptions;

  constructor(options: ConnectionControllerOptions) {
    this.options = options;
    this.log = options.log ?? ((message: string) => console.info(message));
  }

  /** 按已落盘的配置建第一层并连上（App 启动时调一次，早于任何 IPC） */
  async start(): Promise<void> {
    const settings = await this.options.readSettings();
    const layer = this.build(settings);
    this.current = layer;
    await layer.start();
    this.log(`已按配置建立连接：${describe(settings)}`);
  }

  /**
   * 当前配置（`connection:get`）。
   *
   * 每次现读盘、不用内存里那份：这份文件可能被手改（排障时很常见），而「面板里显示的」
   * 必须是**盘上那一份** —— 否则用户改完文件、重新打开面板，看到的还是个旧值。
   */
  async get(): Promise<ConnectionSettings> {
    return await this.options.readSettings();
  }

  /**
   * 保存并**立即重建连接**（D18：不要求重启 App）。
   *
   * 顺序是硬要求，注释按那三步标出来：任何一步失败都不许让界面与事实分叉。
   */
  async save(input: ConnectionSettings): Promise<{ settings: ConnectionSettings }> {
    // 1. 先校验：非法输入在这一步就抛人话，磁盘与连接一个字节都还没动
    const settings = parseConnectionSettings(input);

    // 2. 再落盘：**失败就抛，连接一个字段都不动**（否则「界面显示远程、实际还连着本地」）
    await this.options.writeSettings(settings);

    // 3. 落盘成功之后才动连接：dispose 旧层 → 建新层 → start（顺序不许倒）
    const layer = this.swap(settings);
    await layer.start();

    this.log(`连接设置已保存并重建连接：${describe(settings)}`);
    return { settings };
  }

  /**
   * 「测试连接」：用候选值试连一次，**不落盘、不影响当前连接**（D19）。
   *
   * 四件事各有出处，这里不重新发明：
   *
   *   · 地址的合法性只问 `parseServerUrl`（地址形状的唯一实现处），非法就回一句人话；
   *   · 凭证按 D9 的优先级取：候选值 > `<aiZenDir>/run/token`（留空 = 用本机那份）；
   *   · `connect()` 返回时握手已完成、`client.server` 就是服务端自报的身份（协议版本），
   *     拿到就立刻 `close()` —— 试连不该在服务端那边留下一条常驻连接；
   *   · 失败一律不抛：`unauthorized` 交给 `explainUnauthorized` 翻成人话（它与界面那三处
   *     说的是同一句话），其余错误用 `error.message` 原样回。
   *
   * 计时用 `Date.now()` 差：面板上那个「连上了（120ms）」没有毫秒表也不需要更准的东西。
   */
  async test(candidate: ConnectionTestCandidate): Promise<ConnectionProbe> {
    const raw = typeof candidate?.serverUrl === "string" ? candidate.serverUrl : "";

    let address;
    try {
      // 空串也走这里：它同样是「不是合法地址」，由那一处给出带原串的同一句话
      address = parseServerUrl(raw);
    } catch (error) {
      return { ok: false, message: messageOf(error) };
    }

    // 凭证：显式给的优先，没给就退回本机 run/token（D9 的本地兜底，不是一条"降级"）
    const { token, source } = await resolveToken({
      aiZenDir: this.options.aiZenDir,
      serverToken: candidate?.serverToken,
    });

    const startedAt = Date.now();
    let client: SocketServerClient | null = null;
    try {
      client = await SocketServerClient.connect({
        address,
        token: token ?? undefined,
        client: this.options.clientInfo,
      });
      const hello = client.server;
      if (!hello) {
        return { ok: false, message: "连上了服务端，但它的握手回执里没有身份（拿不到协议版本）" };
      }
      return {
        ok: true,
        protocol: hello.protocol,
        version: hello.version,
        elapsedMs: Date.now() - startedAt,
      };
    } catch (error) {
      return {
        ok: false,
        message: explainUnauthorized(error, {
          // 面板里填的地址一定是「显式」的：它不走发现文件，所以措辞要用显式那一支
          explicit: true,
          source,
          serverUrl: raw,
          aiZenDir: this.options.aiZenDir,
        }).message,
      };
    } finally {
      // 成功 / 失败都关：试连只回答一个问题，回答完就不该再占着一条连接
      client?.close();
    }
  }

  /**
   * 当前那一层（IPC 转发用）。
   *
   * 还没 `start()` / 已 `dispose()` 时**抛错**而不是回空：回空会让 `app.ts` 那边每一处都要
   * 判一次 `null`，而真正该说的是「连接还没建立」—— 一句能直接看懂的错。
   */
  layer(): ConnectionLayer {
    if (!this.current) {
      throw new Error("连接尚未建立（或已断开）");
    }
    return this.current;
  }

  /** 收摊（App 退出时调）：关掉当前那一层，之后不再持有任何连接 */
  dispose(): void {
    const layer = this.current;
    this.current = null;
    layer?.dispose();
  }

  // ==================================================================
  // 内部
  // ==================================================================

  /**
   * 换层：**先 `dispose()` 旧层 → 再建新层**（D18 的前半步），返回新层让调用方 `start()`。
   *
   * `start()` 交给调用方（而不是在这里顺手 await）：换层的四步是一条**固定顺序**，写在
   * `save()` 里才能一眼读完；拆进两个私有方法里，下一个人只会看到两处「好像都能调」。
   *
   * 新层在 `start()` 失败时**照样留在 `current` 上**：它的 `ServerConnection` 每次取用都会
   * 判活重连（那是包里的不变式），于是「这次没连上」不会把这个进程永久钉在旧层上 ——
   * 而把 `current` 置空只会让之后每一次 IPC 都报「连接尚未建立」，比原来的错更难查。
   */
  private swap(settings: ConnectionSettings): ConnectionLayer {
    this.current?.dispose();
    this.current = this.build(settings);
    return this.current;
  }

  /** 造一层（不 start：调用方决定什么时候连上） */
  private build(settings: ConnectionSettings): ConnectionLayer {
    const { serverUrl, serverToken } = connectionConfigOf(settings);
    return this.options.createLayer({
      aiZenDir: this.options.aiZenDir,
      clientInfo: this.options.clientInfo,
      defaultCwd: this.options.defaultCwd,
      push: this.options.push,
      serverUrl,
      serverToken,
    });
  }
}

// ==================================================================
// 内部函数
// ==================================================================

/**
 * 一份设置的一句话描述（**进日志**）。
 *
 * 只印模式与地址：凭证是钥匙，它不许出现在任何会被 `cat` 出去的东西里（D22 / D4）。
 * 这也是本文件里唯一一处「把配置写出去」的地方 —— 想加日志的人只能改这里，于是「别印
 * 凭证」是一条结构上的保证，而不是一句提醒。
 */
function describe(settings: ConnectionSettings): string {
  if (settings.mode !== "remote") return "本地（发现文件 + 本机凭证）";
  return `远程 ${settings.serverUrl ?? ""}`.trim();
}

/** 抛出值 → 一句人话（非 Error 的抛出值兜一下，别让 `undefined` 变成界面上的一格空白） */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
