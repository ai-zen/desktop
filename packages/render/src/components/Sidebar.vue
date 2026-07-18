<template>
  <aside class="sidebar">
    <div class="workspace-list">
      <div
        v-for="ws in workspaces"
        :key="ws.id"
        class="workspace-item"
        :class="{ active: ws.id === activeWorkspaceId }"
        @click="selectWorkspace(ws.id)"
      >
        <span class="ws-name">{{ ws.name }}</span>
        <div class="conversation-list">
          <div
            v-for="conv in conversations"
            :key="conv.id"
            class="conversation-item"
            :class="{ active: conv.id === activeConversationId }"
            @click="selectConversation(conv.id)"
          >
            {{ conv.name }}
          </div>
        </div>
      </div>
    </div>
    <button class="new-btn" @click="createConversation">+ 新建对话</button>
  </aside>
</template>

<script setup lang="ts">
import { ref } from "vue";

const workspaces = ref([{ id: "default", name: "默认工作空间" }]);
const activeWorkspaceId = ref("default");
const conversations = ref<{ id: string; name: string }[]>([]);
const activeConversationId = ref<string | undefined>();

function selectWorkspace(id: string) {
  activeWorkspaceId.value = id;
}

function selectConversation(id: string) {
  activeConversationId.value = id;
}

function createConversation() {
  // TODO
}
</script>

<style scoped>
.sidebar {
  width: 260px;
  background: #1e1e1e;
  color: #ccc;
  display: flex;
  flex-direction: column;
  border-right: 1px solid #333;
}
.workspace-list { flex: 1; overflow-y: auto; }
.workspace-item { padding: 8px 12px; cursor: pointer; }
.workspace-item:hover { background: #2a2a2a; }
.workspace-item.active { background: #094771; }
.ws-name { font-weight: bold; color: #fff; }
.conversation-list { margin-left: 16px; margin-top: 4px; }
.conversation-item { padding: 4px 8px; border-radius: 4px; }
.conversation-item:hover { background: #333; }
.conversation-item.active { background: #094771; }
.new-btn {
  margin: 8px; padding: 8px; background: #0078d4; color: #fff;
  border: none; border-radius: 4px; cursor: pointer;
}
</style>
