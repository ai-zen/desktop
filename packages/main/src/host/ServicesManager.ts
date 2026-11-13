/**
 * 服务管理器 — `invokeService` 动态分发（对应 render 的 `apis/base.ts` 的 invokeService）。
 *
 * ## 为什么还留着一层「动态分发」
 *
 * IPC 的面是 `invokeService(service, method, ...args)`：render 用的是字符串键（
 * `invokeService("workspace", "create", ...)`），这是已冻结的对外协议，**render 一行不改**
 * 是硬约束 —— 所以 main 侧必须有一张「字符串键 → 实例」的表来承接。
 *
 * ## 为什么表本身是强类型的（而不是 `Record<string, unknown>`）
 *
 * 弱类型表会让「组装时少写一个键」「键名拼错成 `workSpace`」变成运行期才报的 500。这里
 * 把表声明成 `HostServiceMap`，组装点（`host/index.ts`）就受编译检查：六个键一个都
 * 不能少、不能多、不能拼错。**分发键（`workspace` / `conversation` / `agent` / `model` /
 * `chat` / `config`）是 render 的调用面**，不许跟着实现改名。
 *
 * ## 为什么放在 `host/` 而不是单独一个 `services/` 目录
 *
 * 它分发的是 `HostXxxService`（`host/services.ts`），唯一构造点也在 `host/index.ts`，
 * 所以这条依赖是同目录内的。
 */

import type {
  HostAgentService,
  HostChatService,
  HostConfigService,
  HostConversationService,
  HostModelService,
  HostWorkspaceService,
} from "./services.js";

/** `service` 字符串键 → 服务实例。键即 render 的调用面，见文件头。 */
export type HostServiceMap = {
  workspace: HostWorkspaceService;
  conversation: HostConversationService;
  agent: HostAgentService;
  model: HostModelService;
  chat: HostChatService;
  config: HostConfigService;
};

export class ServicesManager {
  constructor(private readonly services: HostServiceMap) {}

  async invokeService(
    service: string,
    method: string,
    ...args: unknown[]
  ): Promise<unknown> {
    // service / method 是 IPC 边界上过来的字符串，编译期只能按 string 查；查不到说明
    // render 与 main 的协议错配，报出具体键名（静默返回 undefined 只会变成更难查的空结果）
    const table: Record<string, unknown> = this.services;
    const instance = table[service];
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
