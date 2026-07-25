<template>
  <el-aside width="280px" class="sidebar">
    <!-- 头部 -->
    <div class="sidebar-header">
      <el-icon :size="22" color="var(--el-color-primary)">
        <MagicStick />
      </el-icon>
      <span class="app-title">AI-Zen</span>
    </div>

    <!-- Workspace 选择器 -->
    <div class="section">
      <div class="section-title">
        <span>工作空间</span>
        <el-tooltip content="新建工作空间" placement="top">
          <el-button
            :icon="Plus"
            size="small"
            text
            @click="showAddWorkspace = true"
          />
        </el-tooltip>
      </div>
      <el-tree
        ref="treeRef"
        :data="treeData"
        :props="treeProps"
        node-key="id"
        highlight-current
        :current-node-key="activeWorkspaceId"
        @node-click="onNodeClick"
        :expand-on-click-node="true"
        :default-expand-all="true"
        class="workspace-tree"
      >
        <template #default="{ node, data }">
          <span class="tree-node-label">
            <el-icon v-if="data.type === 'workspace'" :size="16">
              <FolderOpened />
            </el-icon>
            <el-icon v-else :size="16">
              <ChatDotRound />
            </el-icon>
            <span class="node-text">{{ data.label }}</span>
            <span v-if="data.type === 'conversation'" class="msg-count">
              {{ data.messageCount || 0 }}
            </span>
          </span>
        </template>
      </el-tree>
    </div>

    <!-- 底部操作栏 -->
    <div class="sidebar-footer">
      <el-button
        type="primary"
        :icon="ChatLineSquare"
        class="new-chat-btn"
        @click="handleNewChat"
        :disabled="!activeWorkspaceId"
      >
        新建对话
      </el-button>
    </div>

    <!-- 新建 Workspace 对话框 -->
    <el-dialog
      v-model="showAddWorkspace"
      title="新建工作空间"
      width="400px"
      :close-on-click-modal="false"
    >
      <el-form :model="workspaceForm" label-width="80px">
        <el-form-item label="名称" required>
          <el-input v-model="workspaceForm.name" placeholder="输入工作空间名称" />
        </el-form-item>
        <el-form-item label="路径">
          <el-input v-model="workspaceForm.path" placeholder="可选：工作目录路径" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showAddWorkspace = false">取消</el-button>
        <el-button type="primary" @click="handleAddWorkspace">确定</el-button>
      </template>
    </el-dialog>
  </el-aside>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted, computed } from "vue";
import { Plus, FolderOpened, ChatDotRound, ChatLineSquare, MagicStick } from "@element-plus/icons-vue";
import type { Workspace, ConversationSummary } from "@ai-zen/desktop-shared";

// ==================== 状态 ====================
const workspaces = ref<Workspace[]>([]);
const activeWorkspaceId = ref<string>("");
const conversations = ref<ConversationSummary[]>([]);
const activeConversationId = ref<string | undefined>();
const showAddWorkspace = ref(false);
const workspaceForm = reactive({ name: "", path: "" });

// ==================== 树形数据 ====================
interface TreeNode {
  id: string;
  label: string;
  type: "workspace" | "conversation";
  children?: TreeNode[];
  messageCount?: number;
}

const treeData = computed<TreeNode[]>(() => {
  return workspaces.value.map((ws) => ({
    id: ws.id,
    label: ws.name,
    type: "workspace" as const,
    children: conversations.value
      .filter((c) => c.workspaceId === ws.id)
      .map((c) => ({
        id: c.id,
        label: c.name,
        type: "conversation" as const,
        messageCount: c.messageCount,
      })),
  }));
});

const treeProps = {
  children: "children",
  label: "label",
};

// ==================== IPC 调用 ====================
function getAPI() {
  return window.electronAPI;
}

async function loadWorkspaces() {
  const api = getAPI();
  if (!api) return;
  try {
    const list = (await api.invoke("workspace", "list")) as Workspace[];
    workspaces.value = list;
    if (list.length > 0 && !activeWorkspaceId.value) {
      activeWorkspaceId.value = list[0].id;
      await loadConversations();
    }
  } catch (e) {
    console.error("加载工作空间失败:", e);
  }
}

async function loadConversations() {
  if (!activeWorkspaceId.value) return;
  const api = getAPI();
  if (!api) return;
  try {
    const list = (await api.invoke("conversation", "list", activeWorkspaceId.value)) as ConversationSummary[];
    conversations.value = list;
  } catch (e) {
    console.error("加载对话列表失败:", e);
  }
}

// ==================== 事件处理 ====================
function onNodeClick(data: TreeNode) {
  if (data.type === "workspace") {
    activeWorkspaceId.value = data.id;
    loadConversations();
  } else if (data.type === "conversation") {
    activeConversationId.value = data.id;
    // 触发对话选中事件（通过自定义事件或 store 传递）
  }
}

async function handleAddWorkspace() {
  if (!workspaceForm.name.trim()) return;
  const api = getAPI();
  if (!api) return;
  try {
    await api.invoke("workspace", "add", workspaceForm.name, workspaceForm.path);
    workspaceForm.name = "";
    workspaceForm.path = "";
    showAddWorkspace.value = false;
    await loadWorkspaces();
  } catch (e) {
    console.error("创建工作空间失败:", e);
  }
}

function handleNewChat() {
  // TODO: 触发新建对话流程
  console.log("新建对话:", activeWorkspaceId.value);
}

// ==================== 生命周期 ====================
onMounted(() => {
  loadWorkspaces();
});
</script>

<style lang="scss" scoped>
.sidebar {
  display: flex;
  flex-direction: column;
  background-color: var(--el-bg-color);
  border: 1px solid var(--el-border-color);
  border-radius: 12px;
  user-select: none;
  overflow: hidden;
}

.sidebar-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 16px;
  border-bottom: 1px solid var(--el-border-color);

  .app-title {
    font-size: 18px;
    font-weight: 700;
    background: linear-gradient(135deg, var(--el-color-primary), #a78bfa);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
  }
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

  :deep(.el-tree-node__content) {
    height: 36px;
    padding: 0 12px;
    border-radius: 6px;
    margin: 1px 8px;
    transition: background 0.15s;

    &:hover {
      background-color: var(--el-fill-color-light);
    }
  }

  :deep(.el-tree-node.is-current > .el-tree-node__content) {
    background-color: var(--el-color-primary-light-9);
    color: var(--el-color-primary);
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

  .msg-count {
    font-size: 11px;
    color: var(--el-text-color-secondary);
    background: var(--el-fill-color-lighter);
    padding: 0 6px;
    border-radius: 10px;
    line-height: 18px;
  }
}

.sidebar-footer {
  padding: 12px;
  border-top: 1px solid var(--el-border-color);
}

.new-chat-btn {
  width: 100%;
}
</style>
