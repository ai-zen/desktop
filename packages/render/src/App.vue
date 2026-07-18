<template>
  <div class="app">
    <Sidebar />
    <main class="main-area">
      <ChatPanel />
    </main>
  </div>
</template>

<script setup lang="ts">
import Sidebar from "./components/Sidebar.vue";
import ChatPanel from "./components/ChatPanel.vue";
</script>

<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body, #app { height: 100%; }
.app { display: flex; height: 100%; }
.main-area { flex: 1; display: flex; flex-direction: column; }
</style>
