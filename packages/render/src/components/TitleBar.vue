<template>
  <div class="title-bar" @dblclick="toggleMaximize">
    <!-- 拖拽区域 -->
    <div class="drag-area">
      <div class="app-title-group">
        <el-icon :size="18" color="var(--el-color-primary)">
          <MagicStick />
        </el-icon>
        <span class="app-title">AI-Zen</span>
      </div>
    </div>

    <!-- 窗口控制按钮 -->
    <div class="window-controls">
      <button
        class="control-btn"
        title="最小化"
        @click="minimize"
      >
        <el-icon :size="16"><Minus /></el-icon>
      </button>
      <button
        class="control-btn"
        :title="isMaximized ? '还原' : '最大化'"
        @click="toggleMaximize"
      >
        <el-icon :size="16">
          <FullScreen v-if="!isMaximized" />
          <CopyDocument v-else />
        </el-icon>
      </button>
      <button
        class="control-btn close-btn"
        title="关闭"
        @click="closeWindow"
      >
        <el-icon :size="16"><Close /></el-icon>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from "vue";
import {
  Minus,
  FullScreen,
  CopyDocument,
  Close,
  MagicStick,
} from "@element-plus/icons-vue";

const isMaximized = ref(false);

function getAPI() {
  return window.electronAPI;
}

async function minimize() {
  await getAPI()?.window.minimize();
}

async function toggleMaximize() {
  await getAPI()?.window.maximize();
}

async function closeWindow() {
  await getAPI()?.window.close();
}

function onMaximizeChange(_event: unknown, maximized: unknown) {
  isMaximized.value = maximized as boolean;
}

onMounted(async () => {
  const api = getAPI();
  if (api) {
    // 查询当前最大化状态
    isMaximized.value = await api.window.isMaximized();
    // 监听最大化状态变化
    api.on("window:maximizeChange", onMaximizeChange);
  }
});

onUnmounted(() => {
  const api = getAPI();
  if (api) {
    api.off("window:maximizeChange", onMaximizeChange);
  }
});
</script>

<style lang="scss" scoped>
.title-bar {
  display: flex;
  align-items: center;
  height: 38px;
  flex-shrink: 0;
  user-select: none;
}

.drag-area {
  flex: 1;
  display: flex;
  align-items: center;
  height: 100%;
  padding-left: 12px;
  -webkit-app-region: drag;
}

.app-title-group {
  display: flex;
  align-items: center;
  gap: 6px;
}

.app-title {
  font-size: 14px;
  font-weight: 600;
  background: linear-gradient(135deg, var(--el-color-primary), #60a5fa);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}

// ==================== 窗口控制按钮 ====================
.window-controls {
  display: flex;
  height: 100%;
  -webkit-app-region: no-drag;
}

.control-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 46px;
  height: 100%;
  border: none;
  background: transparent;
  color: var(--el-text-color-regular);
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
  outline: none;
  padding: 0;

  &:hover {
    background-color: var(--el-fill-color-light);
    color: var(--el-text-color-primary);
  }

  &:active {
    background-color: var(--el-fill-color);
  }

  &.close-btn:hover {
    background-color: #e81123;
    color: #fff;
  }

  &.close-btn:active {
    background-color: #bf0f1d;
    color: #fff;
  }
}
</style>
