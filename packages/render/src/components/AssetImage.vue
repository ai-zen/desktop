<template>
  <span class="asset-image">
    <!-- 知道原图尺寸时，外层框按原比例先撑好（内联的 `thumbBox`），字节解开前后同一个尺寸；
         不知道时不加样式，图按自己的尺寸出现 -->
    <button
      v-if="thumb"
      type="button"
      class="thumb-button"
      :class="{ 'is-sized': thumbBox !== undefined }"
      :style="thumbBox"
      title="点击查看原图"
      @click="openOriginal"
    >
      <img :src="thumb.url" alt="图片" class="thumb" />
    </button>
    <el-dialog v-model="viewing" title="原图" width="auto" append-to-body>
      <img v-if="original" :src="original.url" alt="图片" class="original" />
    </el-dialog>
  </span>
</template>

<script setup lang="ts">
/**
 * 气泡里的一张历史图片：先显示 `thumb` 那一档，点一下取回 `original` 那一档看全图。
 *
 * ## 为什么单独一个组件
 *
 * 一张图一份生命周期：挂载时领 `blob:` URL 的使用权、卸载时还回去（`stores/assetImages.ts`
 * 按 `variant + assetId` 记账，同一屏里同一份素材因此只取一次、最后一个使用者走的时候才
 * `URL.revokeObjectURL`）。`onMounted` / `onBeforeUnmount` 只能属于组件，所以每条消息里
 * 「第几张图」就是「第几个这个组件」—— 把这段搬进 `MessageBubble` 只会变成一份按数组循环的
 * 手写记账。
 *
 * ## 两档都是原样取、原样显示
 *
 * `thumb` 在宿主目前**等同原图**（PRD F-H8：这一波不做真实缩略图），所以这里就是按 CSS 把它
 * 缩进气泡，不在客户端自己造一份假缩略图。点开时才去取 `original`（同一份字节，但入口与档位
 * 是真的：宿主做了真实缩略图之后，这里一个字段都不用改）。
 *
 * ## 占位框按原图比例先摆好（R76）
 *
 * `asset.get` 带回了原图的 `width` / `height`，所以图一上屏外层的按钮就按原比例有了确定的宽高
 * （`width` + `aspect-ratio`，高度上限 240px）：**字节解开之前**框就已经是最终尺寸，气泡不会因为
 * 图「长出来」而跳一下。宿主没解出尺寸（`null`）时不设框，图按自己的尺寸出现。
 *
 * ## 取不到就不显示
 *
 * `acquireAsset` 失败时错误照原样抛到控制台（PRD F-H8：素材不自动重试、不判失效）：
 * 界面上少一张图，而不是弹一句编出来的话。
 */
import { computed, onBeforeUnmount, onMounted, ref, type CSSProperties } from "vue";
import { acquireAsset, releaseAssetUrl, type LoadedAsset } from "../stores/assetImages.js";

const props = defineProps<{
  /** 这一段引用的素材 id（气泡从内容段的 `__asset_id` 读出来交给这里） */
  assetId: string;
}>();

/** 缩略图那一档（字节回来之前是 `null`，那时什么都不画） */
const thumb = ref<LoadedAsset | null>(null);
/** 原图那一档（点开过才有） */
const original = ref<LoadedAsset | null>(null);
/** 原图弹层开着没有 */
const viewing = ref(false);

/** 缩略图的高度上限（与 CSS 里那条 `max-height` 同一个数） */
const THUMB_MAX_HEIGHT = 240;

/**
 * 占位框：高度上限 × 原比例算出宽，高由 `aspect-ratio` 跟出来。
 *
 * 宽高有一个拿不到时返回 `undefined` —— 不设框，图片按自己的尺寸出现（那是「没有尺寸」这一种
 * 事实，不是要兜底的情形）。
 */
const thumbBox = computed<CSSProperties | undefined>(() => {
  const asset = thumb.value;
  if (asset === null || asset.width === null || asset.height === null) return undefined;
  const ratio = asset.width / asset.height;
  return {
    // 宽直接算成像素（高度上限 × 原比例），再交给 CSS 的 `max-width` 收进气泡：这样框的宽度在
    // 任何一次布局里都是确定值，不必等父容器的宽度先算出来
    width: `${THUMB_MAX_HEIGHT * ratio}px`,
    aspectRatio: `${asset.width} / ${asset.height}`,
  } as CSSProperties;
});

/** 原图那份只取一次：连点两下也只有一个请求、一份使用权 */
let originalRequest: Promise<LoadedAsset> | null = null;

onMounted(() => {
  void acquireAsset(props.assetId, "thumb").then((loaded) => {
    thumb.value = loaded;
  });
});

onBeforeUnmount(() => {
  releaseAssetUrl(props.assetId, "thumb");
  if (originalRequest !== null) releaseAssetUrl(props.assetId, "original");
});

async function openOriginal(): Promise<void> {
  originalRequest ??= acquireAsset(props.assetId, "original");
  original.value = await originalRequest;
  viewing.value = true;
}
</script>

<style lang="scss" scoped>
.asset-image {
  display: block;
}

.thumb-button {
  display: block;
  padding: 0;
  border: none;
  background: transparent;
  cursor: zoom-in;
  line-height: 0;
}

.thumb-button.is-sized {
  // 宽与比例由内联样式给（`width` + `aspect-ratio`），这里只把它收进气泡；两者都不依赖图片
  // 解没解开，所以框从第一帧起就是最终尺寸 —— 气泡不会跳
  max-width: 100%;
}

.thumb {
  display: block;
  // 不知道尺寸时（没有 `is-sized`）：按图片自己的尺寸显示，两个 `max-*` 收进气泡
  max-width: 100%;
  max-height: 240px;
  height: auto;
  border-radius: 6px;
  object-fit: contain;
  // 用户气泡是蓝底：给图留一圈浅色描边，深色图不至于糊在背景里
  box-shadow: 0 0 0 1px var(--el-border-color-lighter);
}

// 有占位框时图铺满它（`object-fit: contain` 仍然保证不变形）
.thumb-button.is-sized .thumb {
  width: 100%;
  height: 100%;
  max-width: none;
  max-height: none;
}

.original {
  display: block;
  max-width: 84vw;
  max-height: 76vh;
  object-fit: contain;
}
</style>
