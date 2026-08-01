/**
 * base — 与主进程服务通信的基础封装（对应 main 的 ServicesManager）。
 *
 * 普通前后端分离心智：
 *   - apis/*.ts 是业务 API，每个文件对应 main 的一个 service（前后端一一对应）；
 *   - base 只做两件事：把调用送出去（invokeService）、把事件接进来（subscribeServiceEvent）；
 *   - 错误统一收敛为 InvokeServerError，UI 层直接展示 message。
 */

/** 服务调用错误（统一错误信息，供 UI 展示） */
export class InvokeServerError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "InvokeServerError";
  }

  static from(error: unknown): InvokeServerError {
    const message = error instanceof Error ? error.message : String(error);
    return new InvokeServerError(message, { cause: error });
  }
}

/**
 * 调用主进程服务：invokeService("workspace", "list")。
 * service / method 与 main ServicesManager 的动态分发一一对应。
 */
export async function invokeService<T>(
  service: string,
  method: string,
  ...args: unknown[]
): Promise<T> {
  try {
    return await window.electronAPI.invokeService<T>(service, method, ...args);
  } catch (error) {
    console.error(`[invokeService] ${service}.${method}`, error);
    throw InvokeServerError.from(error);
  }
}

/**
 * 订阅主进程推送事件（如 chat:push），返回取消订阅函数。
 * payload 即业务数据（preload 已剥离 event）。
 */
export function subscribeServiceEvent<T>(
  channel: string,
  callback: (payload: T) => void,
): () => void {
  const wrapper = (payload: unknown) => callback(payload as T);
  window.electronAPI.on(channel, wrapper);
  return () => window.electronAPI.off(channel, wrapper);
}
