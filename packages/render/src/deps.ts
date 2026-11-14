/**
 * 可替换的依赖入口：store 与外面世界的两个接触面 —— IPC 那层的 `apis/*`，以及弹提示
 * （`element-plus` 的 `ElMessage`）。
 *
 * ## 为什么要这一层
 *
 * render 的用例故意关掉了 vitest 的隔离（见 `vitest.config.ts`），而 `vi.mock` 是按模块说明符
 * **进程级**注册替身的：一个文件塞进去的替身会留在共享模块图里，串到下一个文件（实测：
 * 单跑绿、两条合跑就红）。于是替身改成**显式注入** —— 用例写 `stubDeps({ api: {...} })`，
 * 跑完 `resetDeps()` 收回真件。
 *
 * ## 为什么是整份换而不是逐键覆盖
 *
 * `stubDeps` **不给默认值**：没写进 `api` 的键当场不存在。用例用它圈出「这条路径上只该发生
 * 这几件事」—— 没声明的那条依赖一旦被调到就是 `xxx is not a function` 的硬错，而不是悄悄
 * 打到真 IPC 上、在某台机器上绿得毫无意义。
 *
 * ## 产品里没人替换它
 *
 * 视图组件（`App.vue`、设置面板）直接用真 `apis/*` 与 `ElMessage`：它们是装配与呈现层，
 * 没有 DOM 用例去换东西（见 `vitest.config.ts`）。会被人替换的只有 store 这一层。
 */

import { ElMessage } from "element-plus";
import * as apis from "./apis/index.js";

/** `apis/*` 的全部导出（与 main 的 services 一一对应） */
export type Apis = typeof apis;

/** toast 的三档语气（`ElMessage` 今天只用到这三个入口） */
export interface Notify {
  info: (text: string) => void;
  warning: (text: string) => void;
  error: (text: string) => void;
}

export interface Deps {
  api: Apis;
  notify: Notify;
}

/**
 * 真件那一份（= `apis/*` 的全部导出）。
 *
 * 导出是为了让用例能写「只换 `connection` 那几条、其余照旧打真 IPC」—— 连接面板的用例要把
 * 界面重拉的数据真的走一遍假宿主（`window.electronAPI` 是假的，`apis/*` 是真的），那里混用。
 */
export const realApi: Apis = { ...apis };
const realNotify: Notify = {
  info: (text) => ElMessage.info(text),
  warning: (text) => ElMessage.warning(text),
  error: (text) => ElMessage.error(text),
};

export const deps: Deps = { api: realApi, notify: realNotify };

/**
 * 换掉这一层（用例用）：`api` 就是这一份、不多不少；`notify` 没给的那几档保持真件。
 */
export function stubDeps(next: { api?: Partial<Apis>; notify?: Partial<Notify> }): void {
  deps.api = (next.api ?? {}) as Apis;
  deps.notify = { ...realNotify, ...next.notify };
}

/**
 * 收回真件（用例的 `afterEach` 里调）。
 *
 * 不收回就会串到下一个用例文件 —— 这正是关掉隔离之后由用例自己承担的那部分：进程只有一个，
 * 谁留下的状态谁收。
 */
export function resetDeps(): void {
  deps.api = realApi;
  deps.notify = realNotify;
}
