/**
 * 连接设置的**映射层**用例（`connection/settings.ts`）。
 *
 * 读写规则、原子写、`0600`、坏文件不抛、地址校验、界面那一行字，全部在客户端库里（它有自己的
 * 用例）。本仓这一层只剩两件事，所以这里只钉这两件：
 *
 *   1. **两份字段名之间的映射**：桌面对外叫 `serverUrl` / `serverToken`，库里叫 `url` / `token`；
 *   2. **`local` 必须吐 `undefined`**（空串在库里是「显式给了个空值」，于是它不走发现文件、也不读
 *      本机凭证 —— 那条路上没有人会让它成功）。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  connectionConfigOf,
  describe as describeConnection,
  labelOf,
  parseConnectionSettings,
  readSettings,
  settingsFilePath,
  writeSettings,
} from "./settings.js";

const REMOTE_URL = "wss://ai-zen.example.com/ai-zen";
const TOKEN = "dGhpcy1pcy1hLXRva2VuLW5ldmVyLWxvZ2dlZA";

let dir: string | null = null;

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = null;
});

async function tempRoot(): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), "aiz-desktop-settings-"));
  return dir;
}

describe("递进连接层的两个值", () => {
  it("local：两个都是 `undefined`（不是空串）", () => {
    expect(connectionConfigOf({ mode: "local" })).toEqual({
      serverUrl: undefined,
      serverToken: undefined,
    });
  });

  it("local 就算盘上残留着地址与凭证，照旧吐 `undefined`（它们不会被使用）", () => {
    expect(connectionConfigOf({ mode: "local", serverUrl: REMOTE_URL, serverToken: TOKEN })).toEqual({
      serverUrl: undefined,
      serverToken: undefined,
    });
  });

  it("remote：原样交出去", () => {
    expect(connectionConfigOf({ mode: "remote", serverUrl: REMOTE_URL, serverToken: TOKEN })).toEqual({
      serverUrl: REMOTE_URL,
      serverToken: TOKEN,
    });
  });
});

describe("校验（IPC 边界）", () => {
  it("remote 没填地址：抛人话", () => {
    expect(() => parseConnectionSettings({ mode: "remote" })).toThrow(/没填服务端地址/);
  });

  it("地址不合法：抛的那句带原串（用户认得出自己填了什么）", () => {
    // 文案是客户端库的 `bad_address`（它固定英文，语言参数没透传过去 —— 已记进交付报告）；
    // 这里要钉的是「原串在里面」，那是用户唯一认得出来的那一半
    expect(() => parseConnectionSettings({ mode: "remote", serverUrl: "ws://" })).toThrow(/ws:\/\//);
  });

  it("mode 不合法：抛人话（不是静默回落到 local）", () => {
    expect(() => parseConnectionSettings({ mode: "tunnel" })).toThrow(/mode 只能是 local 或 remote/);
  });

  it("local：残留的地址与凭证被丢掉（不该跟着落盘）", () => {
    expect(parseConnectionSettings({ mode: "local", serverUrl: REMOTE_URL, serverToken: TOKEN })).toEqual({
      mode: "local",
    });
  });

  it("remote：两个字段换回桌面端的名字", () => {
    expect(parseConnectionSettings({ mode: "remote", serverUrl: REMOTE_URL, serverToken: TOKEN })).toEqual({
      mode: "remote",
      serverUrl: REMOTE_URL,
      serverToken: TOKEN,
    });
  });
});

describe("界面那一行字与日志那一句话", () => {
  it("local 是本机服务端", () => {
    expect(labelOf({ mode: "local" })).toBe("本机服务端");
  });

  it("remote 是那个地址，且**绝不含凭证**", () => {
    const label = labelOf({ mode: "remote", serverUrl: REMOTE_URL, serverToken: TOKEN });
    expect(label).toBe(REMOTE_URL);
    expect(label).not.toContain(TOKEN);
  });

  it("地址里写了 userinfo（wss://user:secret@host）也要抹掉", () => {
    const label = labelOf({ mode: "remote", serverUrl: "wss://user:secret@ai-zen.example.com/ai-zen" });
    expect(label).toBe("wss://ai-zen.example.com/ai-zen");
    expect(label).not.toContain("secret");
  });

  it("进日志的那句话只说模式与地址", () => {
    const text = describeConnection({ mode: "remote", serverUrl: REMOTE_URL, serverToken: TOKEN });
    expect(text).toContain(REMOTE_URL);
    expect(text).not.toContain(TOKEN);
  });
});

describe("落点与读写", () => {
  it("落点是 <数据根>/desktop/connection.json（cli 那份归 CLI）", () => {
    expect(settingsFilePath("/data/ai-zen")).toBe(join("/data/ai-zen", "desktop", "connection.json"));
  });

  it("没配过时读回 `null`（首启的判据，不是 `{mode:'local'}`）", async () => {
    expect(await readSettings(await tempRoot())).toBeNull();
  });

  it("写进去再读回来：字段名换了一圈还是同一份", async () => {
    const root = await tempRoot();

    await writeSettings(root, { mode: "remote", serverUrl: REMOTE_URL, serverToken: TOKEN });

    expect(await readSettings(root)).toEqual({
      mode: "remote",
      serverUrl: REMOTE_URL,
      serverToken: TOKEN,
    });
  });

  it("local 落盘之后读回来只有 mode（不带着上一次的远程地址）", async () => {
    const root = await tempRoot();
    await writeSettings(root, { mode: "remote", serverUrl: REMOTE_URL, serverToken: TOKEN });

    await writeSettings(root, { mode: "local" });

    expect(await readSettings(root)).toEqual({ mode: "local" });
  });
});
