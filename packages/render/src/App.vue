<template>
  <el-container class="app-container">
    <Sidebar />
    <el-container class="main-area">
      <ChatPanel />
    </el-container>
  </el-container>
</template>

<script setup lang="ts">
import Sidebar from "./components/Sidebar.vue";
import ChatPanel from "./components/ChatPanel.vue";
</script>

<style lang="scss">
.app-container {
  height: 100vh;
  overflow: hidden;
  padding: 8px;
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
