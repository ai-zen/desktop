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
      <el-button type="primary" :loading="creating" @click="confirm">创建</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref, watch } from "vue";
import { ElMessage } from "element-plus";
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
/** 提交中：按钮转圈，防连点（连点两次就是两段会话） */
const creating = ref(false);

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
  creating.value = true;
  try {
    const conv = await conversationStore.create(wsId, agentId.value);
    emit("update:modelValue", false);
    // 建好了，第二件事：把它打开。这一步跟服务端要一次快照（`attach` + `snapshot`），它会抛
    // —— 会话刚建出来就撞上连接断了这类。**单独报**：说成「新建失败」会让用户再点一次「创建」，
    // 于是盘上多出一段重复的会话（而第一段其实已经建好了）。
    try {
      await conversationStore.select(wsId, conv.id);
    } catch (err) {
      ElMessage.error(
        `对话已创建，但打开它失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } catch (err) {
    // 对话框不关：关上等于把这次操作连同原因一起藏起来，用户只会以为没点中
    ElMessage.error(`新建对话失败：${err instanceof Error ? err.message : String(err)}`);
  } finally {
    creating.value = false;
  }
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
