/**
 * connection api — 本地 / 远程连接设置（对应 main 的 ConnectionController）。
 *
 * 与其它 apis 文件的区别：**不走 `invokeService`**。`invokeService` 那张表的六个键是**服务端
 * 的方法**（协议一一对应），而「连哪台服务端」在服务端还不存在的时候就要回答 —— 它转发不了
 * （转发要一条连着的服务端，而它正是决定连哪条的那一个）。所以 main 给了五条专用通道
 * `connection:get` / `connection:save` / `connection:test` / `connection:state` /
 * `connection:reconnect`（D20 / D26），preload 暴露成 `window.electronAPI.connection`，这里只过一手。
 *
 * 错误照 `base.ts` 的做法收敛成 `InvokeServerError`：UI 层直接展示 `message`。
 * **日志里只许出现通道名**：前三条的入参带凭证（`serverToken`），一个字都不许进日志（D22）。
 */

import type { ConnectionProbe, ConnectionSettings, ConnectionState } from "@ai-zen/desktop-shared";
import { InvokeServerError, subscribeServiceEvent } from "./base.js";

/**
 * 调一条连接通道并把错误翻成 `InvokeServerError`。
 *
 * `run` 是惰性的一层包装，好处就是这里拿不到入参：想顺手 `console.error(...args)` 也没有 args
 * 可打 —— D22 的「凭证绝不进任何日志」靠结构而不是靠自觉。
 */
async function call<T>(channel: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    // 只带通道名与错误本身；凭证在 `settings` / `candidate` 里，不在这个作用域里
    console.error(`[connection] ${channel}`, error);
    throw InvokeServerError.from(error);
  }
}

/** 读当前配置（`connection:get`）：文件读不到时 main 回默认的 `{ mode: "local" }`，不抛错 */
export function getConnectionSettings(): Promise<ConnectionSettings> {
  return call("get", () => window.electronAPI.connection.get());
}

/** 保存并立即重建连接（`connection:save`，D18）：失败即 reject，界面据此提示「没保存成功」 */
export function saveConnectionSettings(
  settings: ConnectionSettings,
): Promise<{ settings: ConnectionSettings }> {
  return call("save", () => window.electronAPI.connection.save(settings));
}

/**
 * 用候选值试连一次（`connection:test`，D19）：不落盘、不影响当前连接。
 *
 * 「连不上 / 凭证被拒 / 地址非法」都是 `{ ok: false, message }` 这一支的**返回值**（不抛错）；
 * 这里兜的是 IPC 本身出问题（通道没注册、主进程崩了），那种才该 reject。
 */
export function testConnection(candidate: {
  serverUrl: string;
  serverToken?: string;
}): Promise<ConnectionProbe> {
  return call("test", () => window.electronAPI.connection.test(candidate));
}

/**
 * **查询**当前连接状态（`connection:state`）。
 *
 * 为什么查询与推送（通道同名，都叫 `connection:state`）必须都存在：窗口现在**先出来**、连接
 * 放到后面，它挂载的那一刻可能已经错过了一次状态变化 —— 只靠推送会漏，只靠查询又拿不到之后的
 * 变化。两个合起来才完整：先查一次当前值，再听推送（见 `stores/connection.ts` 的 `startWatching`）。
 *
 * main 那边永不抛错：还没 `start()` 时它答的就是事实本身（`connecting` / `attempt 0`）。
 */
export function getConnectionState(): Promise<ConnectionState> {
  return call("state", () => window.electronAPI.connection.state());
}

/**
 * 手动重试一次（`connection:reconnect`）。
 *
 * 返回的是**进入 `connecting` 之后的那一瞬**，不是这一轮的结果：整轮在后台跑（最多 8 秒），
 * 把它 await 住只会让界面在那 8 秒里既没有回执也没有反馈。后续（`ready` / `connecting(N)` /
 * `error`）全靠推送 —— 所以收到的这个返回值只是「先让界面动起来」，之后会被推送继续覆盖。
 */
export function reconnectConnection(): Promise<ConnectionState> {
  return call("reconnect", () => window.electronAPI.connection.reconnect());
}

/**
 * 订阅连接状态推送，返回取消订阅函数。
 *
 * 通道名与查询**同名**（`connection:state`），走 preload 那对通用的 `on` / `off` —— 于是
 * 「查一次」与「听变化」对调用方是同一个名字，不会出现「两个名字、两份实现」各说各话。
 */
export function onConnectionState(callback: (state: ConnectionState) => void): () => void {
  return subscribeServiceEvent<ConnectionState>("connection:state", callback);
}
