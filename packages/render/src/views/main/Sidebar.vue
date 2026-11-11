<template>
  <el-aside width="280px" class="sidebar">
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
        ref="treeRef"
        :data="treeData"
        :props="treeProps"
        node-key="id"
        highlight-current
        :current-node-key="currentNodeKey"
        :expand-on-click-node="false"
        empty-text=""
        class="workspace-tree"
        @node-click="onNodeClick"
        @node-contextmenu="onContextMenu"
        @node-expand="onNodeExpand"
        @node-collapse="onNodeCollapse"
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

            <!-- workspace：会话数 -->
            <span v-if="data.type === 'workspace'" class="node-meta">
              <span class="msg-count" :title="`${data.messageCount || 0} 个会话`">
                {{ data.messageCount || 0 }}
              </span>
            </span>

            <!-- 会话：消息数 + 运行中标记 -->
            <span v-if="data.type === 'conversation'" class="node-meta">
              <span v-if="data.running" class="running-dot" title="运行中"></span>
              <span class="msg-count" :title="`${data.messageCount || 0} 条消息`">
                {{ data.messageCount || 0 }}
              </span>
            </span>

          </span>
        </template>
      </el-tree>

      <div v-if="workspaceStore.workspaces.length === 0" class="tree-empty">
        暂无工作空间
      </div>
    </div>

    <!-- 底部：新建对话 + 设置 -->
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
      <el-button text :icon="Setting" class="settings-btn" @click="openSettings">
        设置
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
        <el-form-item label="名称">
          <el-input v-model="wsForm.name" placeholder="选填，默认使用文件夹名称" @keyup.enter="confirmAddWorkspace" />
        </el-form-item>
        <el-form-item label="目录">
          <el-input v-model="wsForm.cwd" placeholder="选填，默认使用桌面" @keyup.enter="confirmAddWorkspace">
            <template #append>
              <el-button :icon="Folder" @click="pickWorkspaceDir">选择</el-button>
            </template>
          </el-input>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showAddWorkspace = false">取消</el-button>
        <el-button type="primary" :loading="adding" @click="confirmAddWorkspace">确定</el-button>
      </template>
    </el-dialog>

    <!-- ========== 重命名（workspace / conversation） ========== -->
    <el-dialog
      v-model="showRename"
      :title="renameTargetType === 'workspace' ? '重命名工作空间' : '重命名对话'"
      width="400px"
      :close-on-click-modal="false"
    >
      <el-form label-width="64px" @submit.prevent>
        <el-form-item label="名称" required>
          <el-input v-model="renameName" @keyup.enter="confirmRename" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showRename = false">取消</el-button>
        <el-button
          type="primary"
          :disabled="!renameName.trim()"
          :loading="renaming"
          @click="confirmRename"
        >
          确定
        </el-button>
      </template>
    </el-dialog>

    <!-- ========== 删除确认（workspace / conversation） ========== -->
    <el-dialog
      v-model="showDelete"
      :title="deleteTargetType === 'workspace' ? '删除工作空间' : '删除对话'"
      width="380px"
      :close-on-click-modal="false"
    >
      <div class="delete-warning">
        <el-icon :size="20" color="var(--el-color-warning)"><WarningFilled /></el-icon>
        <span v-if="deleteTargetType === 'workspace'">
          确定删除「<strong>{{ deleteTargetName }}</strong>」？其全部会话将一并删除。
        </span>
        <span v-else>
          确定删除对话「<strong>{{ deleteTargetName }}</strong>」？
        </span>
      </div>
      <template #footer>
        <el-button @click="showDelete = false">取消</el-button>
        <el-button type="danger" :loading="deleting" @click="confirmDelete">删除</el-button>
      </template>
    </el-dialog>

    <!-- ========== 新建对话（选 Agent） ========== -->
    <NewChatDialog v-model="showNewChat" />

    <!-- ========== 右键菜单（workspace / conversation） ========== -->
    <teleport to="body">
      <div
        v-if="ctxMenu.visible"
        class="context-menu"
        :style="{ left: ctxMenu.x + 'px', top: ctxMenu.y + 'px' }"
        @click.stop
        @contextmenu.prevent.stop
      >
        <!-- workspace 右键：可新建对话 -->
        <div
          v-if="ctxMenu.target?.type === 'workspace'"
          class="context-menu-item"
          @click="ctxNewChat"
        >
          <el-icon :size="14"><ChatLineSquare /></el-icon>
          <span>新建对话</span>
        </div>
        <div class="context-menu-item" @click="ctxRename">
          <el-icon :size="14"><Edit /></el-icon>
          <span>重命名</span>
        </div>
        <div class="context-menu-item danger" @click="ctxDelete">
          <el-icon :size="14"><Delete /></el-icon>
          <span>删除</span>
        </div>
      </div>
    </teleport>
  </el-aside>
