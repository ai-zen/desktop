/**
 * 历史图片 → 气泡里的 `<img>`：从「段上的素材引用」走到一个 `blob:` URL。
 *
 * ## 这一层只做三件事
 *
 *   1. **认出哪一段是图**：`type === "image_url"` 且带素材引用（{@link assetIdOf}）；
 *   2. **取字节**：`chat.getAsset` → `Blob` → `URL.createObjectURL`（字节与服务端那一趟都在
 *      main：render 没有到服务端的连接，也没有 Node 的 `Buffer`）；
 *   3. **一份素材一屏只取一次**：按 `variant + assetId` 在内存里存那个 `blob:` URL 与它的像素
 *      尺寸，谁要谁领一份使用权；最后一个使用者走的时候 `URL.revokeObjectURL`。
 *
 * ## 宽高一起交给视图（R76）
 *
 * `asset.get` 回包里带着服务端从文件头解出来的 `width` / `height`，所以视图在拿到字节的同一刻就
 * 知道这张图该占多大：`AssetImage.vue` 按这两个数把外层框先撑成原比例，解码完成前后同一个尺寸，
 * 气泡不会因为「图来了」而跳一下。解不出来（`null`）就不撑框 —— 不做兜底分支，界面按图片自己的
 * 尺寸出现。
 *
 * ## 为什么读 `__asset_id` 的这几行在这里，而不从客户端库 import
 *
 * 消息里只有段上的本地扩展字段 `__asset_id`（`image_url.url` 是空的），所以「这一段要不要走
 * 素材通道」只能看那个字段。客户端库（`@ai-zen/agents-client`）里有一个同口径的
 * `localAssetIdOf`，但那个包是 **Node 侧**的（`node:fs` / `node:crypto`），render 的产物是
 * 浏览器包，import 不进来。于是这里留一份逐字同口径的三行判断：
 *
 *   - 只看字段在不在、是不是非空字符串，**不解析任何 url**（段上的 url 是什么都不影响结论）；
 *   - 这个字段名在本仓只出现在**这一处**（视图、DOM、IPC 里都没有它），换个名字要改的也就是它。
 *
 * ## 不做的事
 *
 * 不重试、不判失效、不过期、不落盘（PRD F-H8 对素材的口径就是不自动重试）：取不到就照原样
 * 抛出去，控制台里能看见那条错误，界面上不出现这张图。
 */

import type { AgentNS } from "@ai-zen/agents-core";
import type { AssetVariant } from "@ai-zen/desktop-shared";
import { getChatAsset } from "../apis/chat.js";

/**
 * 一个内容段引用的素材 id（没有这个字段就是 `null`）。
 *
 * 空串 / 空白按「没写」处理，与服务端 `localAssetIdOf` 同口径。
 */
export function assetIdOf(section: AgentNS.MessageContentSection): string | null {
  const value = (section as { __asset_id?: unknown }).__asset_id;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * 一条消息里要按图片显示的素材 id（按段落出现的顺序）。
 *
 * 只认 `image_url` 段：文件附件（`file` 段）这一波没有显示形态，远端 url 的图片也不是素材
 * ——两者都不在这里出现，气泡对它们的处理与以前一样。
 */
export function imageAssetIds(content: AgentNS.MessageContent | undefined): string[] {
  if (!Array.isArray(content)) return [];
  const ids: string[] = [];
  for (const section of content) {
    if (section.type !== "image_url") continue;
    const assetId = assetIdOf(section);
    if (assetId !== null) ids.push(assetId);
  }
  return ids;
}

/**
 * 一份取回来的素材在界面上的样子：`blob:` URL + 它的像素尺寸（供气泡先摆占位框）。
 *
 * `width` / `height` 是原图的像素尺寸（服务端从文件头解出来的）；解不出来时是 `null`，那时不设
 * 占位比例 —— 图片按自己的尺寸出现。
 */
export interface LoadedAsset {
  url: string;
  width: number | null;
  height: number | null;
}

/** 一份素材在本屏的持有情况：URL（字节回来之前是 `null`）、使用者个数、正在跑的那次取字节 */
interface Lease {
  url: string | null;
  users: number;
  pending: Promise<LoadedAsset> | null;
}

/** 本屏的缓存：`variant:assetId` → 那份素材 */
const leases = new Map<string, Lease>();

function keyOf(assetId: string, variant: AssetVariant): string {
  return `${variant}:${assetId}`;
}

/**
 * 领一份素材的使用权（同一个 `variant + assetId` 只取一次字节）。
 *
 * 拿到就要还：组件卸载时调 {@link releaseAssetUrl}。字节取不到时这个 promise 会 reject
 * （错误一路抛到调用方，不在这里折成一句话）。
 */
export async function acquireAsset(assetId: string, variant: AssetVariant): Promise<LoadedAsset> {
  const key = keyOf(assetId, variant);
  let existing = leases.get(key);
  if (existing === undefined) {
    existing = { url: null, users: 0, pending: null };
    leases.set(key, existing);
  }
  // 下面几行跨 await，用一个 const 抓住这一份（`existing` 是 let，闭包里不好缩窄）
  const lease = existing;
  lease.users += 1;
  // `??=`：正在取就搭同一条车，绝不发第二次
  lease.pending ??= load(lease, assetId, variant);
  try {
    return await lease.pending;
  } catch (error) {
    // 取不到：这份使用权当场还回去，别留一个永远失败的缓存项挡住重试（用户重开对话就是一次新机会）
    lease.users -= 1;
    lease.pending = null;
    if (lease.users === 0) leases.delete(key);
    throw error;
  }
}

/**
 * 还一份使用权；最后一个使用者走的时候回收那个 `blob:` URL。
 *
 * 没有对应的使用权（已经被回收过）时什么都不做：卸载路径上重复调用不该炸。
 */
export function releaseAssetUrl(assetId: string, variant: AssetVariant): void {
  const key = keyOf(assetId, variant);
  const lease = leases.get(key);
  if (lease === undefined) return;
  lease.users -= 1;
  if (lease.users > 0) return;
  leases.delete(key);
  if (lease.url !== null) {
    URL.revokeObjectURL(lease.url);
    lease.url = null;
  }
}

/** 取一次字节并造出 URL，写回这一份持有里 */
async function load(lease: Lease, assetId: string, variant: AssetVariant): Promise<LoadedAsset> {
  const { mime, width, height, bytes } = await getChatAsset(assetId, variant);
  // 跨 IPC 过来的字节是结构化克隆出来的，一定是 ArrayBuffer 支撑的（`BlobPart` 认这个）
  const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime }));
  if (lease.users === 0) {
    // 字节回来之前使用者就都走了（例如刚打开就切走了会话）：这一份没人要，当场回收
    URL.revokeObjectURL(url);
    return { url, width, height };
  }
  lease.url = url;
  return { url, width, height };
}
