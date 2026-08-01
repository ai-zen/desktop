<template>
  <el-container class="main-view">
    <!-- 侧栏（下一步实现：workspace 树 + 会话列表） -->
    <Sidebar />

    <!-- 主内容区（下一步实现：ChatPanel 流式对话） -->
    <el-container class="main-area">
      <ChatPanel />
    </el-container>
  </el-container>
</template>

<script setup lang="ts">
import Sidebar from "./Sidebar.vue";
import ChatPanel from "./ChatPanel.vue";
</script>

<style lang="scss" scoped>
.main-view {
  flex: 1;
  overflow: hidden;
  padding: 0 8px 8px 8px;
  gap: 8px;
}

.main-area {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border-radius: 8px;
}
</style>
