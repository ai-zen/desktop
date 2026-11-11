<template>
  <div class="status-view">
    <div class="status-card">
      <!--
        还没查到（`state === null`）：这说明「查一次」还在路上，**不是失败**。
        这一支必须先于 error 判断存在，否则窗口一出来会在屏幕上闪一下错误。
      -->
      <template v-if="status === null">
        <el-icon :size="32" class="spin loading-icon">
          <Loading />
        </el-icon>
        <p class="headline">正在读取连接配置…</p>
      </template>

      <!-- 首次尝试 / 重试等待中：两者都是 `connecting`，靠 attempt 与 nextRetryInMs 分开 -->
      <template v-else-if="status === 'connecting'">
        <el-icon :size="40" class="spin loading-icon">
          <Loading />
        </el-icon>
        <p class="headline">
          正在连接 <strong>{{ label }}</strong>
        </p>
        <p v-if="retryText" class="detail">{{ retryText }}</p>
        <div class="actions">
          <el-button @click="goSettings">去设置</el-button>
        </div>
      </template>

      <!-- 重试也失败之后的终态：message 是 main 翻好的人话，原样显示，不在这里改写 -->
      <template v-else-if="status === 'error'">
        <p class="headline">
          连不上 <strong>{{ label }}</strong>
        </p>
        <el-alert
          class="error-alert"
          type="error"
          :title="errorMessage"
          :closable="false"
          show-icon
        />
        <div class="actions">
          <el-button type="primary" :loading="connectionStore.reconnecting" @click="retry">
            重试
          </el-button>
          <el-button @click="goSettings">去设置</el-button>
        </div>
        <p class="detail">也可以在设置里改回本地，或换一个地址。</p>
      </template>

      <!--
        `ready` / `unset` 正常走不到这里：外层（`App.vue`）在这之前就放行了（前者进主界面、
        后者进首启引导屏）。兜一句而不是留一个空白分支 —— 万一哪天放行条件改了，屏幕上不会是
        一块什么都没有的白。
      -->
      <template v-else>
        <p class="headline">
          <template v-if="status === 'unset'">还没选服务端</template>
          <template v-else>已连接 <strong>{{ label }}</strong></template>
        </p>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { Loading } from "@element-plus/icons-vue";
import { ElMessage } from "element-plus";
import { useUiStore } from "../../stores/ui.js";
import { useConnectionStore } from "../../stores/connection.js";

const uiStore = useUiStore();
const connectionStore = useConnectionStore();

/**
 * 模板里一律走下面这几个 computed，而不是直接挖 `connectionStore.state` 的字段。
 *
 * 理由有两层：三态是 discriminated union，字段各不相同（`nextRetryInMs` 只在 `connecting` 上有、
 * `message` 只在 `error` 上有），模板里逐字段取会让每处都要先自己窄化一次；而 `null`（还没查到）
 * 是第四种情况，它不属于任何一支。收成这三个值，模板就只剩「按 status 分支」一件事。
 */
const status = computed(() => connectionStore.state?.status ?? null);

/** 该显示的那一行字：main 已经抹好（本地 = "本机服务端"，远程 = 那个地址，不含凭证） */
const label = computed(() =>
  connectionStore.state && "label" in connectionStore.state ? connectionStore.state.label : "",
);

/** `error` 态那一句人话（原样，不改写、不拼接） */
const errorMessage = computed(() =>
  connectionStore.state?.status === "error" ? connectionStore.state.message : "",
);

/**
 * 重试等待中那一句：「第 N 次重试，约 X 秒后」。
 *
 * 首次尝试（`attempt === 0`）时没有这一句 —— 那时候没有「还要等多久」这回事，`nextRetryInMs`
 * 也不存在（见 shared 的 `ConnectionState`）。秒数向上取整：1 秒的等待不该显示成「约 0 秒后」。
 */
const retryText = computed(() => {
  const current = connectionStore.state;
  if (!current || current.status !== "connecting") return "";
  if (current.attempt <= 0) return "";
  const seconds = Math.ceil((current.nextRetryInMs ?? 0) / 1000);
  return `第 ${current.attempt} 次重试，约 ${seconds} 秒后`;
});

/** 去设置页：未连接时这是用户**唯一**的自救路径（改回本地 / 换一个地址都在那一屏） */
function goSettings() {
  uiStore.setView("settings");
}

/** 手动重试（重试策略本身在 main，这里只按一次按钮） */
async function retry() {
  try {
    await connectionStore.reconnect();
  } catch (err) {
    ElMessage.error(`重连失败：${err instanceof Error ? err.message : String(err)}`);
  }
}
</script>

<style lang="scss" scoped>
.status-view {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 8px 8px 8px;
}

.status-card {
  width: 100%;
  max-width: 460px;
  padding: 44px 40px;
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  background: var(--el-bg-color);
  border: 1px solid var(--el-border-color);
  border-radius: 8px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.06);
}

.loading-icon {
  margin-bottom: 16px;
  color: var(--el-color-primary);
}

// 自己写一份转圈，不依赖 Element Plus 内部类的名字（那不属于它的公开契约）
.spin {
  animation: status-spin 1.2s linear infinite;
}

@keyframes status-spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}

.headline {
  font-size: 16px;
  line-height: 1.6;
  color: var(--el-text-color-regular);
  margin: 0;

  strong {
    font-weight: 600;
    color: var(--el-text-color-primary);
    word-break: break-all;
  }
}

.detail {
  margin: 10px 0 0 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--el-text-color-secondary);
}

.error-alert {
  width: 100%;
  margin-top: 18px;
}

.actions {
  display: flex;
  gap: 8px;
  margin-top: 20px;
}
</style>
