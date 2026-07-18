<template>
  <div class="chat-panel">
    <!-- 空状态 -->
    <div v-if="!activeConversation" class="empty-state">
      <el-icon :size="48" color="var(--el-text-color-secondary)">
        <ChatDotRound />
      </el-icon>
      <p class="empty-title">选择一个对话开始</p>
      <p class="empty-desc">从左侧选择一个对话，或点击「新建对话」开始新的 AI 对话</p>
    </div>

    <!-- 对话区域 -->
    <template v-else>
      <!-- 对话头部 -->
      <div class="chat-header">
        <span class="chat-title">{{ activeConversation.name }}</span>
        <div class="chat-actions">
          <el-tooltip content="清空对话" placement="bottom">
            <el-button :icon="Delete" size="small" text @click="handleClear" />
          </el-tooltip>
        </div>
      </div>

      <!-- 消息列表 -->
      <div class="messages" ref="messagesRef">
        <div
          v-for="msg in messages"
          :key="msg.id"
          class="message"
          :class="[msg.role]"
        >
          <div class="avatar">
            <el-icon v-if="msg.role === 'assistant'" :size="18" color="var(--el-color-primary)">
              <MagicStick />
            </el-icon>
            <el-icon v-else :size="18" color="var(--el-color-success)">
              <UserFilled />
            </el-icon>
          </div>
          <div class="bubble">
            <div class="content" v-html="renderContent(msg.content)"></div>
          </div>
        </div>

        <!-- 加载中 -->
        <div v-if="isLoading" class="message assistant">
          <div class="avatar">
            <el-icon :size="18" color="var(--el-color-primary)">
              <MagicStick />
            </el-icon>
          </div>
          <div class="bubble">
            <div class="typing-indicator">
              <span></span><span></span><span></span>
            </div>
          </div>
        </div>
      </div>

      <!-- 输入区域 -->
      <div class="input-area">
        <el-input
          v-model="inputText"
          type="textarea"
          :rows="3"
          placeholder="输入消息... (Enter 发送, Shift+Enter 换行)"
          :disabled="isLoading"
          @keydown="onInputKeydown"
          resize="none"
          class="chat-input"
        />
        <div class="input-footer">
          <span class="hint">Enter 发送 · Shift+Enter 换行</span>
          <el-button
            type="primary"
            :icon="Promotion"
            :loading="isLoading"
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
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from "vue";
import {
  ChatDotRound,
  Delete,
  MagicStick,
  UserFilled,
  Promotion,
} from "@element-plus/icons-vue";
import type { Message, Conversation } from "@ai-zen/desktop-shared";

// ==================== 状态 ====================
const inputText = ref("");
const messages = ref<Message[]>([]);
const isLoading = ref(false);
const messagesRef = ref<HTMLElement | null>(null);

// 当前选中的对话 ID（由 Sidebar 设置，后续通过 store 或事件共享）
const activeConversationId = ref<string | undefined>();
const conversationCache = ref<Conversation | null>(null);
const activeConversation = computed<Conversation | null>(() => {
  return conversationCache.value;
});

// ==================== 辅助 ====================
function getAPI() {
  return window.electronAPI;
}

function renderContent(content: string): string {
  // 简单转义 HTML，防止 XSS（后续可以加 Markdown 渲染）
  const escaped = content
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  // 简单的换行转 <br>
  return escaped.replace(/\n/g, "<br>");
}

function scrollToBottom() {
  nextTick(() => {
    if (messagesRef.value) {
      messagesRef.value.scrollTop = messagesRef.value.scrollHeight;
    }
  });
}