</template>

<script setup lang="ts">
import { ref, reactive, computed, watch, nextTick, onMounted, onUnmounted } from "vue";
import {
  Plus,
  Edit,
  Delete,
  FolderOpened,
  ChatDotRound,
  ChatLineSquare,
  WarningFilled,
  Folder,
  Setting,
} from "@element-plus/icons-vue";
import { ElMessage } from "element-plus";
import NewChatDialog from "./NewChatDialog.vue";
import { useWorkspaceStore } from "../../stores/workspace.js";
import { useConversationStore } from "../../stores/conversation.js";
import { useUiStore } from "../../stores/ui.js";

const workspaceStore = useWorkspaceStore();
const conversationStore = useConversationStore();
const uiStore = useUiStore();

function openSettings() {
  uiStore.setView("settings");
}

const activeWorkspaceId = computed(() => workspaceStore.activeWorkspaceId);

const showAddWorkspace = ref(false);
const wsForm = reactive({ name: "", cwd: "" });
// 提交中的标记：确认按钮上 `:loading`，防连点重复提交（新建/重命名/删除各一个）
const adding = ref(false);

// 重命名（workspace / conversation 共用，按类型分发）
const showRename = ref(false);
const renameTargetId = ref("");
const renameTargetType = ref<"workspace" | "conversation">("workspace");
const renameTargetWorkspaceId = ref("");
const renameName = ref("");
const renaming = ref(false);

// 删除（workspace / conversation 共用，按类型分发）
const showDelete = ref(false);
const deleteTargetId = ref("");
const deleteTargetType = ref<"workspace" | "conversation">("workspace");
const deleteTargetWorkspaceId = ref("");
const deleteTargetName = ref("");
const deleting = ref(false);

const showNewChat = ref(false);

// 右键菜单（workspace / conversation 共用）
const ctxMenu = reactive({
  visible: false,
  x: 0,
  y: 0,
  target: null as TreeNode | null,
});

// ==================== 树数据 ====================
interface TreeNode {
  id: string;
  label: string;
  type: "workspace" | "conversation";
  /** conversation 节点所属的 workspace */
  workspaceId?: string;
  messageCount?: number;
  running?: boolean;
  children?: TreeNode[];
}

const treeData = computed<TreeNode[]>(() =>
  workspaceStore.workspaces.map((ws) => ({
    id: ws.id,
    label: ws.name,
    type: "workspace" as const,
    // 会话数（页面加载后即预载，树节点可直接显示）
    messageCount: conversationStore.listOf(ws.id).length,
    children: conversationStore.listOf(ws.id).map((c) => ({
        id: c.id,
        label: c.name,
        type: "conversation" as const,
        workspaceId: c.workspaceId,
        messageCount: c.messageCount,
        running: c.running,
      })),
  })),
);

const treeProps = { children: "children", label: "label" };

const currentNodeKey = computed(() => conversationStore.activeConversationId || workspaceStore.activeWorkspaceId);

// ==================== 受控展开 ====================
// el-tree 在 data 更新时会重置展开状态（切换 workspace 后已折叠的节点自动展开）。
// 这里自己维护 expandedKeys，树数据变化后通过 setExpandedKeys 恢复。
const treeRef = ref<{
  store: {
    getNode: (key: string) => { expand: () => void } | undefined;
  };
}>();
const expandedKeys = ref<string[]>([]);

function collectAllKeys(nodes: TreeNode[]): string[] {
  const keys: string[] = [];
  for (const n of nodes) {
    keys.push(n.id);
    if (n.children?.length) keys.push(...collectAllKeys(n.children));
  }
  return keys;
}

/** 展开指定节点（el-tree 重建后默认全折叠，只恢复用户展开过的） */
function applyExpandedKeys(keys: string[]) {
  const store = treeRef.value?.store;
  if (!store) return;
  for (const key of keys) {
    store.getNode(key)?.expand();
  }
}

// 树数据变化（切换 workspace / 会话刷新）：首次全展开，之后恢复用户展开状态
watch(
  treeData,
  (nodes) => {
    const keys = expandedKeys.value.length
      ? expandedKeys.value
      : collectAllKeys(nodes);
    expandedKeys.value = keys;
    nextTick(() => applyExpandedKeys(keys));
  },
  { immediate: true },
);

