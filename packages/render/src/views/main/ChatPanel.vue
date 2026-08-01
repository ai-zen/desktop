<template>
  <div class="chat-panel">
    <!-- 空状态：无会话 -->
    <div v-if="!activeConversationId" class="empty-state">
      <el-icon :size="48" color="var(--el-text-color-secondary)">
        <ChatDotRound />
      </el-icon>
      <p class="empty-title">选择一个对话开始</p>
      <p class="empty-desc">从左侧选择一个对话，或点击「新建对话」开始新的 AI 对话</p>
    </div>

    <!-- 对话区域 -->
    <template v-else>
      <!-- 头部：会话名 -->
      <div class="chat-header">
        <span class="chat-title">{{ conversationStore.activeConversation?.name }}</span>
      </div>

      <!-- 消息列表 -->
      <div class="messages" ref="messagesRef">
        <MessageBubble
          v-for="(msg, idx) in chatStore.messages"
          :key="`${idx}-${msg.role}`"
          :message="msg"
          @retry="chatStore.retry"
        />

        <!-- 正在生成标识 -->
        <div v-if="chatStore.streaming" class="streaming-hint">
          <span class="dot"></span>
          正在思考...
        </div>
      </div>

      <!-- 输入区域（模型切换在输入框上方工具栏） -->
      <div class="input-area">
        <div class="input-toolbar">
          <el-select
            :model-value="currentModelId"
            size="small"
            class="model-select"
            @change="handleModelChange"
          >
            <el-option
              v-for="m in uiStore.models"
              :key="m.id"
              :label="m.name"
              :value="m.id"
            />
          </el-select>
        </div>
        <el-input
          v-model="inputText"
          type="textarea"
          :rows="3"
          placeholder="输入消息... (Enter 发送, Shift+Enter 换行)"
          :disabled="chatStore.streaming"
          @keydown="onInputKeydown"
          resize="none"
          class="chat-input"
        />
        <div class="input-footer">
          <span class="hint">Enter 发送 · Shift+Enter 换行</span>
          <el-button
            type="primary"
            :icon="Promotion"
            :loading="chatStore.streaming"
            :disabled="!inputText.trim()"
            @click="handleSend"
          >
            发送
          </el-button>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted } from "vue";
import { ChatDotRound, Promotion } from "@element-plus/icons-vue";
import MessageBubble from "./MessageBubble.vue";
import { useUiStore } from "../../stores/ui.js";
import { useWorkspaceStore } from "../../stores/workspace.js";
import { useConversationStore } from "../../stores/conversation.js";
import { useChatStore } from "../../stores/chat.js";

const uiStore = useUiStore();
const workspaceStore = useWorkspaceStore();
const conversationStore = useConversationStore();
const chatStore = useChatStore();

const inputText = ref("");
const messagesRef = ref<HTMLElement | null>(null);

const activeConversationId = computed(() => conversationStore.activeConversationId);

const currentModelId = computed(() => {
  // 当前会话的 modelId（summary 上有）；取不到时回退默认
  return conversationStore.activeConversation?.modelId ?? uiStore.models[0]?.id ?? "";
});

async function handleModelChange(modelId: string) {
  const wsId = workspaceStore.activeWorkspaceId;
  const convId = conversationStore.activeConversationId;
  if (!wsId || !convId) return;
  await conversationStore.setModel(wsId, convId, modelId);
}

async function handleSend() {
  const text = inputText.value.trim();
  if (!text) return;
  inputText.value = "";
  await chatStore.send(text);
  scrollToBottom();
}

function onInputKeydown(e: KeyboardEvent) {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    handleSend();
  }
}

function scrollToBottom() {
  nextTick(() => {
    if (messagesRef.value) {
      messagesRef.value.scrollTop = messagesRef.value.scrollHeight;
    }
  });
}

// 流式增量时自动滚底
watch(
  () => chatStore.messages.length,
  () => scrollToBottom(),
);

// 加载会话历史后滚底
watch(activeConversationId, () => scrollToBottom());

onMounted(() => {
  if (!uiStore.models.length) {
    void uiStore.loadOptions();
  }
});
</script>

<style lang="scss" scoped>
.chat-panel {
  flex: 1;
  display: flex;
  flex-direction: column;
  height: 100%;
  background-color: var(--el-bg-color-page);
  border: 1px solid var(--el-border-color);
  border-radius: 8px;
  overflow: hidden;
}

// ==================== 空状态 ====================
.empty-state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: var(--el-text-color-secondary);

  .empty-title {
    font-size: 18px;
    font-weight: 600;
    margin: 0;
  }

  .empty-desc {
    font-size: 14px;
    margin: 0;
    max-width: 300px;
    text-align: center;
    line-height: 1.6;
  }
}

// ==================== 头部 ====================
.chat-header {
  display: flex;
  align-items: center;
  padding: 10px 16px;
  border-bottom: 1px solid var(--el-border-color);
  background-color: var(--el-bg-color);

  .chat-title {
    font-size: 15px;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}

// ==================== 消息列表 ====================
.messages {
  flex: 1;
  overflow-y: auto;
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.streaming-hint {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  align-self: flex-start;
  font-size: 13px;
  color: var(--el-text-color-secondary);

  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--el-color-primary);
    animation: blink 1.2s infinite;
  }
}

@keyframes blink {
  0%, 100% { opacity: 0.2; }
  50% { opacity: 1; }
}

// ==================== 输入区域 ====================
.input-area {
  padding: 10px 20px 16px;
  border-top: 1px solid var(--el-border-color);
  background-color: var(--el-bg-color);
}

// ==================== 输入框上方工具栏（模型切换） ====================
.input-toolbar {
  display: flex;
  align-items: center;
  margin-bottom: 10px;

  .model-select {
    width: 180px;
  }
}

.chat-input {
  :deep(.el-textarea__inner) {
    background-color: var(--el-fill-color);
    border-color: var(--el-border-color);
    border-radius: 8px;
    padding: 12px 16px;
    font-size: 14px;
    line-height: 1.6;
    transition: border-color 0.2s;

    &:focus {
      border-color: var(--el-color-primary);
    }
  }
}

.input-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 8px;

  .hint {
    font-size: 12px;
    color: var(--el-text-color-secondary);
  }
}
</style>
