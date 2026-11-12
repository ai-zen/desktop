/**
 * 本层与客户端库之间的那条**窄接缝**：连接上真正被用到的几件事。
 *
 * ## 为什么不用库里的 `Client` 类当参数类型
 *
 * 这里要的是「调一个契约方法、订一个事件、断了重连」，而不是「一个 `Client` 实例」。把类写进
 * 签名，用例就只能去假造一个类（或者起一条真 socket），而这些逻辑里没有一行需要真的网络。
 * `Client` 在结构上本来就满足这个接口（它不多不少正好有这些方法），所以生产路径不需要断言、
 * 也不需要适配。
 *
 * ## 事件与方法的形状一个都不在这里重写
 *
 * `MethodName` / `MethodParams` / `MethodResult` / `EventName` / `EventPayload` 全部从
 * `@ai-zen/agents-client` 转出（它又原样转自服务端的 `wire/`）。改契约时这一层编译不过，
 * 而不是运行期才发现某个方法不存在。
 */

import type {
  ClientError,
  EventName,
  EventPayload,
  MethodCallArgs,
  MethodName,
  MethodResult,
  ResumedConversation,
  ResumeOutcome,
  ServerHelloResult,
  Unsubscribe,
} from "@ai-zen/agents-client";

/** 调一次契约方法（方法名与入参/出参由服务端的方法表推出来） */
export type ContractCall = <M extends MethodName>(
  method: M,
  ...args: MethodCallArgs<M>
) => Promise<MethodResult<M>>;

/**
 * 「一条到服务端的连接」在本层眼里的样子。
 *
 * 全部是**连接级**的能力：没有一个方法要求「记住哪一条 socket」—— 客户端库内部会在重连时换掉
 * 底层 socket，而上层手上的这个对象不变（订阅、`track` 的对话、锚点都跟着对象走）。
 */
export interface ContractConnection {
  call: ContractCall;
  /** 订阅一个推送事件；返回取消订阅 */
  subscribe<E extends EventName>(event: E, handler: (payload: EventPayload<E>) => void): Unsubscribe;
  /** 订阅「断了」（一次成功握手之后真的断了才有） */
  onClose(handler: (error: ClientError) => void): Unsubscribe;
  /** 订阅「补拉结果」（重连之后库自己补 `track` 过的对话） */
  onResume(handler: (outcome: ResumeOutcome) => void): Unsubscribe;
  /** 手动补拉一段对话（`conversation.state` + `message.list({after})`） */
  resume(conversationId: string, after?: string): Promise<ResumedConversation>;
  /** 让这条连接记住「这段对话要跟着」：重连之后自动补拉 */
  track(conversationId: string, anchor?: string): void;
  /** 不再跟着这段对话 */
  untrack(conversationId: string): void;
  /** 换一条 socket 重新握手（连上之后自动补拉 `track` 过的对话） */
  reconnect(): Promise<void>;
  /** 关掉这条连接 */
  close(): Promise<void>;
  /** 握手回执（语言、服务端版本、能力 id、附件上限）；没握手成功时为空 */
  readonly hello: ServerHelloResult | null;
}