function onNodeExpand(data: TreeNode) {
  if (!expandedKeys.value.includes(data.id)) {
    expandedKeys.value.push(data.id);
  }
}

function onNodeCollapse(data: TreeNode) {
  expandedKeys.value = expandedKeys.value.filter((k) => k !== data.id);
}

// ==================== 事件 ====================

/**
 * 切换激活工作空间（左键点节点、右键选中节点都走这里）。
 *
 * `setActive` 在 store 里还会顺手拉该工作空间的会话列表（`conversation.load`），那一步是会抛的
 * —— 比如这个工作空间刚在别处被删掉、或者连接断了。以前调用点写的是 `void workspaceStore.setActive()`：
 * 失败既不提示、也不在界面上留下任何痕迹（树上高亮已经切过去了，会话列表却是空的），
 * 用户只会以为「这个空间里确实没有会话」。
 *
 * 所以这里收口成一个带提示的包装，调用点仍然是 `void`：点击处理函数保持同步返回，
 * 失败由这个包装自己报，不会变成 unhandled rejection。
 */
async function activateWorkspace(id: string) {
  try {
    await workspaceStore.setActive(id);
  } catch (err) {
    // 说清是哪件事：切换过去了、但那个空间的会话没能读出来
    ElMessage.error(`切换工作空间失败：${err instanceof Error ? err.message : String(err)}`);
  }
}

function onNodeClick(data: TreeNode) {
  if (data.type === "workspace") {
    void activateWorkspace(data.id);
  } else {
    // 会话：若跨 workspace，先把激活工作空间切过去
    if (data.workspaceId && data.workspaceId !== workspaceStore.activeWorkspaceId) {
      void activateWorkspace(data.workspaceId);
    }
    conversationStore.select(data.workspaceId ?? "", data.id);
  }
}

// ----- 右键菜单 -----
function onContextMenu(event: MouseEvent, data: TreeNode) {
  event.preventDefault();
  // 右键即选中该节点（与左键一致），操作目标 = 右键的节点
  if (data.type === "workspace") {
    void activateWorkspace(data.id);
  } else if (data.workspaceId) {
    if (data.workspaceId !== workspaceStore.activeWorkspaceId) {
      void activateWorkspace(data.workspaceId);
    }
    conversationStore.select(data.workspaceId, data.id);
  }
  // 菜单定位在鼠标处，视口边缘自动收拢
  // workspace 有「新建对话/重命名/删除」3 项，conversation 2 项
  const itemCount = data.type === "workspace" ? 3 : 2;
  const menuW = 128;
  const menuH = itemCount * 34 + 8;
  ctxMenu.x = Math.min(event.clientX, window.innerWidth - menuW);
  ctxMenu.y = Math.min(event.clientY, window.innerHeight - menuH);
  ctxMenu.target = data;
  ctxMenu.visible = true;
}

function closeCtxMenu() {
  ctxMenu.visible = false;
  ctxMenu.target = null;
}

function ctxNewChat() {
  // 右键 workspace 时已 setActive，直接打开新建对话（落在该 workspace 下）
  showNewChat.value = true;
  closeCtxMenu();
}

function ctxRename() {
  if (ctxMenu.target) openRename(ctxMenu.target);
  closeCtxMenu();
}

function ctxDelete() {
  if (ctxMenu.target) openDelete(ctxMenu.target);
  closeCtxMenu();
}

function onDocPointerDown(event: Event) {
  // 点击在菜单内部不关闭（菜单项靠 click 触发；否则 pointerdown 会先销毁菜单导致 click 落空）
  const menuEl = document.querySelector(".context-menu");
  if (menuEl && event.target instanceof Node && menuEl.contains(event.target)) {
    return;
  }
  closeCtxMenu();
}

onMounted(() => {
  document.addEventListener("pointerdown", onDocPointerDown);
  document.addEventListener("contextmenu", onDocPointerDown);
  window.addEventListener("blur", onDocPointerDown);
  window.addEventListener("resize", onDocPointerDown);
  document.addEventListener("scroll", onDocPointerDown, true);
});

onUnmounted(() => {
  document.removeEventListener("pointerdown", onDocPointerDown);
  document.removeEventListener("contextmenu", onDocPointerDown);
  window.removeEventListener("blur", onDocPointerDown);
  window.removeEventListener("resize", onDocPointerDown);
  document.removeEventListener("scroll", onDocPointerDown, true);
});

// ----- workspace CRUD -----
async function pickWorkspaceDir() {
  const dir = await window.electronAPI.selectDirectory();
  if (dir) wsForm.cwd = dir;
}

