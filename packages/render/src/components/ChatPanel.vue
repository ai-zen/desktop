<template>
  <div class="chat-panel">
    <div class="messages" ref="messagesRef">
      <div v-for="msg in messages" :key="msg.id" class="message">
        <div class="role">{{ msg.role }}</div>
        <div class="content">{{ msg.content }}</div>
      </div>
    </div>
    <div class="input-area">
      <input
        v-model="input"
        @keydown.enter="send"
        placeholder="输入消息..."
        class="input-box"
      />
      <button @click="send" class="send-btn">发送</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";

const input = ref("");
const messages = ref<{ id: string; role: string; content: string }[]>([]);

function send() {
  if (!input.value.trim()) return;
  const msg = { id: Date.now().toString(), role: "user", content: input.value };
  messages.value.push(msg);
  input.value = "";
}
</script>

<style scoped>
.chat-panel { flex: 1; display: flex; flex-direction: column; background: #f5f5f5; }
.messages { flex: 1; overflow-y: auto; padding: 16px; }
.message { margin-bottom: 12px; }
.role { font-weight: bold; font-size: 12px; color: #666; margin-bottom: 4px; }
.content { background: #fff; padding: 8px 12px; border-radius: 8px; }
.input-area { display: flex; padding: 12px; border-top: 1px solid #ddd; background: #fff; }
.input-box { flex: 1; padding: 8px 12px; border: 1px solid #ddd; border-radius: 4px; }
.send-btn { margin-left: 8px; padding: 8px 16px; background: #0078d4; color: #fff; border: none; border-radius: 4px; cursor: pointer; }
</style>
