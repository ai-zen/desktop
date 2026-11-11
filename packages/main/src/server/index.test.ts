/**
 * 组装根用例：显式地址与凭证**真的到了连接上**（D9 / D14）。
 *
 * ## 为什么这一组必须用真 daemon
 *
 * 「透传」最容易写成一句空断言：把两个值递给构造函数然后断言「没抛错」。那样测出来的是
 * TypeScript 的类型对不对，而不是**那两个值有没有走到线上** —— 而线上那两头（地址选哪台、
 * 凭证能不能进门）恰恰是这轮唯一会坏的地方。
 *
 * 所以这里起**两台**真 daemon，各自报不同的工作区名：拿到哪一台的答案，就说明地址真的
 * 指向了那一台；而两台都**不写** `<dir>/run/token`（凭证是注入的），于是能进门这件事只可能
 * 来自配置里那把钥匙。两条都是可观测事实，不是「没抛错」。
 *
 * ## 三条用例各钉一件事
 *
 *   1. 地址 + 凭证都对 → 连上的是**配置里那台**（返回值的 workspaceId 是它的）；
 *   2. 凭证换成错的 → `unauthorized`（说明凭证真的进了 `hello`，而不是被忽略后读了本机文件）；
 *   3. 地址指向没人监听的地方（发现文件却指着活的那台）→ 报错里是**那个地址**，说明地址没被
 *      悄悄换成发现文件里的那个。
 *
 * D10（给了地址就不拉起本机 server）的计数判据在 `launch.test.ts`：那是唯一能看见
 * 「有没有拉起」的位置。
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon, type AnyHandler } from "@ai-zen/agents-server";
import { afterEach, describe, expect, it } from "vitest";
import { createServerLayer, type ServerLayer } from "./index.js";

/** 握手自称的身份（与桌面端一致） */
const CLIENT_INFO = { name: "@ai-zen/desktop", version: "0.0.0-test" };

/** 一台测试 daemon（一台 = 一个临时目录 + 一个自己的凭证 + 一个真端口） */
interface Fixture {
  dir: string;
  token: string;
  port: number;
  daemon: Daemon;
}

const servers: Fixture[] = [];
const layers: ServerLayer[] = [];

afterEach(async () => {
  for (const layer of layers.splice(0)) layer.dispose();
  for (const fixture of servers.splice(0)) {
    await fixture.daemon.stop("test teardown");
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

/**
 * 起一台 daemon：`workspaceId` 既是它答的话，也是它的名字（用例靠返回值分辨是谁答的）。
 *
 * 凭证**注入**（不走 `<dir>/run/token`）：这样「连接能进门」就只可能来自配置里那把钥匙 ——
 * 否则本机文件那条路会让用例变成绿的，而它绿的原因与被测的东西无关。
 */
async function startDaemon(workspaceId: string): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), "aiz-desktop-index-"));
  const token = `token-of-${workspaceId}`;
  const handlers: Record<string, AnyHandler> = {
    // `layer.start()` 会发这一帧（订阅是连接级的）：给一条成功的回执就够，内容无人读
    "events.watch": () => ({ watching: true }),
    // 业务方法：返回值里写着「我是哪一台」
    "workspace.list": () => ({
      workspaces: [
        {
          workspaceId,
          path: `/tmp/${workspaceId}`,
          title: `工作区 ${workspaceId}`,
        },
      ],
    }),
  };
  const daemon = new Daemon({
    aiZenDir: dir,
    port: 0,
    version: "0.0.0-test",
    token,
    handlers,
  });
  await daemon.start();
  const fixture: Fixture = { dir, token, port: daemon.port, daemon };
  servers.push(fixture);
  return fixture;
}

/** 造一层服务端门面（用例只关心两个透传值，其余按桌面端的缺省给） */
function layerFor(
  aiZenDir: string,
  config: { serverUrl?: string; serverToken?: string },
): ServerLayer {
  const layer = createServerLayer({
    aiZenDir,
    clientInfo: CLIENT_INFO,
    defaultCwd: () => aiZenDir,
    push: () => {},
    serverUrl: config.serverUrl,
    serverToken: config.serverToken,
  });
  layers.push(layer);
  return layer;
}

describe("组装根：地址与凭证透传", () => {
  it("都给了：连的是配置里那台，用的是配置里那把钥匙", async () => {
    // 发现文件指着 `local`，配置里的地址指着 `remote`：两者不是同一台，才分得出用了哪个
    const local = await startDaemon("local");
    const remote = await startDaemon("remote");

    // 凭证是注入的 → 两台都没有 `<dir>/run/token`，于是「能进门」只可能来自 `serverToken`
    expect(existsSync(join(remote.dir, "run", "token"))).toBe(false);

    const layer = layerFor(local.dir, {
      serverUrl: `ws://127.0.0.1:${remote.port}`,
      serverToken: remote.token,
    });

    await layer.start();

    // 返回值里写着台名：拿到 `remote` 的工作区 = 地址真的被用上了（不是发现文件里那台）
    expect(await layer.manager.invokeService("workspace", "list")).toEqual([
      { id: "remote", name: "工作区 remote", cwd: "/tmp/remote" },
    ]);
  });

  it("凭证不对：握手被拒（`unauthorized`），说明它真的进了 hello", async () => {
    const remote = await startDaemon("remote");
    const layer = layerFor(remote.dir, {
      serverUrl: `ws://127.0.0.1:${remote.port}`,
      // 地址对、钥匙错：被拒的原因只能是被递上去的那串凭证不对
      serverToken: "not-the-key",
    });

    await expect(layer.start()).rejects.toThrow(/unauthorized/);
  });

  it("地址没被忽略：连不上时报的是配置里那个地址", async () => {
    // 发现文件指着活着的 `local`：地址若被无视，这一次连压根不会失败
    const local = await startDaemon("local");
    const layer = layerFor(local.dir, {
      serverUrl: "ws://127.0.0.1:1",
      serverToken: local.token,
    });

    await expect(layer.start()).rejects.toThrow("127.0.0.1:1");
  });
});
