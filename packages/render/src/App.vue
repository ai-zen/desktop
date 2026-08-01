<template>
  <div class="app-wrapper">
    <!-- 自定义标题栏 -->
    <TitleBar />

    <!-- 主内容区 -->
    <el-container class="app-container">
      <Sidebar />
      <el-container class="main-area">
        <ChatPanel />
      </el-container>
    </el-container>
  </div>
</template>

<script setup lang="ts">
import TitleBar from "./components/TitleBar.vue";
import Sidebar from "./components/Sidebar.vue";
import ChatPanel from "./components/ChatPanel.vue";
</script>

<style lang="scss">
.app-wrapper {
  height: 100vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.app-container {
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
  border-radius: 12px;
}
</style>
