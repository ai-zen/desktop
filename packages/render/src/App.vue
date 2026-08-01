<template>
  <div class="app-wrapper">
    <!-- 自定义标题栏 -->
    <TitleBar />

    <!-- 页面切换（uiStore.currentView） -->
    <GuideView v-if="uiStore.currentView === 'guide'" />
    <MainView v-else />
  </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted } from "vue";
import TitleBar from "./components/TitleBar.vue";
import GuideView from "./views/guide/index.vue";
import MainView from "./views/main/index.vue";
import { onChatPush } from "./apis/chat.js";
import { useUiStore } from "./stores/ui.js";
import { useWorkspaceStore } from "./stores/workspace.js";
import { useChatStore } from "./stores/chat.js";

const uiStore = useUiStore();
const workspaceStore = useWorkspaceStore();
const chatStore = useChatStore();

let unsubscribe: (() => void) | null = null;

/** 统一的 chat:push 处理器 → chat store（单通道收敛） */
const onChatPushHandler = (
  evt: Parameters<typeof chatStore.applyEvent>[0],
) => {
  chatStore.applyEvent(evt);
};

async function init() {
  // 1. 订阅主进程流式推送 → chat store
  if (!unsubscribe) {
    unsubscribe = onChatPush(onChatPushHandler);
  }

  // 2. 加载全局选项（Agent / 模型列表）
  await uiStore.loadOptions();

  // 3. 加载 workspace → 决定进引导页还是主界面
  await workspaceStore.load();
  uiStore.setView(workspaceStore.workspaces.length === 0 ? "guide" : "main");
}

onMounted(init);

onUnmounted(() => {
  unsubscribe?.();
  unsubscribe = null;
});
</script>

<style lang="scss">
.app-wrapper {
  height: 100vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
</style>
