<template>
  <div class="guide-view">
    <div class="guide-card">
      <!-- Logo / 图标 -->
      <div class="logo">
        <el-icon :size="56" color="var(--el-color-primary)">
          <MagicStick />
        </el-icon>
      </div>

      <h1 class="title">欢迎使用 AI-Zen</h1>
      <p class="desc">
        管理你的多个工作空间，每个工作空间对应一个本地目录，
        在各自目录下与 AI 协作对话。
      </p>

      <!-- 创建第一个工作空间 -->
      <el-button type="primary" size="large" class="create-btn" @click="openForm">
        <el-icon style="margin-right: 6px"><Plus /></el-icon>
        创建第一个工作空间
      </el-button>
      <p class="hint">创建后可随时在侧栏添加更多工作空间</p>
    </div>

    <!-- 新建工作空间表单 -->
    <el-dialog
      v-model="showForm"
      title="创建工作空间"
      width="420px"
      :close-on-click-modal="false"
    >
      <el-form :model="form" label-width="64px" @submit.prevent>
        <el-form-item label="名称">
          <el-input
            v-model="form.name"
            placeholder="选填，默认使用文件夹名称"
            @keyup.enter="handleCreate"
          />
        </el-form-item>
        <el-form-item label="目录">
          <el-input
            v-model="form.cwd"
            placeholder="选填，默认使用桌面"
            @keyup.enter="handleCreate"
          >
            <template #append>
              <el-button :icon="Folder" @click="pickDirectory">选择</el-button>
            </template>
          </el-input>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showForm = false">取消</el-button>
        <el-button type="primary" @click="handleCreate">创建</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive } from "vue";
import { Plus, MagicStick, Folder } from "@element-plus/icons-vue";
import { useWorkspaceStore } from "../../stores/workspace.js";
import { useUiStore } from "../../stores/ui.js";

const workspaceStore = useWorkspaceStore();
const uiStore = useUiStore();

const showForm = ref(false);
const form = reactive({ name: "", cwd: "" });

function openForm() {
  showForm.value = true;
}

async function pickDirectory() {
  const dir = await window.electronAPI.selectDirectory();
  if (dir) form.cwd = dir;
}

async function handleCreate() {
  // 名称/目录均选填：名称空由服务端兜底为文件夹名，目录空默认桌面
  const name = form.name.trim();
  const cwd = form.cwd.trim();

  await workspaceStore.create({ name, cwd });
  form.name = "";
  form.cwd = "";
  showForm.value = false;

  // 创建成功 → 进入主界面
  uiStore.setView("main");
}
</script>

<style lang="scss" scoped>
.guide-view {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 8px 8px 8px;
}

.guide-card {
  width: 100%;
  max-width: 460px;
  padding: 48px 40px;
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  background: var(--el-bg-color);
  border: 1px solid var(--el-border-color);
  border-radius: 8px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.06);
}

.logo {
  margin-bottom: 16px;
}

.title {
  font-size: 24px;
  font-weight: 700;
  margin: 0 0 12px 0;
  background: linear-gradient(135deg, var(--el-color-primary), #60a5fa);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}

.desc {
  font-size: 14px;
  line-height: 1.8;
  color: var(--el-text-color-secondary);
  margin: 0 0 28px 0;
}

.create-btn {
  width: 100%;
}

.hint {
  margin: 12px 0 0 0;
  font-size: 12px;
  color: var(--el-text-color-placeholder);
}
</style>
