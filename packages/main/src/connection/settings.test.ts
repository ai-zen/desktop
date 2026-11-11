/**
 * 连接配置用例：位置、权限、roundtrip、「读不炸」、以及「`local` 不把残留的 serverUrl 传给连接」。
 *
 * ## 为什么这几件事必须真在盘上验
 *
 *   · **位置**（`<aiZenDir>/desktop/connection.json`）与**权限**（`0600`）都是约定：人要在排障时
 *     按同一个拼法去 `cat` 它，而「同一个用户之外的谁都不该读到」这件事只有 `stat` 能证；
 *   · **读不炸**是契约的一半（D17）：坏 JSON / 非法 `mode` / 远程却没地址，一律回默认
 *     `{ mode: "local" }`。一个手滑的文件不该变成「双击没反应」；
 *   · **`local` 传 `undefined` 而不是空串**：在客户端那边这是两种行为（空串 = 显式给了一个空
 *     值，于是不走发现文件、也不退回本机 `run/token`），所以这条只能在**传给 `createLayer`
 *     的入参**上看 —— 文件里残留着 `serverUrl` 时尤其如此；
 *   · **本地保存 = 从盘上清掉远端地址与凭证**：落盘是整份替换、不是合并，而设置页在 `local`
 *     下只发 `{ mode: "local" }` —— 于是那两个字段连带键一起消失。这是有意定的策略（不用的
 *     时候不把钥匙留在盘上），下面那组用例就是为了防止将来被「顺手改回成保留」的。
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ConnectionSettings } from "@ai-zen/desktop-shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ServerLayerOptions } from "../server/index.js";
import { ConnectionController } from "./controller.js";
import {
  DEFAULT_CONNECTION_SETTINGS,
  connectionConfigOf,
  connectionSettingsPath,
  parseConnectionSettings,
  readSettings,
  writeSettings,
} from "./settings.js";

/** 用户会填的那种地址（带子路径的 `wss://`：`parseServerUrl` 认得的四种之一） */
const REMOTE_URL = "wss://ai-zen.example.com/ai-zen";
/** 一眼能认出来的凭证：用它断言「落盘之后读回来还是它」 */
const TOKEN = "dGhpcy1pcy1hLXRva2VuLWluLWNvbm5lY3Rpb24tanNvbg";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aiz-desktop-settings-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** 直接往盘上写一份「用户手改过的」配置（绕过 `writeSettings`，用来造坏数据） */
function seed(raw: string): void {
  const file = connectionSettingsPath(dir);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, raw, "utf-8");
}

describe("配置文件的位置", () => {
  it("落在 <aiZenDir>/desktop/connection.json", () => {
    // 手拼一份期望值（而不是拿被测函数算）：拼法一变，这条就该红
    expect(connectionSettingsPath("/home/someone/.ai-zen")).toBe(
      "/home/someone/.ai-zen/desktop/connection.json",
    );
  });
});

describe("读配置", () => {
  it("文件不存在 → 默认 { mode: 'local' }，且不抛错", async () => {
    // 第一次启动之前就是这个状态：读不到配置不该让应用起不来
    expect(await readSettings(dir)).toEqual({ mode: "local" });
  });

  it("坏 JSON → 默认（手改坏了 / 写到一半被 kill）", async () => {
    seed('{"mode": "remote", "serverUrl": ');
    expect(await readSettings(dir)).toEqual({ mode: "local" });
  });

  it("mode 是非法值 → 默认（不给「猜一个最像的」的机会）", async () => {
    seed(JSON.stringify({ mode: "cloud", serverUrl: REMOTE_URL }));
    expect(await readSettings(dir)).toEqual({ mode: "local" });
  });

  it("remote 但地址是垃圾 → 默认（与坏 JSON 同一类事实：这份配置不可用）", async () => {
    seed(JSON.stringify({ mode: "remote", serverUrl: "这不是地址" }));
    expect(await readSettings(dir)).toEqual({ mode: "local" });
  });

  it("remote 但没地址 → 默认（远程模式没有地址就没有含义）", async () => {
    seed(JSON.stringify({ mode: "remote", serverToken: TOKEN }));
    expect(await readSettings(dir)).toEqual({ mode: "local" });
  });

  it("默认值是一份**拷贝**：改它不会改到那个常量", () => {
    const first = { ...DEFAULT_CONNECTION_SETTINGS };
    first.mode = "remote";
    expect(DEFAULT_CONNECTION_SETTINGS.mode).toBe("local");
  });
});

