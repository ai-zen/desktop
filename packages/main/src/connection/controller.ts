/**
 * ConnectionController —— 「此刻连着哪一层」与「这条连接此刻什么状态」的唯一持有者
 * （D21 / D23 / D24 / D27）。
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
 * 配置的读与写、状态出口、日志出口、计时器，全部注入。用例拿假层 + 计数器就能把 D18 / D24 /
 * D27 的顺序咬死（见 `controller.test.ts`），不必起真 daemon、也不必开窗口。
 *
 * ## 状态机（D23）+ 有限的退避重试（D24）
 *
 * 窗口现在**先出来**、连接放到后面（D25）：双击图标一定看得见窗口，看不见的只是「连上了没有」。
 * 于是「连接是什么状态」必须是一个**能被问、也能被推**的值 —— 否则 render 挂载时那几句
 * `invokeService` 撞在一条还没连上的连接上，屏幕上就是一片空白且没有提示（那比「双击没反应」
 * 更难查：窗口出来了，用户以为它在干活）。
 *
 *   · `connecting(attempt: 0)` —— 首次尝试中。它是**起始态**：`start()` 之前查 `state()` 拿到
 *     的就是它（`label` 按盘上那份配置算），所以 `start()` 不重复推一遍（推的只是变化）；
 *   · 首次失败 → 最多再试 3 次，退避 1000 / 2000 / 5000。此时状态是
 *     `connecting(attempt: N, nextRetryInMs: 还要等多久)`，N 是**接下来要去试的第几次重试**；
 *   · 三次重试也失败 → `error`（终态，带一句人话 `message`）。离开它只有一条路：用户点「重连」
 *     （{@link ConnectionController.reconnect}）—— 自动重试只跑**一批**，不跑一辈子：一个连不上
 *     的远端不该让主进程永远每 5 秒敲一次门，而那种「安静地一直在试」在界面上和「停住了」
 *     长得一模一样。
 *
 * ## 重试必须**整层重建**
 *
 * 不是「再 `start()` 一次」：`server/events.ts` 的 `ChatEventBridge.start()` 把
 * `this.unsubscribeOpen = …` **直接覆盖**而不会先退订 —— 同一个桥重复 `start()` 会漏掉上一条
 * `onOpen` 订阅（那条订阅管的是「连接换了一条要重挂监听」，掉了就永远收不到，界面安静地不动）。
 * 所以每一次尝试都是 `dispose()` 旧层 → `build()` → `layer.start()`：新层是新的桥、新的连接，
 * 一条都不欠。
 *
 * ## 计时器为什么是注入项
 *
 * 退避是真的要等 1 / 2 / 5 秒。如果这里直接 `setTimeout`，用例只有两条路：真等 8 秒（一个用例
 * 比整套用例还长），或者 `vi.useFakeTimers()` —— 后者会把 `Promise` 的微任务一起接管，而这条
 * 状态机每一步都是真 async（每次尝试都要等一个真 promise 落定），假时间一开，「等它落定」在
 * 用例里就没法写了。所以时间从外面递进来（`scheduler`）：生产用全局 `setTimeout`，用例用一个
 * 「按号点」的表。两边都还是真的异步，只是一边的时间是人推的。
 *
 * ## 竞态：后台 `start()` 还在飞时用户点了「保存并重连」（D27）
 *
 * 两件事必须做，否则会同时躺着两条连接：
 *
 *   · `save()` 先**等**在飞的那一次尝试落定（成功或失败都算），再去换层 —— 不等的话，旧的尝试
 *     回来时会把它自己那一层写进 `current`，而我们刚建的那层就没人 `dispose()` 了；
 *   · 换层之前先**取消挂起的重试计时器**：不清的话，换完层它到点还会拿**旧配置**再连一次
 *     （用户已经选了别的服务端，进程却暗中去连上一台）。
 *
 * 落盘失败时这两件事一件都不做：连接与计时器原样留着（旧配置该继续连就继续连）。
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
  ConnectionState,
} from "@ai-zen/desktop-shared";
import type { LayerHello, ServerLayerOptions } from "../server/index.js";
import { connectionConfigOf, parseConnectionSettings } from "./settings.js";

/**
 * 首次失败之后的重试间隔（D24）：1000 / 2000 / 5000。
 *
 * 数组长度就是「最多再试几次」：三个数字用完仍失败 → `error`。只跑这一批，不跑一辈子
 * （理由见文件头「有限的退避重试」）。
 */
