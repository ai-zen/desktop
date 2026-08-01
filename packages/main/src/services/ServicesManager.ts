/**
 * 服务管理器 — invokeService 动态分发（对应 render 的 apis/base.ts invokeService）。
 *
 * 注册：{ serviceName: serviceInstance }。
 * serviceName / method 与 render 的 apis/*.ts 一一对应：
 *   invokeService("workspace", "create", ...) → WorkspaceService.create(...)
 */

export class ServicesManager {
  constructor(private services: Record<string, unknown>) {}

  async invokeService(
    service: string,
    method: string,
    ...args: unknown[]
  ): Promise<unknown> {
    const instance = this.services[service];
    if (!instance) {
      throw new Error(`未知服务: ${service}`);
    }
    const fn = (instance as Record<string, unknown>)[method];
    if (typeof fn !== "function") {
      throw new Error(`服务 ${service} 无方法: ${method}`);
    }
    return await (fn as (...a: unknown[]) => unknown).call(instance, ...args);
  }
}