describe("写配置", () => {
  it("roundtrip：写下去的那一份能原样读回来（含远程地址与凭证）", async () => {
    const settings: ConnectionSettings = {
      mode: "remote",
      serverUrl: REMOTE_URL,
      serverToken: TOKEN,
    };

    await writeSettings(dir, settings);

    expect(await readSettings(dir)).toEqual(settings);
    // 盘上真的是它（不是只活在内存里的幻觉）
    expect(JSON.parse(readFileSync(connectionSettingsPath(dir), "utf-8"))).toEqual(settings);
  });

  it("权限 0600（文件里有凭证）", async () => {
    await writeSettings(dir, { mode: "remote", serverUrl: REMOTE_URL, serverToken: TOKEN });

    // 只有主可读写：顺手 `cat` 一下的代价是零，把它贴出去的代价不该由「记得别贴」来兜
    expect(statSync(connectionSettingsPath(dir)).mode & 0o777).toBe(0o600);
  });

  it("原子写：`.tmp` 不留残骸（先写 .tmp 再 rename）", async () => {
    await writeSettings(dir, { mode: "remote", serverUrl: REMOTE_URL, serverToken: TOKEN });

    // 残留的 .tmp 说明「写完没 rename」或「崩在 rename 之前」，而它和真文件只差一个后缀
    expect(existsSync(`${connectionSettingsPath(dir)}.tmp`)).toBe(false);
  });

  it("第二次写覆盖第一次（切回本地之后盘上就是本地）", async () => {
    await writeSettings(dir, { mode: "remote", serverUrl: REMOTE_URL, serverToken: TOKEN });
    await writeSettings(dir, { mode: "local" });

    // `serverUrl` / `serverToken` 是 `undefined`，`JSON.stringify` 会把它们整键去掉
    expect(await readSettings(dir)).toEqual({ mode: "local" });
  });
});

describe("本地保存 = 从盘上清掉远端地址与凭证（策略：不许顺手改回「保留」）", () => {
  it("remote 保存后：盘上同时有地址与凭证", async () => {
    await writeSettings(dir, { mode: "remote", serverUrl: REMOTE_URL, serverToken: TOKEN });

    expect(await readSettings(dir)).toEqual({
      mode: "remote",
      serverUrl: REMOTE_URL,
      serverToken: TOKEN,
    });
    // 读回来对不够：盘上那份也得真是它（不然「读回时又给补上了」这类错会漏网）
    const stored = JSON.parse(readFileSync(connectionSettingsPath(dir), "utf-8")) as Record<
      string,
      unknown
    >;
    expect(stored.serverUrl).toBe(REMOTE_URL);
    expect(stored.serverToken).toBe(TOKEN);
  });

  it("接着 local 保存（入参只有 { mode: 'local' }）→ 盘上只剩 mode，两个键都不在了", async () => {
    // 设置页切到本地并点「保存并重连」时发的就是这一份（见 views/settings/index.vue）
    await writeSettings(dir, { mode: "remote", serverUrl: REMOTE_URL, serverToken: TOKEN });
    await writeSettings(dir, parseConnectionSettings({ mode: "local" }));

    const settings = await readSettings(dir);
    expect(settings).toEqual({ mode: "local" });
    expect(settings.serverUrl).toBeUndefined();
    expect(settings.serverToken).toBeUndefined();

    // 关键断言：盘上**连键都没有**（用 `in` 判，不看值 —— JSON 里出现 null / "" 也算没清干净）
    const stored = JSON.parse(readFileSync(connectionSettingsPath(dir), "utf-8")) as Record<
      string,
      unknown
    >;
    expect("serverUrl" in stored).toBe(false);
    expect("serverToken" in stored).toBe(false);
  });

  it("settings.ts 自己**不主动抹**：入参里带了就照存（清掉是因为设置页不传）", () => {
    // 这条画的是「谁负责清」的边界：本文件只照存，渲染侧不传才是清掉的原因。
    // 别把它读成「保留是承诺」—— 设置页今天在 local 下只发 { mode: "local" }。
    expect(
      parseConnectionSettings({ mode: "local", serverUrl: REMOTE_URL, serverToken: TOKEN }),
    ).toEqual({ mode: "local", serverUrl: REMOTE_URL, serverToken: TOKEN });
  });
});

