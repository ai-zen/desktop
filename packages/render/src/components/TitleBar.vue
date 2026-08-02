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
          <!-- 最大化：空心方块 -->
          <svg
            v-if="!isMaximized"
            viewBox="0 0 16 16"
            width="16"
            height="16"
            fill="none"
            stroke="currentColor"
            stroke-width="1.4"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <rect x="3" y="3" width="10" height="10" rx="1.5" />
          </svg>
          <!-- 还原：两个重叠方块（后块露出左下角） -->
          <svg
            v-else
            viewBox="0 0 16 16"
            width="16"
            height="16"
            fill="none"
            stroke="currentColor"
            stroke-width="1.4"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <rect x="3.5" y="5.5" width="9" height="9" rx="1.5" opacity="0.45" />
            <rect x="5.5" y="3.5" width="9" height="9" rx="1.5" />
          </svg>
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
    background-color: rgba(var(--el-text-color-rgb), 0.08);
    color: var(--el-text-color-primary);
  }

  &:active {
    background-color: rgba(var(--el-text-color-rgb), 0.14);
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