const RETRY_DELAYS_MS = [1000, 2000, 5000] as const;

/**
 * 计时器注入项（见文件头「计时器为什么是注入项」）。
 *
 * 句柄是 `unknown`：Node 的 `setTimeout` 给一个 `Timeout` 对象，用例给一个编号，本对象**不
 * 解读**它，只在需要撤销时原样交回给 `clear`。
 */
export interface TimerScheduler {
  /** 到点执行 `handler`；返回的句柄只用来撤销 */
  set: (handler: () => void, delayMs: number) => unknown;
  /** 撤销一个还没到点的句柄（已经到点的、或已被撤销的是空操作） */
  clear: (handle: unknown) => void;
}

/** 生产用的那一份：全局 `setTimeout` / `clearTimeout` */
const SYSTEM_SCHEDULER: TimerScheduler = {
  set: (handler, delayMs) => setTimeout(handler, delayMs),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * 一次尝试的结果。
 *
 * `save()` 要拿它分辨那两条完全不同的失败路径（D27）：落盘失败（抛原错误，连接一个字段都
 * 不动）与「落盘成功但连不上」（盘上已经改了，界面不许说成「保存失败」）。
 */
type AttemptOutcome = { ok: true } | { ok: false; message: string };

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
  /**
   * 握手回执里的身份（`ready` 里那两位）。`start()` 成功之后才有；拿不到就 `null`。
   *
   * 可选：假层不必实现（不实现时 `ready` 填 `0` / `""` —— 连上了但不知道自己连的是哪一版，
   * 比编一个数字诚实）。
   */
  hello?: () => LayerHello | null;
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
  /**
   * 状态变化的出口（桌面端 = 往 render 推 `connection:state`）。
   *
   * 只推**变化**，不推「每走一步」：起始态（`connecting / attempt 0`）不推，因为它与
   * `state()` 在 `start()` 之前给出的那一份逐字相同，推一遍只是噪声。
   */
  onStateChange?: (state: ConnectionState) => void;
  /** 计时器（缺省 = 全局 `setTimeout` / `clearTimeout`；理由见文件头「计时器为什么是注入项」） */
  scheduler?: TimerScheduler;
}

export class ConnectionController {
  /**
   * 当前那一层。`null` = 还没 `start()` 或已经 `dispose()`。
   *
   * 它是**唯一**一处「此刻连着谁」的事实：`layer()` 交给 IPC 转发，换代时换掉它。
   */
  private current: ConnectionLayer | null = null;

  /**
   * 此刻的连接状态。`null` = 还没 `start()`（那时 `state()` 现算一份 `connecting(0)`）。
   *
   * 只有两处会写它：{@link seed}（起始态，不推）与 {@link setState}（变化，推）。多一处写
   * 就多一种「界面说的与实际不一样」。
   */
  private currentState: ConnectionState | null = null;

  /** 挂起的重试计时器（换层 / 重连 / 收摊都必须清掉它） */
  private retryTimer: unknown = null;

  /** 后台正在飞的那一次尝试（D27：`save()` 要先等它落定） */
  private inFlight: Promise<AttemptOutcome> | null = null;

  /**
   * 「这一代」的编号：`save()` / `reconnect()` / `dispose()` 都会换代，于是在飞的那一次尝试
   * 回来时一看编号变了就闭嘴（不再改状态、也不再排计时器）。
   *
   * 光靠「清掉计时器」不够：一条已经在飞的 `layer.start()` 清不掉。
   */
  private generation = 0;

  /** 已经 `dispose()`：此后任何异步回调都不许再动状态（进程要退了） */
  private disposed = false;

