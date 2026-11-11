<template>
  <!--
    首启引导屏（`connection:state` 为 `unset`）。

    它与「连接状态屏」是两件事：那边说的是「正在连 / 连不上」，这边说的是**还没选**。所以它不
    显示任何进度或错误（没有任何东西在跑），只有两个选项和一个按钮 —— 把决定交回用户，而不是
    替他猜一个默认值（猜 local 的后果是：应用一启动就去拉起一个本地服务端，「引导」永远出不来）。
  -->
  <div class="setup-view">
    <div class="setup-card">
      <div class="logo">
        <el-icon :size="56" color="var(--el-color-primary)"><Connection /></el-icon>
      </div>

      <h1 class="title">欢迎使用 AI-Zen</h1>
      <p class="desc">
        先选一个服务端。会话、Agent、模型配置都在它那边——这个选择只做一次，之后自动连上次那台。
      </p>

      <el-form label-width="88px" class="setup-form" @submit.prevent>
        <el-form-item label="服务端">
          <el-radio-group v-model="mode" @change="onModeChange">
            <el-radio value="local">本机</el-radio>
            <el-radio value="remote">远程</el-radio>
          </el-radio-group>
        </el-form-item>

        <template v-if="mode === 'remote'">
          <el-form-item label="地址">
            <el-input v-model="serverUrl" placeholder="wss://example.com/ai-zen 或 10.0.0.5:8790" />
          </el-form-item>
          <el-form-item label="凭证">
            <el-input
              v-model="serverToken"
              type="password"
              show-password
              placeholder="留空 = 用本机 run/token"
            />
          </el-form-item>
        </template>

        <p class="hint">
          本机 = 在这台电脑上启动 / 连接常驻服务端（不需要网络）；
          远程 = 只连上面填的地址，<strong>不会</strong>在本机拉起服务端。
        </p>

        <!-- 测试结果：成功说协议版本与耗时（用户判断「远端慢不慢」的唯一依据），失败说人话 -->
        <el-alert
          v-if="probe"
          class="probe"
          :type="probe.ok ? 'success' : 'error'"
          :title="probeText"
          :closable="false"
          show-icon
        />
      </el-form>

      <div class="actions">
        <el-button v-if="mode === 'remote'" :loading="connectionStore.testing" @click="testConnection">
          测试连接
        </el-button>
        <el-button type="primary" size="large" :loading="saving" @click="submit">
          {{ mode === "remote" ? "连接并继续" : "启动并继续" }}
        </el-button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { ElMessage } from "element-plus";
import { Connection } from "@element-plus/icons-vue";
import { normalizeServerAddress } from "@ai-zen/desktop-shared";
import { useConnectionStore } from "../../stores/connection.js";

const connectionStore = useConnectionStore();

/** 与设置页同一个默认值：本机（用户此刻还能改） */
const mode = ref<"local" | "remote">("local");
const serverUrl = ref("");
const serverToken = ref("");
/** 「继续」进行中（测试 + 保存两段） */
const saving = ref(false);

const probe = computed(() => connectionStore.probe);
const probeText = computed(() => {
  const result = connectionStore.probe;
  if (!result) return "";
  if (!result.ok) return result.message;
  const version = result.version || "未知版本";
  return `连上了：协议 ${result.protocol} · 服务端 ${version} · ${result.elapsedMs}ms`;
});

/** 打开首启屏时清掉上一次的试连结论（可能是设置页那边留下的旧地址的结论） */
onMounted(() => connectionStore.resetProbe());

/** 切到本机时把试连结论清掉：那句话说的是某个远程地址，与本地无关 */
function onModeChange() {
  connectionStore.resetProbe();
}

async function testConnection() {
  await connectionStore.test({
    serverUrl: normalizeServerAddress(serverUrl.value),
    ...(serverToken.value.trim() ? { serverToken: serverToken.value.trim() } : {}),
  });
}

/**
 * 「继续」= **先验证再落盘**。
 *
 * 远程：先试连一次（`connection:test` 不落盘、不碰当前连接），通了才 `save`。
 * 本机：没有「试连」这回事（地址来自发现文件，服务端可能还没起），所以直接保存 —— 它会在
 * 后台拉起服务端，连不上就落到连接状态屏，用户从那里回得来（设置页永远进得去）。
 *
 * 这条顺序与 CLI 连接屏是同一条：**不把一个已知是错的配置留在盘上**，否则下次启动先撞一次
 * 同样的墙。（桌面端的设置页相反 —— 用户在那边明确改了配置，尊重他的意图，所以那边是
 * 「先落盘再换层」。两处语义不同，各自写清。）
 */
async function submit() {
  saving.value = true;
  try {
    if (mode.value === "remote") {
      const candidate = {
        serverUrl: normalizeServerAddress(serverUrl.value),
        ...(serverToken.value.trim() ? { serverToken: serverToken.value.trim() } : {}),
      };
      await connectionStore.test(candidate);
      if (!connectionStore.probe?.ok) return; // 原因就在屏上，地址与凭证不动
      await connectionStore.save({ mode: "remote", ...candidate });
    } else {
      await connectionStore.save({ mode: "local" });
    }
    // 保存成功之后不用切视图：连接状态一变（`ready`），`App.vue` 自己会放行到主界面
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ElMessage.error(message);
  } finally {
    saving.value = false;
  }
}
</script>

<style lang="scss">
.setup-view {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--el-bg-color-page);
}

.setup-card {
  width: 560px;
  padding: 32px 36px;
  background: var(--el-bg-color);
  border-radius: 12px;
  box-shadow: var(--el-box-shadow-light);
  text-align: center;
}

.setup-card .logo {
  margin-bottom: 12px;
}

.setup-card .title {
  margin: 0 0 8px;
  font-size: 22px;
}

.setup-card .desc {
  margin: 0 0 24px;
  color: var(--el-text-color-secondary);
  font-size: 13px;
  line-height: 1.7;
}

.setup-form {
  text-align: left;
}

.setup-form .hint {
  margin: 4px 0 12px;
  color: var(--el-text-color-secondary);
  font-size: 12px;
  line-height: 1.7;
}

.probe {
  margin-bottom: 12px;
}

.actions {
  display: flex;
  gap: 12px;
  justify-content: center;
  margin-top: 8px;
}
</style>
