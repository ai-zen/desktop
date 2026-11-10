/**
 * 「打一次协议调用」这一件事 —— 本层与连接之间的唯一接缝。
 *
 * ## 为什么需要它（`ServerConnection` 上没有 `call`）
 *
 * 包里那个 `ServerConnection`（`@ai-zen/agents-client` 的 `transport/connection.ts`）只管
 * **「哪条连接」**：判活、重建、重放 `events.watch`、上报断开与就绪。它刻意不管「怎么发一个
 * 请求」——所以 `call` 在 `ServerClient` 上，而要拿到一条**活着**的 `ServerClient`，必须
 * 每次都问它要（`client()`）。
 *
 * 这个文件就是那一行。它的全部价值在于**不缓存**：本层曾经把连接缓存在一个字段里、建成
 * 之后不再复查 `closed`，结果 daemon 重启一次，桌面端永久失能（每一次调用都撞在一条已经
 * destroy 的 socket 上，而界面看起来只是「没反应」）。把这个动作收在一个函数里，就没有第二
 * 处可以偷偷存下一份 client。
 *
 * ## 为什么不直接在 `services.ts` 里写那两行
 *
 * 六个 Service 与事件翻译器都要发请求，各写一遍就是六份「取连接 → 调用」—— 那种复制不会
 * 立刻出错，但它让「以后要不要在中间加点什么（重试、超时、埋点）」变成六处决定。这里只有
 * 一处。
 */

import type { ServerConnection } from "@ai-zen/agents-client";

/**
 * 一次协议调用：`method` 是协议里的方法名（来自 `SESSION_METHODS` 这类常量表），返回值由
 * 调用点用类型参数指定（协议漏了一个字段，那边编译不过）。
 */
export type ProtocolCall = <T>(method: string, params?: unknown) => Promise<T>;

/**
 * 从一条常驻连接上借一条**活着**的 `ServerClient` 去打一次调用。
 *
 * `connection.client()` 每次都会判 `closed`（关了就地重建），所以这里取到的连接一定是能用
 * 的那一条 —— 本函数因此不持有任何状态。
 */
export function protocolCall(connection: ServerConnection): ProtocolCall {
  return async <T,>(method: string, params?: unknown): Promise<T> =>
    await (await connection.client()).call<T>(method, params);
}
