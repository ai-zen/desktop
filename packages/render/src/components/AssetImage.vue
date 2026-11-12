<template>
  <span class="asset-image">
    <button
      v-if="thumbUrl"
      type="button"
      class="thumb-button"
      title="点击查看原图"
      @click="openOriginal"
    >
      <img :src="thumbUrl" alt="图片" class="thumb" />
    </button>
    <el-dialog v-model="viewing" title="原图" width="auto" append-to-body>
      <img v-if="originalUrl" :src="originalUrl" alt="图片" class="original" />
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
 * `thumb` 在服务端目前**等同原图**（PRD F-H8：这一波不做真实缩略图），所以这里就是按 CSS 把它
 * 缩进气泡，不在客户端自己造一份假缩略图。点开时才去取 `original`（同一份字节，但入口与档位
 * 是真的：服务端做了真实缩略图之后，这里一个字段都不用改）。
 *
 * ## 取不到就不显示
 *
 * `acquireAssetUrl` 失败时错误照原样抛到控制台（PRD F-H8：素材不自动重试、不判失效）：
 * 界面上少一张图，而不是弹一句编出来的话。
 */
import { onBeforeUnmount, onMounted, ref } from "vue";
import { acquireAssetUrl, releaseAssetUrl } from "../stores/assetImages.js";

const props = defineProps<{
  /** 这一段引用的素材 id（气泡从内容段的 `__asset_id` 读出来交给这里） */
  assetId: string;
}>();

/** 缩略图那一档的 `blob:` URL（字节回来之前是空串，那时什么都不画） */
const thumbUrl = ref("");
/** 原图那一档的 `blob:` URL（点开过才有） */
const originalUrl = ref("");
/** 原图弹层开着没有 */
const viewing = ref(false);

/** 原图那份只取一次：连点两下也只有一个请求、一份使用权 */
let originalRequest: Promise<string> | null = null;

onMounted(() => {
  void acquireAssetUrl(props.assetId, "thumb").then((url) => {
    thumbUrl.value = url;
  });
});

onBeforeUnmount(() => {
  releaseAssetUrl(props.assetId, "thumb");
  if (originalRequest !== null) releaseAssetUrl(props.assetId, "original");
});

async function openOriginal(): Promise<void> {
  originalRequest ??= acquireAssetUrl(props.assetId, "original");
  originalUrl.value = await originalRequest;
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

.thumb {
  max-width: 100%;
  max-height: 240px;
  border-radius: 6px;
  object-fit: contain;
  // 用户气泡是蓝底：给图留一圈浅色描边，深色图不至于糊在背景里
  box-shadow: 0 0 0 1px var(--el-border-color-lighter);
}

.original {
  display: block;
  max-width: 84vw;
  max-height: 76vh;
  object-fit: contain;
}
</style>
