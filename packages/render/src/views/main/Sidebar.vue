<template>
  <el-aside width="280px" class="sidebar">
    <!-- 工作空间 + 会话树 -->
    <div class="section">
      <div class="section-title">
        <span>工作空间</span>
        <el-tooltip content="新建工作空间" placement="top" effect="light">
          <el-button
            :icon="Plus"
            size="small"
            text
            @click="showAddWorkspace = true"
          />
        </el-tooltip>
      </div>

      <el-tree
        :data="treeData"
        :props="treeProps"
        node-key="id"
        highlight-current
        :current-node-key="currentNodeKey"
        :expand-on-click-node="true"
        :default-expand-all="true"
        empty-text=""
        class="workspace-tree"
        @node-click="onNodeClick"
      >
        <template #default="{ data }">
          <span class="tree-node-label">
            <el-icon v-if="data.type === 'workspace'" :size="16">
              <FolderOpened />
            </el-icon>
            <el-icon v-else :size="16">
              <ChatDotRound />
            </el-icon>

            <span class="node-text">{{ data.label }}</span>

            <!-- 会话：消息数 + 运行中标记 -->
            <span v-if="data.type === 'conversation'" class="node-meta">
              <span v-if="data.running" class="running-dot" title="运行中"></span>
              <span class="msg-count">{{ data.messageCount || 0 }}</span>
            </span>

            <!-- workspace 悬停操作 -->
            <span v-if="data.type === 'workspace'" class="node-actions" @click.stop>
              <el-tooltip content="重命名" placement="top" effect="light">
                <el-button :icon="Edit" size="small" text @click="openRename(data)" />
              </el-tooltip>
              <el-tooltip content="删除" placement="top" effect="light">
                <el-button :icon="Delete" size="small" text @click="openDelete(data)" />
              </el-tooltip>
            </span>
          </span>
        </template>
      </el-tree>

      <!-- 无 workspace 空态 -->
      <div v-if="workspaceStore.workspaces.length === 0" class="tree-empty">
        暂无工作空间
      </div>
    </div>

    <!-- 底部：新建对话 -->
    <div class="sidebar-footer">
      <el-button
        type="primary"
        :icon="ChatLineSquare"
        class="new-chat-btn"
        :disabled="!activeWorkspaceId"
        @click="showNewChat = true"
      >
        新建对话
      </el-button>
    </div>

    <!-- ========== 新建 workspace ========== -->
    <el-dialog
      v-model="showAddWorkspace"
      title="新建工作空间"
      width="420px"
      :close-on-click-modal="false"
    >
      <el-form :model="wsForm" label-width="64px" @submit.prevent>
        <el-form-item label="名称" required>
          <el-input v-model="wsForm.name" placeholder="工作空间名称" @keyup.enter="confirmAddWorkspace" />
        </el-form-item>
        <el-form-item label="目录">
          <el-input v-model="wsForm.cwd" placeholder="工作目录路径" @keyup.enter="confirmAddWorkspace" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showAddWorkspace = false">取消</el-button>
        <el-button type="primary" :disabled="!wsForm.name.trim()" @click="confirmAddWorkspace">
          确定
        </el-button>
      </template>
    </el-dialog>

    <!-- ========== 重命名 workspace ========== -->
    <el-dialog v-model="showRename" title="重命名工作空间" width="400px" :close-on-click-modal="false">
      <el-form label-width="64px" @submit.prevent>
        <el-form-item label="名称" required>
          <el-input v-model="renameName" @keyup.enter="confirmRename" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showRename = false">取消</el-button>
        <el-button type="primary" :disabled="!renameName.trim()" @click="confirmRename">确定</el-button>
      </template>
    </el-dialog>

    <!-- ========== 删除确认 ========== -->
    <el-dialog v-model="showDelete" title="删除工作空间" width="380px" :close-on-click-modal="false">
      <div class="delete-warning">
        <el-icon :size="20" color="var(--el-color-warning)"><WarningFilled /></el-icon>
        <span>确定删除「<strong>{{ deleteTargetName }}</strong>」？其全部会话将一并删除。</span>
      </div>
      <template #footer>
        <el-button @click="showDelete = false">取消</el-button>
        <el-button type="danger" @click="confirmDelete">删除</el-button>
      </template>
    </el-dialog>

    <!-- ========== 新建对话（选 Agent） ========== -->
    <NewChatDialog v-model="showNewChat" />
  </el-aside>
</template>

<script setup lang="ts">
import { ref, reactive, computed } from "vue";
import {
  Plus,
  Edit,
  Delete,
  FolderOpened,
  ChatDotRound,
  ChatLineSquare,
  WarningFilled,
} from "@element-plus/icons-vue";
import NewChatDialog from "./NewChatDialog.vue";
import { useWorkspaceStore } from "../../stores/workspace.js";
import { useConversationStore } from "../../stores/conversation.js";

