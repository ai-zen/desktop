/**
 * 拉起器用例：**给了显式地址就不再拉起本机 server**（D10）。
 *
 * ## 为什么这一组只能靠计数器
 *
 * 「不拉起」这件事的全部现象就是「什么都没发生」—— 没有进程、没有端口、没有发现文件。
 * 而「什么都没发生」既可以是真的没拉，也可以是拉失败了被吞掉，也可以是拉了个空壳。所以判据
 * 只能是**那个函数被调用了几次**：注入一个只记账的 `spawn`，0 次才是 D10 在桌面端的证据。
 *
 * 同时钉住两条日志约束：跳过时**要说出去**（排查时最贵的就是「静默跳过」），而且那条日志
 * **只许出现地址、不许出现凭证**（D4：凭证不进任何会被 `cat` 出去的东西）。
 */

import { describe, expect, it } from "vitest";
import { createStartBundledServer } from "./launch.js";

/** 一个一眼能认出来的凭证：用它断言「日志里没有它」 */
const TOKEN = "dGhpcy1pcy1hLXRva2VuLW5ldmVyLWxvZ2dlZA";

/** 用户会填的那种地址（`https://` 也合法，这里用一个带子路径的 wss 把它一并覆盖到） */
const URL = "wss://ai-zen.example.com/ai-zen";

describe("拉起捆绑 server", () => {
  it("配置里给了地址：拉起函数一次都没被调用", async () => {
    const spawned: string[] = [];
    const start = createStartBundledServer({
      config: { serverUrl: URL, serverToken: TOKEN },
      // 计数器：调用了就记下来（不是抛错 —— 抛错测的是「谁先失败」，不是「有没有发生」）
      spawn: async ({ aiZenDir }) => {
        spawned.push(aiZenDir);
      },
      log: () => {},
    });

    await start({ aiZenDir: "/tmp/ai-zen-launch-test" });

    expect(spawned).toEqual([]);
  });

  it("没给地址：照旧拉起（同一个 `aiZenDir` 原样递下去）", async () => {
    const spawned: string[] = [];
    const start = createStartBundledServer({
      // 配置对象在场，只是没有地址（`undefined` = 走发现文件那老路）
      config: { serverUrl: undefined, serverToken: TOKEN },
      spawn: async ({ aiZenDir }) => {
        spawned.push(aiZenDir);
      },
      log: () => {},
    });

    await start({ aiZenDir: "/tmp/ai-zen-launch-test" });

    expect(spawned).toEqual(["/tmp/ai-zen-launch-test"]);
  });

  it("跳过拉起时那条日志带地址、且不含 token", async () => {
    const logs: string[] = [];
    const start = createStartBundledServer({
      config: { serverUrl: URL, serverToken: TOKEN },
      spawn: async () => {
        // 走到这里就说明跳过没生效：直接红，别让用例在别的地方报一个绕远的错
        throw new Error("给了显式地址却还是拉起了本机 server");
      },
      log: (message) => {
        logs.push(message);
      },
    });

    await start({ aiZenDir: "/tmp/ai-zen-launch-test" });

    // 一条、不是零条：静默跳过是查不出来的（用户只说「连不上远端」）
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain(URL);
    expect(logs[0]).toContain("不拉起本机 server");
    // 凭证一个字都不能出现（地址是配置，凭证是钥匙）
    expect(logs.join("\n")).not.toContain(TOKEN);
  });
});