async function confirmAddWorkspace() {
  // 名称/目录均选填：名称空用目录名兜底、目录空用默认桌面（两者都在 main 的 services.ts 补齐）
  adding.value = true;
  try {
    await workspaceStore.create({
      name: wsForm.name.trim(),
      cwd: wsForm.cwd.trim(),
    });
    ElMessage.success("工作空间已创建");
    // 清表单、关对话框只放在成功之后：失败时用户填的名称/目录还留着，改完直接再点确定
    wsForm.name = "";
    wsForm.cwd = "";
    showAddWorkspace.value = false;
  } catch (err) {
    // 目录不存在 / 没权限这类原因由 main 那边给出来，直接转给用户看
    ElMessage.error(`新建工作空间失败：${err instanceof Error ? err.message : String(err)}`);
  } finally {
    adding.value = false;
  }
}

function openRename(data: TreeNode) {
  renameTargetId.value = data.id;
  renameTargetType.value = data.type;
  renameTargetWorkspaceId.value = data.workspaceId ?? "";
  renameName.value = data.label;
  showRename.value = true;
}

async function confirmRename() {
  const name = renameName.value.trim();
  // 名字为空就早退：模板里按钮已置灰，回车键仍可能进来。
  // 早退发生在 `renaming` 置位之前 —— 别把按钮留在转圈里。
  if (!name) return;

  const type = renameTargetType.value;
  const kind = type === "workspace" ? "工作空间" : "对话";
  renaming.value = true;
  try {
    if (type === "workspace") {
      await workspaceStore.rename(renameTargetId.value, name);
    } else {
      await conversationStore.rename(renameTargetWorkspaceId.value, renameTargetId.value, name);
    }
    ElMessage.success(`重命名${kind}成功`);
    // 只有成功才关：失败时对话框留着、用户输入留着，改完名直接再点一次确定
    showRename.value = false;
  } catch (err) {
    // store 是「先调 api、成功了才改本地状态」（apis 把错误收敛成 InvokeServerError，
    // message 就是服务端那句话）。所以这里只需把「哪件事失败 + 原因」说给用户听。
    ElMessage.error(`重命名${kind}失败：${err instanceof Error ? err.message : String(err)}`);
  } finally {
    renaming.value = false;
  }
}

function openDelete(data: TreeNode) {
  deleteTargetId.value = data.id;
  deleteTargetType.value = data.type;
  deleteTargetWorkspaceId.value = data.workspaceId ?? "";
  deleteTargetName.value = data.label;
  showDelete.value = true;
}

async function confirmDelete() {
  const type = deleteTargetType.value;
  const name = deleteTargetName.value;
  deleting.value = true;
  try {
    if (type === "workspace") {
      await workspaceStore.remove(deleteTargetId.value);
      // 工作空间删除会连带删掉它下面的全部会话：成功提示里点明，别让用户以为会话还留着
      ElMessage.success(`工作空间「${name}」及其全部会话已删除`);
    } else {
      await conversationStore.remove(deleteTargetWorkspaceId.value, deleteTargetId.value);
      ElMessage.success(`对话「${name}」已删除`);
    }
    // 只有成功才关（失败时对话框留着，用户看完原因可以直接重试）
    showDelete.value = false;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    // 工作空间这条要额外说清「会话也还都在」：这个对话框一开始就警告过会连带删除，
    // 失败时同样得让人知道连带那部分没有发生。
    ElMessage.error(
      type === "workspace"
        ? `删除工作空间失败（该空间及其会话都还在）：${reason}`
        : `删除对话失败：${reason}`,
    );
  } finally {
    deleting.value = false;
  }
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

// ==================== 右键菜单 ====================
.context-menu {
  position: fixed;
  z-index: 3000;
  min-width: 128px;
  padding: 4px;
  background: var(--el-bg-color-overlay);
  border: 1px solid var(--el-border-color-light);
  border-radius: 6px;
  box-shadow: var(--el-box-shadow-light);

  .context-menu-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 7px 12px;
    font-size: 13px;
    color: var(--el-text-color-regular);
    border-radius: 4px;
    cursor: pointer;
    user-select: none;

    &:hover {
      background: rgba(var(--el-color-primary-rgb), 0.12);
      color: var(--el-color-primary);
      font-weight: 500;
    }

    &.danger {
      color: var(--el-color-danger);

      &:hover {
        background: rgba(var(--el-color-danger-rgb), 0.12);
        color: var(--el-color-danger);
        font-weight: 500;
      }
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

.settings-btn {
  width: 100%;
  margin-top: 8px;
  color: var(--el-text-color-secondary);
}

.delete-warning {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
}
</style>
