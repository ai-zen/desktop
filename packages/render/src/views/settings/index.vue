<template>
  <div class="settings-view">
    <div class="settings-card">
      <div class="settings-header">
        <h2 class="title">设置</h2>
        <el-button text :icon="Back" @click="goBack">返回</el-button>
      </div>

      <el-form label-width="110px" class="settings-form" @submit.prevent>
        <el-form-item label="默认模型">
          <el-select v-model="form.defaultModel" class="wide">
            <el-option
              v-for="m in uiStore.models"
              :key="m.id"
              :label="m.name"
              :value="m.id"
            />
          </el-select>
        </el-form-item>

        <el-form-item label="默认 Agent">
          <el-select v-model="form.defaultAgent" class="wide">
            <el-option
              v-for="a in uiStore.agents"
              :key="a.id"
              :label="a.name"
              :value="a.id"
            />
          </el-select>
        </el-form-item>

        <el-divider content-position="left">API Key</el-divider>

        <el-form-item
          v-for="ep in form.endpoints"
          :key="ep.id"
          :label="ep.name"
        >
          <el-input
            v-model="ep.apiKey"
            type="password"
            show-password
            :placeholder="`${ep.baseUrl} 的 API Key`"
          />
        </el-form-item>

        <el-divider content-position="left">数据目录</el-divider>

        <el-form-item label="数据目录">
          <el-input :model-value="form.dataDir" readonly />
        </el-form-item>
      </el-form>

      <div class="actions">
        <el-button @click="reload">恢复</el-button>
        <el-button type="primary" :loading="saving" @click="save">保存</el-button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted } from "vue";
import { Back } from "@element-plus/icons-vue";
import { ElMessage } from "element-plus";
import { useUiStore } from "../../stores/ui.js";
import * as api from "../../apis/index.js";
import type { ConfigSettings } from "@ai-zen/desktop-shared";

const uiStore = useUiStore();
const saving = ref(false);

const form = reactive<ConfigSettings>({
  endpoints: [],
  defaultModel: "",
  defaultAgent: "",
  dataDir: "",
});

async function reload() {
  const cfg = await api.getConfigSettings();
  form.endpoints = cfg.endpoints;
  form.defaultModel = cfg.defaultModel;
  form.defaultAgent = cfg.defaultAgent;
  form.dataDir = cfg.dataDir;
}

async function save() {
  saving.value = true;
  try {
    await api.updateConfigSettings({
      defaultModel: form.defaultModel,
      defaultAgent: form.defaultAgent,
      endpoints: form.endpoints,
    });
    await uiStore.loadOptions();
    ElMessage.success("设置已保存");
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : String(err));
  } finally {
    saving.value = false;
  }
}

function goBack() {
  uiStore.setView("main");
}

onMounted(async () => {
  if (!uiStore.models.length) await uiStore.loadOptions();
  await reload();
});
</script>

<style lang="scss" scoped>
.settings-view {
  flex: 1;
  display: flex;
  justify-content: center;
  padding: 24px 16px;
  overflow-y: auto;
}

.settings-card {
  width: 100%;
  max-width: 560px;
  padding: 28px 32px;
  background: var(--el-bg-color);
  border: 1px solid var(--el-border-color);
  border-radius: 8px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.06);
}

.settings-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 20px;

  .title {
    font-size: 20px;
    font-weight: 700;
    margin: 0;
  }
}

.wide {
  width: 100%;
}

.actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 16px;
}
</style>