  /** 写进日志的那一句话里只允许出现模式与地址（D22） */
  private readonly log: (message: string) => void;
  private readonly scheduler: TimerScheduler;
  private readonly options: ConnectionControllerOptions;

  constructor(options: ConnectionControllerOptions) {
    this.options = options;
    this.log = options.log ?? ((message: string) => console.info(message));
    this.scheduler = options.scheduler ?? SYSTEM_SCHEDULER;
  }

  /**
   * 按已落盘的配置开始连（App 启动时调一次）。
   *
   * **调用方不该 `await` 它去等窗口**（D25）：窗口先出来，这一句在后台跑，结果靠状态推送。
   * 它自己也不会 reject（失败由状态机接住：重试 → 或者 `error`），所以 `app.ts` 那边只是
   * `void this.connection.start()` 再加一道 `.catch` 兜底日志。
   */
  async start(): Promise<void> {
    const settings = await this.readSettings();
    const generation = this.nextGeneration();
    // 起始态**不推**（见 `seed`）：它与 `state()` 在 start() 之前算出来的那一份逐字相同
    this.seed({ status: "connecting", label: labelOf(settings), attempt: 0 });
    await this.launch(settings, 0, generation);
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
   * 当前连接状态（`connection:state`）。
   *
   * 永不抛错，也**永不因为「还没开始」而无话可说**：窗口现在比连接先出来（D25），它挂载的
   * 那一刻最可能问的就是这一次 —— 那时答案就是事实本身（`connecting / attempt 0`），`label`
   * 按盘上那份配置算，于是界面显示的地址/模式从一开始就是对的。
   */
  async state(): Promise<ConnectionState> {
    if (this.currentState) return this.currentState;
    const settings = await this.readSettings();
    return { status: "connecting", label: labelOf(settings), attempt: 0 };
  }

  /**
   * 手动重试（D24）：清掉挂起的计时器、`attempt` 归零、立刻再试一轮（它自己也有 3 次退避）。
   *
   * 返回值是**进入 `connecting` 之后的那一瞬**，不是这一轮的结果：整轮最多 8 秒，把它 await
   * 住只会让界面在那 8 秒里既没有回执也没有反馈。之后的变化全走推送。
   */
  async reconnect(): Promise<ConnectionState> {
    const settings = await this.readSettings();
    // 换代：挂起的重试计时器作废，在飞的那一次回来时也不许再改状态（它代表的是旧配置）
    const generation = this.nextGeneration();

    // `error` 是终态，用户点了「重连」必须立刻看到它在动 —— 这一条一定要推
    const next: ConnectionState = {
      status: "connecting",
      label: labelOf(settings),
      attempt: 0,
    };
    this.setState(next);

    // 在飞的那一次先让它落定，再开新一轮：两条尝试同时跑会各建一层（后建的那层把先建的
    // 漏在 `current` 之外，谁也不记得 dispose 它）
    const previous = this.inFlight;
    void (async () => {
      if (previous) await previous;
      if (this.stale(generation)) return;
      await this.launch(settings, 0, generation);
    })();

    return next;
  }

  /**
   * 保存并**立即重建连接**（D18：不要求重启 App）。
   *
   * 顺序是硬要求，注释按那几步标出来：任何一步失败都不许让界面与事实分叉。
   */
  async save(input: ConnectionSettings): Promise<{ settings: ConnectionSettings }> {
    // 1. 先校验：非法输入在这一步就抛人话，磁盘与连接一个字节都还没动
    const settings = parseConnectionSettings(input);

    // 2. D27：后台那一轮 `start()` 可能还在飞 —— 先等它落定（成功或失败都算），否则两条尝试
    //    会抢同一层（各建一条、各 dispose 一次）。这一步**什么都不改**，等多久都不动连接。
    await this.inFlight;

    // 3. 再落盘：**失败就抛，连接一个字段都不动**（否则「界面显示远程、实际还连着本地」）。
    //    挂起的重试计时器也原样留着 —— 旧配置该继续连就继续连。
    await this.options.writeSettings(settings);

    // 4. 落盘成功之后才动连接：换代（顺手清掉挂起的重试计时器：否则换完层它到点还会拿**旧
    //    配置**再连一次）→ dispose 旧层 → 建新层 → start
    const generation = this.nextGeneration();
    const outcome = await this.launch(settings, 0, generation);

    if (!outcome.ok) {
      // 5. 盘上已经改了，所以这句话**绝不能**被界面显示成「保存失败」。它同时说清两件事：
      //    已保存 + 连不上（原因里不会出现凭证，见 `reasonOf`）。状态机此刻已经是
      //    `connecting`（后台按 D24 重试），界面等得到后续的 `ready` / `error`。
      throw new Error(`连接配置已保存，但连不上「${labelOf(settings)}」：${outcome.message}`);
    }

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

  /**
   * 收摊（App 退出时调）：关掉当前那一层，之后不再持有任何连接。
   *
   * **计时器必须在这里清掉**：进程要退了，一个还挂着的 `setTimeout`（最长 5 秒）会把事件循环
   * 撑着 —— `will-quit` 之后又醒过来一次，去连一个用户已经关掉的窗口后面的服务端。
   */
  dispose(): void {
    this.disposed = true;
    // 换代 + 清计时器：在飞的那一次回来时看到编号变了就闭嘴，挂着的重试也不再被点起来
    this.generation += 1;
    this.cancelRetry();
    const layer = this.current;
    this.current = null;
    layer?.dispose();
  }

  // ==================================================================
  // 状态机（D23 / D24）
  // ==================================================================

  /**
   * 一次尝试：**整层重建** → `start()` → 成功就 `ready`，失败就排下一次重试（或进 `error`）。
   *
   * 返回这一层连上了没有（`save()` 要据此分辨两条失败路径）。**永不抛错**：失败是这个方法
   * 的正常出口，它已经把结论写进状态机了。
   */
  private async attempt(
    settings: ConnectionSettings,
    attemptNo: number,
    generation: number,
  ): Promise<AttemptOutcome> {
    // 这一代已经作废（save / reconnect / dispose 接手了）：**连层都不许碰** —— 否则会拿着
    // 旧配置把刚换好的那一层换掉（一个漏清的计时器被点起来，就足以让当前连接退回上一台）。
    if (this.stale(generation)) {
      return { ok: false, message: "这一轮连接已经作废（已被新的配置或重连取代）" };
    }

    const label = labelOf(settings);

    // 每一次尝试都重建（D24，理由见文件头「重试必须整层重建」）：`dispose()` → `build()`，
    // 然后由下面这一句 `start()` 把新层连上。
    const layer = this.swap(settings);

    try {
      await layer.start();
    } catch (error) {
      const message = reasonOf(error, settings);
      // 这一轮已经被换掉（save / reconnect / dispose 接手了）：别再说话、也别再排计时器
      if (this.stale(generation)) return { ok: false, message };

      const retryNo = attemptNo + 1;
      const delayMs = RETRY_DELAYS_MS[retryNo - 1];
      if (delayMs === undefined) {
        this.log(
          `连接失败（第 ${attemptNo + 1} 次）：${describe(settings)}：${message}；` +
            `重试 ${RETRY_DELAYS_MS.length} 次仍未连上，停在 error 状态（等用户重连）`,
        );
        this.setState({
          status: "error",
          label,
          // 说清「试过了」：一句 socket 错误摆在界面上的时候，用户不知道还能不能等
          message: `${message}（已重试 ${RETRY_DELAYS_MS.length} 次仍未连上）`,
        });
        return { ok: false, message };
      }

      this.log(
        `连接失败（第 ${attemptNo + 1} 次）：${describe(settings)}：${message}；` +
          `${delayMs}ms 后重试（第 ${retryNo}/${RETRY_DELAYS_MS.length} 次）`,
      );
      // 重试等待中也还是 `connecting`：`attempt` = 接下来要试的第几次，`nextRetryInMs` = 还要等多久
      this.setState({ status: "connecting", label, attempt: retryNo, nextRetryInMs: delayMs });
      this.scheduleRetry(delayMs, settings, retryNo, generation);
      return { ok: false, message };
    }

    // 连上了，但这一轮已经被换掉（比如用户在这期间点了保存）：状态归新一轮管，这里不抢
    if (this.stale(generation)) return { ok: true };

    // 服务端自报的身份：拿不到就填 `0` / `""`（连上了但不知道自己连的是哪一版，比编一个数字诚实）
    const hello = layer.hello?.() ?? null;
    this.setState({
      status: "ready",
      label,
      protocol: hello?.protocol ?? 0,
      version: hello?.version ?? "",
    });
    this.log(`已连上：${describe(settings)}`);
    return { ok: true };
  }

  /**
   * 起一次尝试，并把它记成「在飞的那一条」（D27 的等待对象）。
   *
   * 只清自己那一份：`inFlight` 可能已经被后来的一次尝试换掉了，`finally` 里无条件清会把
   * 新的那条抹掉（`save()` 于是不等任何人，两条连接就并排跑了）。
   */
  private launch(
    settings: ConnectionSettings,
    attemptNo: number,
    generation: number,
  ): Promise<AttemptOutcome> {
    const running = this.attempt(settings, attemptNo, generation);
    this.inFlight = running;
    void running.then(() => {
      if (this.inFlight === running) this.inFlight = null;
    });
    return running;
  }

  /** 排一次重试（到点了就再 `launch` 一次，仍然是整层重建） */
  private scheduleRetry(
    delayMs: number,
    settings: ConnectionSettings,
    attemptNo: number,
    generation: number,
  ): void {
    // 一次只排一个：理论上这时一定是空的，清一下是为了让「不许有两个」是结构上的事
    this.cancelRetry();
    this.retryTimer = this.scheduler.set(() => {
      this.retryTimer = null;
      void this.launch(settings, attemptNo, generation);
    }, delayMs);
  }

  /** 清掉挂起的重试计时器（没有就什么都不做） */
  private cancelRetry(): void {
    if (this.retryTimer === null) return;
    this.scheduler.clear(this.retryTimer);
    this.retryTimer = null;
  }

  /**
   * 换一代：清掉挂起的计时器，并让在飞的那一次尝试作废。
   *
   * 三处调用点是同一件事的三个时机：`start()`（起始）、`save()`（换配置）、`reconnect()`
   * （用户手动重来）。`dispose()` 也换代，但它还有自己的收摊动作。
   */
  private nextGeneration(): number {
    this.cancelRetry();
    this.generation += 1;
    return this.generation;
  }

  /** 这一代还算不算数（换代过、或已经收摊 → 不算） */
  private stale(generation: number): boolean {
    return this.disposed || generation !== this.generation;
  }

  /** 记下起始态，**不推**（理由见 `ConnectionControllerOptions.onStateChange`） */
  private seed(next: ConnectionState): void {
    this.currentState = next;
  }

  /** 换一个状态，变了就推给 render */
  private setState(next: ConnectionState): void {
    const changed = !sameState(this.currentState, next);
    this.currentState = next;
    if (changed) this.options.onStateChange?.(next);
  }

  /** 读配置（`readSettings` 的契约是不抛：注入实现真抛了也按本地处理，别让启动挂住） */
  private async readSettings(): Promise<ConnectionSettings> {
    try {
      return await this.options.readSettings();
    } catch (error) {
      this.log(`读连接配置失败，按本地配置继续：${messageOf(error)}`);
      return { mode: "local" };
    }
  }

  // ==================================================================
  // 内部
  // ==================================================================

  /**
   * 换层：**先 `dispose()` 旧层 → 再建新层**（D18 的前半步），返回新层让调用方 `start()`。
   *
   * `start()` 交给调用方（而不是在这里顺手 await）：换层的四步是一条**固定顺序**，写在
   * `save()` / `attempt()` 里才能一眼读完；拆进两个私有方法里，下一个人只会看到两处
   * 「好像都能调」。
   *
   * 新层在 `start()` 失败时**照样留在 `current` 上**：它的 `ServerConnection` 每次取用都会
   * 判活重连（那是包里的不变式），于是「这次没连上」不会把这个进程永久钉在旧层上 ——
   * 而把 `current` 置空只会让之后每一次 IPC 都报「连接尚未建立」，比原来的错更难查。
   *
   * 重试时同一个 `settings` 会再走一遍这里：旧的那层（上一次试失败的那层）先收摊，再建新的 ——
   * 「整层重建」就是这么落地的。
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
 * 状态的 `label`：本地模式 = `"本机服务端"`，远程模式 = 那个地址。
 *
 * 这两个值是 render 唯一能显示的东西（它不许自己拼地址、也不许猜模式），所以**它们必须
 * 干净**：地址里的 userinfo（`wss://user:pass@host` 的 `user:pass@`）会先被抹掉
 * （{@link stripUserInfo}），凭证一个字都进不去。
 */
function labelOf(settings: ConnectionSettings): string {
  if (settings.mode !== "remote") return "本机服务端";
  // `remote` 一定有地址（`parseConnectionSettings` / 读路径的归一化都保证过），兜底只是不写 `!`
  return stripUserInfo(settings.serverUrl ?? "") || "远程服务端";
}

/**
 * 抹掉 URL 里的 userinfo。
 *
 * `parseServerUrl` 不看 userinfo（它只取 host / port / path），但**那一串会被原样写进
 * `label` 与日志** —— 而 `label` 是要推到界面上的。有人把钥匙写进地址（`wss://token@host`）
 * 时，凭证就会顺着界面与日志出去；这里多十行，那条路就是封死的。
 */
function stripUserInfo(url: string): string {
  const scheme = url.indexOf("://");
  if (scheme < 0) return url;
  const at = url.lastIndexOf("@");
  if (at < scheme) return url;
  return `${url.slice(0, scheme + 3)}${url.slice(at + 1)}`;
}

/**
 * 一份设置的一句话描述（**进日志**）。
 *
 * 只印模式与地址：凭证是钥匙，它不许出现在任何会被 `cat` 出去的东西里（D22 / D4）。
 * 这也是本文件里唯一一处「把配置写出去」的地方 —— 想加日志的人只能改这里，于是「别印
 * 凭证」是一条结构上的保证，而不是一句提醒。地址先过一遍 {@link stripUserInfo}：写在 URL
 * 里的凭证同样不许出去。
 */
function describe(settings: ConnectionSettings): string {
  if (settings.mode !== "remote") return "本地（发现文件 + 本机凭证）";
  return `远程 ${stripUserInfo(settings.serverUrl ?? "")}`.trim();
}

/**
 * 失败原因（**进状态、进日志、进 `save()` 抛出的那句话**）。
 *
 * 比 {@link messageOf} 多一步：把配置里那串凭证抹掉。`error.message` 今天不含凭证（客户端包
 * 的 `explainUnauthorized` 只给结论），但这句话会被推到界面上、也会被贴进 issue —— 一条
 * 「万一哪天错误里带了上下文」的保险，代价是一次 `split/join`。
 *
 * `local` 模式抹不掉什么（凭证在 `<aiZenDir>/run/token`，本对象手上没有那一串）；那条路上
 * 「不进日志」由客户端包保证。
 */
function reasonOf(error: unknown, settings: ConnectionSettings): string {
  const message = messageOf(error);
  const token = settings.serverToken?.trim();
  if (!token) return message;
  return message.split(token).join("***");
}

/** 抛出值 → 一句人话（非 Error 的抛出值兜一下，别让 `undefined` 变成界面上的一格空白） */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 两个状态是不是同一件事（决定推不推） */
function sameState(a: ConnectionState | null, b: ConnectionState): boolean {
  if (!a) return false;
  switch (b.status) {
    case "connecting":
      return (
        a.status === "connecting" &&
        a.label === b.label &&
        a.attempt === b.attempt &&
        a.nextRetryInMs === b.nextRetryInMs
      );
    case "ready":
      return (
        a.status === "ready" &&
        a.label === b.label &&
        a.protocol === b.protocol &&
        a.version === b.version
      );
    case "error":
      return a.status === "error" && a.label === b.label && a.message === b.message;
  }
}