const workspaceStore = useWorkspaceStore();
const conversationStore = useConversationStore();

const activeWorkspaceId = computed(() => workspaceStore.activeWorkspaceId);

// 新建 workspace
const showAddWorkspace = ref(false);
const wsForm = reactive({ name: "", cwd: "" });

// 重命名
const showRename = ref(false);
const renameTargetId = ref("");
const renameName = ref("");

// 删除
const showDelete = ref(false);
const deleteTargetId = ref("");
const deleteTargetName = ref("");

// 新建对话
const showNewChat = ref(false);

// ==================== 树数据 ====================
interface TreeNode {
  id: string;
  label: string;
  type: "workspace" | "conversation";
  messageCount?: number;
  running?: boolean;
}

const treeData = computed<TreeNode[]>(() =>
  workspaceStore.workspaces.map((ws) => ({
    id: ws.id,
    label: ws.name,
    type: "workspace" as const,
    children: conversationStore.conversations
      .filter((c) => c.workspaceId === ws.id)
      .map((c) => ({
        id: c.id,
        label: c.name,
        type: "conversation" as const,
        messageCount: c.messageCount,
        running: c.running,
      })),
  })),
);

const treeProps = { children: "children", label: "label" };

const currentNodeKey = computed(() => conversationStore.activeConversationId || workspaceStore.activeWorkspaceId);

// ==================== 事件 ====================
function onNodeClick(data: TreeNode) {
  if (data.type === "workspace") {
    void workspaceStore.setActive(data.id);
  } else {
    conversationStore.select(data.id);
  }
}

// ----- workspace CRUD -----
async function confirmAddWorkspace() {
  if (!wsForm.name.trim()) return;
  await workspaceStore.create({
    name: wsForm.name.trim(),
    cwd: wsForm.cwd.trim(),
  });
  wsForm.name = "";
  wsForm.cwd = "";
  showAddWorkspace.value = false;
}

function openRename(data: TreeNode) {
  renameTargetId.value = data.id;
  renameName.value = data.label;
  showRename.value = true;
}

async function confirmRename() {
  if (!renameName.value.trim()) return;
  await workspaceStore.rename(renameTargetId.value, renameName.value.trim());
  showRename.value = false;
}

function openDelete(data: TreeNode) {
  deleteTargetId.value = data.id;
  deleteTargetName.value = data.label;
  showDelete.value = true;
}

async function confirmDelete() {
  await workspaceStore.remove(deleteTargetId.value);
  showDelete.value = false;
}
</script>

<style lang="scss" scoped>
.sidebar {
  display: flex;
  flex-direction: column;
  background-color: var(--el-bg-color);
  border: 1px solid var(--el-border-color);
  border-radius: 8px;
  user-select: none;
  overflow: hidden;
}

.section {
  flex: 1;
  overflow-y: auto;
  padding: 8px 0;
}

.section-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 16px;
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  color: var(--el-text-color-secondary);
  letter-spacing: 1px;
}

.workspace-tree {
  background: transparent;

  // 屏蔽 el-tree 默认空态（"No Data" + 占位块），改用自定义 tree-empty
  :deep(.el-tree__empty-block) {
    display: none;
  }

  :deep(.el-tree-node__content) {
    height: 36px;
    padding: 0 12px;
    border-radius: 4px;
    margin: 1px 8px;
    transition: background 0.15s;

    &:hover {
      background-color: var(--el-fill-color-light);
    }
  }

  :deep(.el-tree-node.is-current > .el-tree-node__content) {
    background-color: var(--tree-current-bg);
    color: var(--tree-current-text);

    .node-text {
      font-weight: 600;
    }
  }
}

.tree-node-label {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  min-width: 0;

  .node-text {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 13px;
  }

  .node-meta {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
  }

  .running-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--el-color-primary);
    animation: blink 1.2s infinite;
  }

  .msg-count {
    font-size: 11px;
    color: var(--el-text-color-secondary);
    background: var(--el-fill-color-lighter);
    padding: 0 6px;
    border-radius: 6px;
    line-height: 18px;
  }
}

@keyframes blink {
  0%, 100% { opacity: 0.2; }
  50% { opacity: 1; }
}

.node-actions {
  display: none;
  flex-shrink: 0;
  gap: 1px;
  margin-left: auto;

  :deep(.el-button) {
    --el-button-size: 22px;
    font-size: 13px;
    color: var(--el-text-color-secondary);

    &:hover {
      color: var(--el-color-primary);
    }
  }
}

:deep(.el-tree-node__content:hover) .node-actions {
  display: inline-flex;
}

.tree-empty {
  padding: 24px 16px;
  text-align: center;
  font-size: 13px;
  color: var(--el-text-color-placeholder);
}

// ==================== 底部 ====================
.sidebar-footer {
  padding: 12px;
  border-top: 1px solid var(--el-border-color);
}

.new-chat-btn {
  width: 100%;
}

.delete-warning {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
}
</style>
