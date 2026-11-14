/**
 * 历史图片回显那层账：**段上的素材引用 → `blob:` URL**，以及「一份素材一屏只取一次」。
 *
 * 这里钉住四件事（都是需求里明说的）：
 *
 *   1. 只有 `image_url` + 带素材引用的段要显示（别的段一个都不管）；
 *   2. 同一个 `variant + assetId` 只走一次 `chat.getAsset` —— 两条消息引用同一张图也只取一次；
 *   3. 最后一个使用者卸载时 `URL.revokeObjectURL`；之后再用就重新取（不落盘、不过期）；
 *   4. 交给视图的那些值里没有 `__asset_id`、没有 base64、没有 `assets/` 绝对路径 —— 细节都在
 *      `blob:` URL 里，界面上与 DOM 里什么都看不见。
 *
 * render 的用例环境没有 DOM（见 `vitest.config.ts`），所以这里验的是「交给模板的那份数据」，
 * 而不是渲染出来的 HTML：`blob:` 这个前缀就是模板唯一会读的东西。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentNS } from "@ai-zen/agents-core";
import type { AssetContent, AssetVariant } from "@ai-zen/desktop-shared";

const mocks = {
  getChatAsset: vi.fn<(assetId: string, variant: AssetVariant) => Promise<AssetContent>>(),
};

/** 每份素材的整份引用（宽高在里面）+ 字节（字节内容是假的：这一层不读字节，只把它塞进 Blob） */
function bytesOf(): AssetContent {
  return {
    asset: { assetId: "a1", mime: "image/png", bytes: 4, name: "图.png", width: 800, height: 600 },
    variant: "thumb",
    bytes: Uint8Array.from([137, 80, 78, 71]),
  };
}

/** 落库形态的内容段：core 的段 + 本地扩展字段（宿主存的就是这个形状） */
type StoredSection = AgentNS.MessageContentSection & { __asset_id?: string };

/**
 * 模块级状态（那份缓存）要做用例之间清零，所以每个用例重新 import 一次。
 *
 * `vi.resetModules()` 之后 `deps` 也是新一代的那份：注入必须紧跟着做，否则改的是上一代
 * 对象，新的 `assetImages` 根本看不到。
 */
async function module(): Promise<typeof import("./assetImages.js")> {
  vi.resetModules();
  const { stubDeps } = await import("../deps.js");
  stubDeps({ api: { getChatAsset: mocks.getChatAsset } });
  return await import("./assetImages.js");
}

let created = 0;
const revoked: string[] = [];