describe("local 模式：那两个值必须是 undefined（不是空串）", () => {
  it("映射出来就是 undefined（local 不看自己残留的那两个字段）", async () => {
    // 盘上一份「local 却残留着远端地址与凭证」的配置（手改出来的，或早先版本留下的）：
    // 读路径不因为它拒掉整份配置，但那两个值不会被传给连接
    seed(JSON.stringify({ mode: "local", serverUrl: REMOTE_URL, serverToken: TOKEN }));

    expect(connectionConfigOf(await readSettings(dir))).toEqual({
      serverUrl: undefined,
      serverToken: undefined,
    });
  });

  it("传给 createLayer 的就是 undefined（客户端靠它走发现文件 + 本机 run/token）", async () => {
    seed(JSON.stringify({ mode: "local", serverUrl: REMOTE_URL, serverToken: TOKEN }));

    const passed: ServerLayerOptions[] = [];
    const controller = new ConnectionController({
      aiZenDir: dir,
      clientInfo: { name: "@ai-zen/desktop", version: "0.0.0-test" },
      defaultCwd: () => dir,
      push: () => {},
      // 假层：只记下「建层时收到了什么」
      createLayer: (options) => {
        passed.push(options);
        return {
          manager: { invokeService: async () => undefined },
          start: async () => {},
          dispose: () => {},
        };
      },
      readSettings: () => readSettings(dir),
      writeSettings: (settings) => writeSettings(dir, settings),
      // 这条用例只看 createLayer 的入参，不关心日志（别往测试输出里写一行噪音）
      log: () => {},
    });

    await controller.start();

    expect(passed).toHaveLength(1);
    // 空串在客户端那边等于「显式给了一个空值」：不走发现文件、也不退回 run/token
    expect(passed[0]!.serverUrl).toBeUndefined();
    expect(passed[0]!.serverToken).toBeUndefined();
  });
});

describe("保存路径的校验（parseConnectionSettings）", () => {
  it("mode 非法 → 抛人话", () => {
    expect(() => parseConnectionSettings({ mode: "cloud" })).toThrow(/mode 只能是 local 或 remote/);
  });

  it("remote 但没地址 → 抛人话", () => {
    expect(() => parseConnectionSettings({ mode: "remote" })).toThrow(/没填服务端地址/);
  });

  it("地址非法 → 抛客户端包那一句（带原串，不自己另写一份校验）", () => {
    expect(() => parseConnectionSettings({ mode: "remote", serverUrl: "这不是地址" })).toThrow(
      /不是合法的服务端地址/,
    );
  });

  it("serverToken 留空是**合法**的（= 用本机 run/token，D9 明文支持）", () => {
    expect(
      parseConnectionSettings({ mode: "remote", serverUrl: REMOTE_URL, serverToken: "  " }),
    ).toEqual({ mode: "remote", serverUrl: REMOTE_URL });
  });

  it("首尾空白被去掉（用户从别处粘过来，末尾带一个换行是常事）", () => {
    expect(
      parseConnectionSettings({
        mode: "remote",
        serverUrl: ` ${REMOTE_URL}\n`,
        serverToken: ` ${TOKEN} `,
      }),
    ).toEqual({ mode: "remote", serverUrl: REMOTE_URL, serverToken: TOKEN });
  });
});
