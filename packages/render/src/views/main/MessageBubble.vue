<template>
  <div class="message" :class="[roleClass]">
    <!-- 头像 -->
    <div class="avatar">
      <el-icon v-if="isUser" :size="18" color="var(--el-color-success)">
        <UserFilled />
      </el-icon>
      <el-icon v-else :size="18" :color="isSystem ? 'var(--el-text-color-secondary)' : 'var(--el-color-primary)'">
        <MagicStick />
      </el-icon>
    </div>

    <div class="bubble">
      <!-- 系统消息：居中灰条 -->
      <div v-if="isSystem" class="system-text">{{ textContent }}</div>

      <!-- 普通消息 -->
      <template v-else>
        <!-- 思考过程（折叠） -->
        <div v-if="message.reasoning_content" class="fold-section">
          <button class="fold-toggle" @click="showThinking = !showThinking">
            <el-icon :size="12"><ArrowRight v-if="!showThinking" /><ArrowDown v-else /></el-icon>
            <span>思考过程</span>
          </button>
          <div v-show="showThinking" class="thinking">{{ message.reasoning_content }}</div>
        </div>

        <!-- 工具调用（折叠） -->
        <div v-if="toolCalls.length" class="fold-section">
          <button class="fold-toggle" @click="showTools = !showTools">
            <el-icon :size="12"><ArrowRight v-if="!showTools" /><ArrowDown v-else /></el-icon>
            <span>工具调用 ({{ toolCalls.length }})</span>
          </button>
          <div v-show="showTools" class="tool-calls">
            <div v-for="(tc, i) in toolCalls" :key="i" class="tool-call">
              <span class="tool-name">{{ tc.function?.name ?? "工具" }}</span>
              <pre class="tool-args">{{ tc.function?.arguments }}</pre>
            </div>
          </div>
        </div>

        <!-- 正文 -->
        <div class="content" v-html="textContentHtml"></div>

        <!-- 错误状态 + 重试 -->
        <div v-if="isError" class="error-bar">
          <el-icon :size="14"><WarningFilled /></el-icon>
          <span class="error-text">{{ errorText }}</span>
          <el-button size="small" type="primary" text @click="$emit('retry')">
            重试
          </el-button>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from "vue";
import { AgentNS } from "@ai-zen/agents-core";
import {
  ArrowRight,
  ArrowDown,
  UserFilled,
  MagicStick,
  WarningFilled,
} from "@element-plus/icons-vue";

const props = defineProps<{ message: AgentNS.Message }>();
defineEmits<{ retry: [] }>();

const showThinking = ref(false);
const showTools = ref(false);

const role = computed(() => props.message.role);
const isUser = computed(() => role.value === AgentNS.Role.User);
const isSystem = computed(() => role.value === AgentNS.Role.System);
const isError = computed(
  () => props.message.status === AgentNS.MessageStatus.Error,
);

const roleClass = computed(() => {
  switch (role.value) {
    case AgentNS.Role.User: return "user";
    case AgentNS.Role.System: return "system";
    default: return "assistant";
  }
});

const toolCalls = computed(() => props.message.tool_calls ?? []);

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** 提取纯文本（string 或 section[]） */
function extractText(content: AgentNS.MessageContent | undefined): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  return content
    .filter((s) => s.type === "text")
    .map((s) => s.text)
    .join("\n");
}

const textContent = computed(() => extractText(props.message.content));

const textContentHtml = computed(() =>
  escapeHtml(textContent.value).replace(/\n/g, "<br>"),
);

const errorText = computed(() => textContent.value || "发生错误");
</script>

<style lang="scss" scoped>
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
      border-radius: 12px 12px 4px 12px;
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
      border-radius: 12px 12px 12px 4px;
    }
  }

  &.system {
    align-self: center;
    max-width: 90%;
    align-items: flex-start;

    .avatar {
      // 图标与第一行文字垂直居中对齐：
      // avatar 36px（icon 垂直居中 → 中心在顶部下 18px），
      // 第一行中心 = 上 padding 2px + line-height/2（12px * 1.6 / 2 = 9.6px）
      // 上移 6.4px 后按字形视觉微调下移 1px
      margin-top: calc(2px + 12px * 1.6 / 2 - 36px / 2 + 1px);
    }

    .bubble {
      background: transparent;
      border: none;
      // 去掉通用 padding（灰条 system-text 自带 padding，避免双重间距导致错位）
      padding: 0;
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
  min-width: 0;
}

.content {
  word-break: break-word;
  white-space: pre-wrap;
}

// ==================== 折叠区（思考 / 工具调用） ====================
.fold-section {
  margin-bottom: 8px;

  .fold-toggle {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px;
    border: none;
    background: var(--el-fill-color-light);
    border-radius: 4px;
    color: var(--el-text-color-secondary);
    font-size: 12px;
    cursor: pointer;

    &:hover {
      color: var(--el-color-primary);
    }
  }

  .thinking {
    margin-top: 6px;
    padding: 8px 10px;
    background: var(--el-fill-color-light);
    border-left: 2px solid var(--el-color-primary-light-5);
    border-radius: 4px;
    font-size: 13px;
    color: var(--el-text-color-secondary);
    white-space: pre-wrap;
  }

  .tool-calls {
    margin-top: 6px;
    display: flex;
    flex-direction: column;
    gap: 6px;

    .tool-call {
      background: var(--el-fill-color-light);
      border-radius: 4px;
      padding: 6px 10px;

      .tool-name {
        font-size: 12px;
        font-weight: 600;
        color: var(--el-color-primary);
      }

      .tool-args {
        margin: 4px 0 0 0;
        font-size: 12px;
        white-space: pre-wrap;
        word-break: break-all;
        color: var(--el-text-color-regular);
      }
    }
  }
}

// ==================== 系统消息 ====================
.system-text {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  background: var(--el-fill-color-light);
  padding: 2px 12px;
  border-radius: 6px;
}

// ==================== 错误 ====================
.error-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
  padding: 8px 10px;
  background: var(--el-color-danger-light-9);
  border-radius: 4px;
  color: var(--el-color-danger);

  .error-text {
    flex: 1;
    font-size: 13px;
  }
}
</style>