// ==================== 发送消息 ====================
async function handleSend() {
  const text = inputText.value.trim();
  if (!text || !activeConversationId.value) return;

  // 添加用户消息
  const userMsg: Message = {
    id: `msg-${Date.now()}`,
    role: "user",
    content: text,
    createdAt: new Date().toISOString(),
  };
  messages.value.push(userMsg);
  inputText.value = "";
  scrollToBottom();

  // 调用 chat.send
  isLoading.value = true;
  const api = getAPI();
  if (api) {
    try {
      await api.invoke("chat", "send", activeConversationId.value, text);
    } catch (e) {
      console.error("发送消息失败:", e);
      messages.value.push({
        id: `msg-${Date.now()}-err`,
        role: "assistant",
        content: `❌ 发送失败: ${e}`,
        createdAt: new Date().toISOString(),
      });
    }
  }
  isLoading.value = false;
  scrollToBottom();
}

function onInputKeydown(e: KeyboardEvent) {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    handleSend();
  }
}

// ==================== 流式推送监听 ====================
function onChatChunk(...args: unknown[]) {
  const { conversationId, chunk } = args[0] as any;
  if (conversationId !== activeConversationId.value) return;

  // 找到最后一条 assistant 消息，追加内容
  const lastMsg = messages.value[messages.value.length - 1];
  if (lastMsg && lastMsg.role === "assistant" && !lastMsg.id.startsWith("msg-")) {
    lastMsg.content += chunk;
  } else {
    messages.value.push({
      id: `chunk-${Date.now()}`,
      role: "assistant",
      content: chunk,
      createdAt: new Date().toISOString(),
    });
  }
  scrollToBottom();
}

function handleClear() {
  messages.value = [];
}

// ==================== 生命周期 ====================
onMounted(() => {
  const api = getAPI();
  if (api) {
    api.on("chat:chunk", onChatChunk);
  }
});

onUnmounted(() => {
  const api = getAPI();
  if (api) {
    api.off("chat:chunk", onChatChunk);
  }
});

// 监听对话切换
watch(activeConversationId, async (newId) => {
  if (!newId) {
    messages.value = [];
    conversationCache.value = null;
    return;
  }
  const api = getAPI();
  if (!api) return;
  try {
    const conv = (await api.invoke("conversation", "get", newId)) as Conversation | null;
    if (conv) {
      conversationCache.value = conv;
      messages.value = conv.messages || [];
      scrollToBottom();
    }
  } catch (e) {
    console.error("加载对话失败:", e);
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

// ==================== 对话头部 ====================
.chat-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 20px;
  border-bottom: 1px solid var(--el-border-color);
  background-color: var(--el-bg-color);

  .chat-title {
    font-size: 16px;
    font-weight: 600;
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

.message {
  display: flex;
  gap: 12px;
  max-width: 85%;

  &.user {
    align-self: flex-end;
    flex-direction: row-reverse;

    .avatar {
      background: var(--el-color-success-light-9);
    }

    .bubble {
      background: var(--el-color-primary);
      color: #fff;
      border-radius: 18px 18px 4px 18px;
    }
  }

  &.assistant {
    align-self: flex-start;

    .avatar {
      background: var(--el-color-primary-light-9);
    }

    .bubble {
      background: var(--el-fill-color);
      border: 1px solid var(--el-border-color);
      border-radius: 18px 18px 18px 4px;
    }
  }
}

.avatar {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.bubble {
  padding: 10px 16px;
  line-height: 1.6;
  font-size: 14px;

  .content {
    word-break: break-word;
    white-space: pre-wrap;
  }
}

// ==================== 打字指示器 ====================
.typing-indicator {
  display: flex;
  gap: 4px;
  padding: 4px 0;

  span {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--el-text-color-secondary);
    animation: typing 1.4s infinite ease-in-out;

    &:nth-child(2) { animation-delay: 0.2s; }
    &:nth-child(3) { animation-delay: 0.4s; }
  }
}

@keyframes typing {
  0%, 60%, 100% { opacity: 0.3; transform: scale(0.8); }
  30% { opacity: 1; transform: scale(1); }
}

// ==================== 输入区域 ====================
.input-area {
  padding: 16px 20px;
  border-top: 1px solid var(--el-border-color);
  background-color: var(--el-bg-color);
}

.chat-input {
  :deep(.el-textarea__inner) {
    background-color: var(--el-fill-color);
    border-color: var(--el-border-color);
    border-radius: 12px;
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