beforeEach(() => {
  created = 0;
  revoked.length = 0;
  mocks.getChatAsset.mockReset();
  mocks.getChatAsset.mockImplementation(async () => bytesOf());
  // Node 里有真的 createObjectURL，但用例要一个能数清楚的假 URL
  vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:test/${++created}`);
  vi.spyOn(URL, "revokeObjectURL").mockImplementation((url: string) => {
    revoked.push(url);
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  const { resetDeps } = await import("../deps.js");
  resetDeps();
});

// ==================================================================
// 哪一段要显示
// ==================================================================

describe("认出历史图片", () => {
  it("只看 `image_url` 且带素材引用的段（文本 / 文件段一个都不管）", async () => {
    const { imageAssetIds } = await module();
    const content: StoredSection[] = [
      { type: "text", text: "这张图里的报错是什么？" },
      { type: "image_url", image_url: { url: "" }, __asset_id: "a1" },
      // 没有素材引用（比如别的前端存下来的一条远端 url）：不归这条路
      { type: "image_url", image_url: { url: "https://example.test/x.png" } },
      { type: "file", filename: "报表.pdf", __asset_id: "a2" },
      { type: "image_url", image_url: { url: "" }, __asset_id: "  a3  " },
    ];

    expect(imageAssetIds(content)).toEqual(["a1", "a3"]);
  });

  it("字符串正文 / 空内容 / 空白 id 都不算图片", async () => {
    const { imageAssetIds, assetIdOf } = await module();
    const noAsset: StoredSection = { type: "image_url", image_url: { url: "" } };
    const blankAsset: StoredSection = { type: "image_url", image_url: { url: "" }, __asset_id: "   " };

    expect(imageAssetIds("只有一句话")).toEqual([]);
    expect(imageAssetIds(undefined)).toEqual([]);
    expect(assetIdOf(noAsset)).toBeNull();
    expect(assetIdOf(blankAsset)).toBeNull();
  });
});

// ==================================================================
// 取字节与回收
// ==================================================================

describe("一份素材一屏只取一次", () => {
  it("两条消息引用同一张图：只走一次 chat.getAsset，拿到同一个 blob URL 与同一份尺寸", async () => {
    const { acquireAsset } = await module();

    const first = await acquireAsset("a1", "thumb");
    const second = await acquireAsset("a1", "thumb");

    expect(mocks.getChatAsset).toHaveBeenCalledTimes(1);
    expect(mocks.getChatAsset).toHaveBeenCalledWith("a1", "thumb");
    expect(first).toBe(second);
    expect(first.url).toBe("blob:test/1");
    // 尺寸跟着一起回来：界面按它先摆占位框（R76）
    expect([first.width, first.height]).toEqual([800, 600]);
  });

  it("并发挂载（同一屏一起上）：也只发一次", async () => {
    const { acquireAsset } = await module();

    const assets = await Promise.all([
      acquireAsset("a1", "thumb"),
      acquireAsset("a1", "thumb"),
      acquireAsset("a1", "thumb"),
    ]);

    expect(mocks.getChatAsset).toHaveBeenCalledTimes(1);
    expect(new Set(assets.map((asset) => asset.url)).size).toBe(1);
  });

  it("缩略图与原图是两次取（档位真的传下去了）", async () => {
    const { acquireAsset } = await module();

    const thumb = await acquireAsset("a1", "thumb");
    const original = await acquireAsset("a1", "original");

    expect(mocks.getChatAsset.mock.calls).toEqual([
      ["a1", "thumb"],
      ["a1", "original"],
    ]);
    expect(thumb.url).not.toBe(original.url);
  });

  it("最后一个使用者卸载才回收；之后再用重新取（不落盘、不过期）", async () => {
    const { acquireAsset, releaseAssetUrl } = await module();

    const asset = await acquireAsset("a1", "thumb");
    await acquireAsset("a1", "thumb");

    releaseAssetUrl("a1", "thumb");
    expect(revoked).toEqual([]);

    releaseAssetUrl("a1", "thumb");
    expect(revoked).toEqual([asset.url]);

    // 再要一次：取第二遍，拿一个新的 URL
    const again = await acquireAsset("a1", "thumb");
    expect(mocks.getChatAsset).toHaveBeenCalledTimes(2);
    expect(again.url).toBe("blob:test/2");
  });

  it("没有使用权时重复释放不炸（卸载路径会被走两遍）", async () => {
    const { releaseAssetUrl } = await module();

    releaseAssetUrl("没人在用的", "thumb");
    expect(revoked).toEqual([]);
  });

  it("字节回来之前使用者就走光了：那一份当场回收", async () => {
    const { acquireAsset, releaseAssetUrl } = await module();
    mocks.getChatAsset.mockImplementation(
      () => new Promise<AssetContent>((resolve) => setTimeout(() => resolve(bytesOf()), 5)),
    );

    const pending = acquireAsset("a1", "thumb");
    releaseAssetUrl("a1", "thumb");
    const asset = await pending;

    expect(revoked).toEqual([asset.url]);
  });
});

// ==================================================================
// 不泄漏
// ==================================================================

describe("交给视图的值里没有内部字段", () => {
  it("图片 id 与 blob URL 里都没有 `__asset_id` / base64 / `assets/` 路径", async () => {
    const { imageAssetIds, acquireAsset } = await module();
    const content: StoredSection[] = [
      { type: "text", text: "看图" },
      {
        type: "image_url",
        image_url: { url: "" },
        __asset_id: "0f9c4a1e-3b7d-4f2a-9c55-1d2e3f4a5b6c",
      },
    ];

    const ids = imageAssetIds(content);
    const url = (await acquireAsset(ids[0] ?? "", "thumb")).url;

    // 模板唯一会读的就是这两个值：一个是 key / prop，一个是 <img src>
    const handedToView = [ids.join(" "), url].join(" ");
    expect(url.startsWith("blob:")).toBe(true);
    expect(handedToView).not.toContain("__asset_id");
    expect(handedToView).not.toContain("base64");
    expect(handedToView).not.toContain("assets/");
    // 没有一整段 base64 被塞进 URL 里（真图放上去就会长这样）
    expect(url).not.toMatch(/[A-Za-z0-9+/]{32,}={0,2}/);
  });
});
