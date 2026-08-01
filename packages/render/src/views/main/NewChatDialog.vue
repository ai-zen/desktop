<template>
  <el-dialog
    :model-value="modelValue"
    title="新建对话"
    width="400px"
    :close-on-click-modal="false"
    @update:model-value="$emit('update:modelValue', $event)"
  >
    <el-form label-width="64px" @submit.prevent>
      <el-form-item label="Agent">
        <el-select v-model="agentId" class="agent-select">
          <el-option
            v-for="a in uiStore.agents"
            :key="a.id"
            :label="a.name"
            :value="a.id"
          >
            <div class="agent-option">
              <div class="agent-name">{{ a.name }}</div>
              <div v-if="a.description" class="agent-desc">{{ a.description }}</div>
            </div>
          </el-option>
        </el-select>
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="cancel">取消</el-button>
      <el-button type="primary" @click="confirm">创建</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref, watch } from "vue";
import { useUiStore } from "../../stores/ui.js";
import { useWorkspaceStore } from "../../stores/workspace.js";
import { useConversationStore } from "../../stores/conversation.js";

const props = defineProps<{ modelValue: boolean }>();
const emit = defineEmits<{
  "update:modelValue": [value: boolean];
}>();

const uiStore = useUiStore();
const workspaceStore = useWorkspaceStore();
const conversationStore = useConversationStore();

const agentId = ref("");

// 打开时默认预选第一个 Agent
watch(
  () => props.modelValue,
  (open) => {
    if (open) {
      agentId.value = uiStore.agents[0]?.id ?? "";
    }
  },
);

function cancel() {
  emit("update:modelValue", false);
}

async function confirm() {
  const wsId = workspaceStore.activeWorkspaceId;
  if (!wsId || !agentId.value) return;
  await conversationStore.create(wsId, agentId.value);
  emit("update:modelValue", false);
}
</script>

<style lang="scss" scoped>
.agent-select {
  width: 100%;
}

.agent-option {
  .agent-name {
    font-size: 14px;
  }

  .agent-desc {
    font-size: 12px;
    color: var(--el-text-color-secondary);
  }
}
</style>
