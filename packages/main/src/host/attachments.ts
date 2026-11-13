/**
 * 附件上传编排：render 递来的一批字节 → `asset.begin` / 二进制分片 / `asset.end` → 能放进消息的
 * assetId，以及「哪一张没成、为什么」的逐条账。
 *
 * ## 为什么这一层薄到只有「搬 + 合并」
 *
 * 上传本身的规则全在客户端库里（`uploadAssets`：本地能判的超限/空文件/认不出类型、三段式的顺序、
 * sha256、张数上限）。这一层只做两件本进程才知道的事：
 *
 *   1. **把 render 的 `AttachmentInput` 翻成库要的 `AssetSource`**（字节那条路，不是文件路径：
 *      桌面端剪贴板图片根本没有路径）；
 *   2. **把「上传阶段的失败」与「宿主给的结局」合到同一份逐张账上**，让界面按用户摆放的顺序
 *      一张一句地说清，而不是一部分静默丢掉。
 *
 * ## 失败不往上抛
 *
 * 一张图没传上去不该等于「这一轮什么都不发」（PRD F-H7：全失败退回纯文本，其余内容照发）。所以
 * 这里的失败都落进返回值，由调用方决定怎么说 —— 抛出去只会让 `chat.send` 走 catch 分支，连文字
 * 都发不出去。
 */

import { uploadAssets, type AttachmentOutcome as WireOutcome, type AssetSource, type AssetFailure, type UploadTransport } from "@ai-zen/agents-client";
import type { AttachmentInput, AttachmentOutcome, ProblemFact } from "@ai-zen/desktop-shared";
import { problemOf } from "./problem.js";

/** 一张上传成功的素材（`index` 是它在 render 递来的那批里的位置） */
export interface UploadedAsset {
  /** 在 `files` 里的下标（0 起） */
  index: number;
  /** 宿主给的素材 id（进 `conversation.send` 的就是它） */
  assetId: string;
  /** 名字（宿主回的 ref 上有；界面说「哪一张」用它） */
  name: string | null;
}

/** 一张没能上传的附件（原因来自客户端库/宿主，原样上屏） */
export interface FailedAsset {
  index: number;
  name: string | null;
  /** 结构化原因（码 + 参数 + 已渲染好的那句） */
  problem: ProblemFact;
}

/** 一批附件的上传结果：成了的 + 没成的（**一条都不静默丢**） */
export interface AttachmentUpload {
  assets: UploadedAsset[];
  failures: FailedAsset[];
}

/**
 * 把一批字节传上去。
 *
 * 上限（20MB/张、4 张/条）不在这一层重写：库从握手结果里取宿主那个数，宿主说多少就是多少。
 * 超出的那几张按库的口径逐张进 `failures`（码 `asset_count_exceeded`），前 4 张照常上传 ——
 * 与界面「逐张说明」是同一条线。
 */
export async function uploadAttachments(
  transport: UploadTransport,
  conversationId: string,
  files: readonly AttachmentInput[],
): Promise<AttachmentUpload> {
  if (files.length === 0) return { assets: [], failures: [] };

  const sources: AssetSource[] = files.map((file) => {
    const source: AssetSource = {
      data: file.data,
      mime: file.mime,
      ...(file.name === undefined ? {} : { name: file.name }),
    };
    return source;
  });

  const { assets, failures } = await uploadAssets(transport, { conversationId, sources });

  // 库只报「哪几个下标失败了」，成功的那几个按顺序给出。两者的下标集合互补，于是能还原出每张
  // 成功素材在用户那批里的位置 —— 界面按这个位置排序，几张图说的话才不会错位。
  const failedIndexes = new Set(failures.map((failure) => failure.index));
  const succeededIndexes = files
    .map((_file, index) => index)
    .filter((index) => !failedIndexes.has(index));

  return {
    assets: assets.map((asset, position) => ({
      index: succeededIndexes[position] ?? -1,
      assetId: asset.assetId,
      name: asset.name,
    })),
    failures: failures.map((failure) => ({
      index: failure.index,
      name: failure.name,
      problem: failureProblem(failure),
    })),
  };
}

/**
 * 一个上传失败 → 它的事实。
 *
 * `AssetFailure.error` 是客户端库/宿主那个 `ClientError`（带码、参数、已渲染的句子与 detail），
 * 原样搬就行了 —— 不在这里只取 `message`，那是把另外三样丢掉。
 */
function failureProblem(failure: AssetFailure): ProblemFact {
  return problemOf(failure.error);
}

/**
 * 上传阶段的结果 + 宿主回的结局 → 界面要的**逐张**结局（顺序 = 用户摆放的顺序）。
 *
 * 两边各说一半：
 *   · 传上去的那几张，怎么走的由宿主说（文件引用 / 内联 / 退化成文字 / 发的时候被丢）：
 *     宿主那份结局（`deliveredAs` + `section` + `problem`）整块搬，只补一个名字；
 *   · 没传上去的那几张，宿主根本没见过它们，由上传阶段的失败补上（`dropped` + 原因）——
 *     那时没有内容段（`section: null`）。
 *
 * 宿主没为某个 assetId 给结局时**不编**：那是它没说的事，编一句「已发送」就是假成功。
 */
export function mergeAttachmentOutcomes(
  upload: AttachmentUpload,
  wire: readonly WireOutcome[],
): AttachmentOutcome[] {
  const byAssetId = new Map<string, WireOutcome>();
  for (const outcome of wire) byAssetId.set(outcome.assetId, outcome);

  const merged: Array<{ index: number; outcome: AttachmentOutcome }> = [];

  for (const asset of upload.assets) {
    const outcome = byAssetId.get(asset.assetId);
    if (!outcome) continue;
    merged.push({
      index: asset.index,
      outcome: {
        ...outcome,
        name: asset.name,
      },
    });
  }

  for (const failure of upload.failures) {
    merged.push({
      index: failure.index,
      outcome: {
        assetId: "",
        deliveredAs: "dropped",
        section: null,
        problem: failure.problem,
        name: failure.name,
      },
    });
  }

  // 按下标排序：`sort` 是稳定的，所以同一张的两条事实不会被换位
  merged.sort((left, right) => left.index - right.index);
  return merged.map((item) => item.outcome);
}
