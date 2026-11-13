<template>
  <!--
    作答面板：宿主停下来问一道题（到交接线、或者不可撤销的动作前确认）。

    三个来源的文案全部是宿主渲染好的（连接语言 `zh`，PRD D8）：
      · 标题 = `prompt.message`
      · 候选 = `options[].label.message`（**顺序就是宿主给的顺序**，不重排）
      · 补充说明 = `detail?.message`（宿主没给就不占位）
    客户端不再造第二份翻译，也不改顺序 —— 候选的先后是产品的说法（自交接 / 独立摘要 / 不交接
    是有推荐次序的），重排等于替换掉那个说法。

    ## 没有「关闭 / 取消」

    面板上没有 ×，也没有 Esc 收起：**关闭就等于不作答**，而这道题会一直挂着（宿主不超时、
    也不自动取消，PRD D23），这段对话随后每次发消息都会被 `question_pending` 拒。既然
    「关掉它」在事实上不存在，界面就不该给一个看起来像「放弃这道题」的按钮。想先看看别处可以
    直接切会话（题还在这段对话上，切回来接着答）。
  -->
  <div v-if="questions.length > 0" class="question-panel">
    <div v-for="question in questions" :key="question.id" class="question-card">
      <div class="question-prompt">{{ question.prompt.message }}</div>
      <!-- 挡住对话的题（`blocking`）要说清代价：在它被回答之前，这里发不出消息去 -->
      <div v-if="question.blocking" class="question-blocking">答完才能继续：这道题没答之前发不了消息</div>
      <div class="question-options">
        <button
          v-for="option in question.options"
          :key="option.value"
          type="button"
          class="question-option"
          :disabled="answeringId === question.id"
          @click="emit('answer', question.id, option.value)"
        >
          <span class="option-label">{{ option.label.message }}</span>
          <span v-if="option.detail" class="option-detail">{{ option.detail.message }}</span>
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { QuestionView } from "@ai-zen/desktop-shared";

/**
 * 面板是个**只读 + 上报**的组件：它不碰 store，也不自己决定答什么。
 *
 * `answer` 的载荷是 `(questionId, value)` 两个位置参数 —— `value` 只能是用户点中的那个候选
 * （`option.value`）。没有默认选项、没有键盘默认焦点、也没有超时自动提交：没有点击就什么都不发。
 */
defineProps<{
  /** 还在等人答的问题（`chat store` 的 `pendingQuestions`，宿主给的顺序） */
  questions: QuestionView[];
  /** 正在提交的那道题（提交期间把它的候选按钮禁掉，防连点答两次） */
  answeringId: string;
}>();

const emit = defineEmits<{
  answer: [questionId: string, value: string];
}>();
</script>

<style lang="scss" scoped>
.question-panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 10px 20px 4px;
  background-color: var(--el-bg-color);
  border-top: 1px solid var(--el-border-color);
}

// 一道题一张卡片：卡片之间的分隔只靠 gap（不画边框，免得与输入框的边框打架）
.question-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px;
  border: 1px solid var(--el-color-primary-light-7);
  border-radius: 8px;
  background-color: var(--el-color-primary-light-9);
}

.question-prompt {
  font-size: 14px;
  font-weight: 600;
  line-height: 1.5;
  color: var(--el-text-color-primary);
}

.question-blocking {
  font-size: 12px;
  color: var(--el-color-warning);
}

.question-options {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

// 候选是一整块可点的区域：标题与补充说明两行，说明只在宿主给了 `detail` 时出现
.question-option {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  padding: 8px 12px;
  border: 1px solid var(--el-border-color);
  border-radius: 6px;
  background-color: var(--el-bg-color);
  text-align: left;
  cursor: pointer;
  transition: border-color 0.15s, background-color 0.15s;

  &:hover:not(:disabled) {
    border-color: var(--el-color-primary);
    background-color: var(--el-color-primary-light-9);
  }

  &:disabled {
    cursor: not-allowed;
    opacity: 0.6;
  }

  .option-label {
    font-size: 13px;
    color: var(--el-text-color-primary);
  }

  .option-detail {
    font-size: 12px;
    line-height: 1.5;
    color: var(--el-text-color-secondary);
  }
}
</style>
