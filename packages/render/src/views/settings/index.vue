<template>
  <div class="settings-view">
    <div class="settings-card">
      <div class="settings-header">
        <h2 class="title">设置</h2>
        <el-button text :icon="Back" @click="goBack">返回</el-button>
      </div>

      <el-form label-width="110px" class="settings-form" @submit.prevent>
        <!--
          服务端连接：这一节**自带按钮**，与页面底部那个「保存」分开。
          底部那个保存是把「默认模型 / 默认 Agent / API Key」写给**服务端**（连的还是同一台）；
          而连接配置一保存，main 会立刻 dispose 旧连接、按新配置重建（D18）—— 两者混在同一个
          按钮里，用户只是想改默认模型，点一下「保存」却连到另一台机器上去了。
        -->
        <el-divider content-position="left">服务端连接</el-divider>

        <el-form-item label="连接方式">
          <el-radio-group v-model="connection.mode" @change="onModeChange">
            <el-radio value="local">本地</el-radio>
            <el-radio value="remote">远程</el-radio>
          </el-radio-group>
        </el-form-item>

        <!--
          仅远程才有地址与凭证。切回本地时，这两个输入框的内容只是**留在表单副本里**（还没保存，
          方便反悔）；但一旦点了「保存并重连」，本地模式会把远端地址与凭证从盘上清掉（见
          `connectionPayload()`）—— 重新打开面板读回来的就是空的，要再连那台得再填一次。
        -->
        <template v-if="isRemote">
          <el-form-item label="地址">
            <el-input
              v-model="connection.serverUrl"
              class="wide"
              :placeholder="urlPlaceholder"
            />
          </el-form-item>

          <el-form-item label="凭证">
            <!-- D22：与下面的 API Key 同一做法 —— 密码框，用户能点开看/粘贴 -->
            <el-input
              v-model="connection.serverToken"
              class="wide"
              type="password"
              show-password
              :placeholder="tokenPlaceholder"
            />
          </el-form-item>
        </template>

        <p class="connection-hint">
          本地 = 连本机常驻服务端（按发现文件找地址 + 用本机凭证）；远程 = 只连上面填的这个地址，
          <strong>不会</strong>在本机拉起服务端。远程模式下看到的会话 / 工作区都属于那台机器。
        </p>

        <div class="connection-actions">
          <el-button
            :loading="connectionStore.testing"
            :disabled="!isRemote"
            @click="testConnection"
          >
            测试连接
          </el-button>
          <el-button
            type="primary"
            :loading="connectionStore.saving"
            @click="saveConnection"
          >
            保存并重连
          </el-button>
        </div>

        <!-- 探测结果就地显示：成功是服务端自报的三件事实，失败是客户端翻好的人话 -->
        <el-alert
          v-if="probeText"
          class="connection-probe"
          :type="connectionStore.probe?.ok ? 'success' : 'error'"
          :title="probeText"
          :closable="false"
          show-icon
        />

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
import { ref, reactive, computed, onMounted } from "vue";
import { Back } from "@element-plus/icons-vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { useUiStore } from "../../stores/ui.js";
import { useConnectionStore } from "../../stores/connection.js";
import * as api from "../../apis/index.js";
import type { ConfigSettings, ConnectionSettings } from "@ai-zen/desktop-shared";

const uiStore = useUiStore();
const connectionStore = useConnectionStore();
const saving = ref(false);

const form = reactive<ConfigSettings>({
  endpoints: [],
  defaultModel: "",
  defaultAgent: "",
  dataDir: "",
});

// ---------- 服务端连接（本地 / 远程） ----------

const urlPlaceholder = "wss://example.com/ai-zen";
const tokenPlaceholder = "留空则用本机 <AI_ZEN_DIR>/run/token";

/**
 * 表单里的连接配置是**本地副本**（不直接绑 store 的 `settings`）。
 *
 * 绑 store 的后果是「没保存却看起来已经生效」：单选一换，面板上就已经是远程了，而 main 那边
 * 还连着本地。副本 + 自己的按钮，「已生效」与「正在编辑」两件事才分得开。
 */
const connection = reactive<ConnectionSettings>({
  mode: "local",
  serverUrl: "",
  serverToken: "",
});

const isRemote = computed(() => connection.mode === "remote");

/** 探测结果的一句话：成功拼服务端自报的三件事实，失败直接用客户端翻好的人话（D19） */
const probeText = computed(() => {
  const probe = connectionStore.probe;
  if (!probe) return "";
  return probe.ok
    ? `已连接：protocol ${probe.protocol} · ${probe.version} · ${probe.elapsedMs}ms`
    : probe.message;
});

/** 把 main 上已生效的配置灌进本地副本（面板打开时、点「恢复」时） */
async function loadConnection() {
  await connectionStore.load();
  const settings = connectionStore.settings;
  connection.mode = settings.mode;
  connection.serverUrl = settings.serverUrl ?? "";
  connection.serverToken = settings.serverToken ?? "";
}

/**
 * 切到本地时清掉探测结果：那句话说的是某个远程地址能不能连，与本地无关了。
 *
 * 两个输入框的内容**保留**在表单副本里（只是不再渲染），但那只是**保存前**的状态：点了
 * 「保存并重连」之后，本地模式会把远端地址与凭证从盘上清掉（见 `connectionPayload()`），
 * 下次打开面板 `loadConnection()` 读回来的就是空的。别把「副本里还留着」当成「盘上也留着」。
 */
function onModeChange() {
  if (!isRemote.value) connectionStore.resetProbe();
}

/**
 * 远程模式的候选值（试连与保存同一口径）。
 *
 * 空字符串一律变成「不给这个字段」（D17）：传给客户端空串等于「显式给了一个空值」，
 * 它就不会退回发现文件 / 本机 `run/token` 了。凭证留空 = 用本机
 * `<AI_ZEN_DIR>/run/token`（D9 明文支持的路径），所以那时整个字段不传。
 */
function remoteCandidate(): { serverUrl: string; serverToken?: string } {
  const serverUrl = connection.serverUrl?.trim() ?? "";
  const serverToken = connection.serverToken?.trim() ?? "";
  return serverToken ? { serverUrl, serverToken } : { serverUrl };
}

/**
 * 要交给 main 的那份配置。
 *
 * `local` 下**只发 `{ mode: "local" }`**：不带 `serverUrl` / `serverToken`。而 main 落盘是
 * **整份替换、不是合并**，所以这两个字段就此从盘上消失 —— 这是**有意的**：切到本地意味着
 * 不再用那台远程机，没必要把凭证留在盘上（`0600` 也只是同用户可读）。要再连那台，重新填一次
 * 地址与凭证即可。切回本地时输入框里还看得见它们 —— 那只是**保存前**的表单副本，盘上那份是被\n * 清掉的。
 */
function connectionPayload(): ConnectionSettings {
  return isRemote.value ? { mode: "remote", ...remoteCandidate() } : { mode: "local" };
}

/**
 * 远程模式下地址必填：本地先拦一句，不必让 main 回一句「地址非法」再转手。
 * 拦下来就**不发 IPC**（两个按钮都走这里）。
 */
function hasAddress(): boolean {
  if (!isRemote.value || connection.serverUrl?.trim()) return true;
  ElMessage.warning("请先填写服务端地址");
  return false;
}

/**
 * 测试连接：**不落盘、不影响当前连接**（D19）——连的成不成都只写在 store 的 `probe` 上，
 * 界面上的会话 / 工作区 / Agent 一个都不动。
 */
async function testConnection() {
  if (!hasAddress()) return;
  try {
    await connectionStore.test(remoteCandidate());
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : String(err));
  }
}

/**
 * 保存并重连 —— 单独一条路径、单独的按钮（理由见模板里这一节开头的注释）。
 *
 * 远程模式下保存 = **换连接**：main 会立刻 dispose 旧连接、按新配置重建，进行中的回答会中断。
 * 所以先让用户确认一次；`local` 模式回到老路，没有这个代价，不必问。
 *
 * 成功之后**必须 `loadConnection()` 重读一遍**，这不是「刷一下」让界面显得勤快：main 落盘是
 * **整份替换**，切到本地时会把 `serverUrl` / `serverToken` 从盘上清掉（见 `connectionPayload()`），
 * 保存成远程时也可能对输入做了归一（例如去掉尾部空白）。不重读，`connection` 这份表单副本就
 * 还挂着旧地址与凭证 —— 界面上写着的东西，盘上已经没有了（这正是本面板最容易骗人的一种状态）。
 *
 * 同理，`connection` 之外、这一屏上半部分的那些字段（默认模型 / 默认 Agent / 各端点的 API Key /
 * 数据目录）也必须跟着重读一次 —— 它们是**另一台服务端的事实**，理由写在下面内层 `try` 里。
 *
 * 探测结果不必在这里清：`connectionStore.save()` 成功时已经把它置空（那句话描述的是**换之前**
 * 那条链路），`loadConnection()` 也不碰 `probe`。
 */
async function saveConnection() {
  if (!hasAddress()) return;
  const next = connectionPayload();

  if (next.mode === "remote") {
    try {
      await ElMessageBox.confirm(
        "保存后会立刻断开当前连接、连到这台服务端，进行中的回答会中断。确定保存？",
        "切换连接",
        { type: "warning", confirmButtonText: "保存并重连", cancelButtonText: "取消" },
      );
    } catch {
      return; // 用户取消：一个字段都不动
    }
  }

  try {
    await connectionStore.save(next);
    ElMessage.success("已保存，正在使用新的连接");
    try {
      // 保存已经生效了：重读失败只报「重读失败」，绝不能把这次保存说成失败
      await loadConnection();
      // 再 `reload()` 重读**这一屏上半部分**：`form.dataDir` / `form.defaultModel` /
      // `form.defaultAgent` / `form.endpoints`（含各端点的 API Key）。这些字段全都是
      // **那台服务端的事实** —— `dataDir` 是它盘上的路径，默认模型与 Agent 是它上面有哪几个，
      // 各端点的 API Key 是它那侧的配置。面板打开那一刻读来的那份快照属于**上一台**；
      // 换了服务端就是换了一整个世界，旧快照对新机器没有任何意义。
      //
      // 不重读不只是「显示上一台的旧值」这种显示问题：`dataDir` 那一栏还是 `readonly` 的，
      // 界面上写着上一台机器的数据目录，用户接着点底部那个「保存」，就会把上一台机器的
      // 默认模型 / Agent / API Key **写给新的那一台** —— 那是往盘上写错数据，不是看错东西。
      //
      // `local` 模式也照样重读：本机那台大概率没变，重读一遍无害（不过是再读一次配置），
      // 而且连接刚刚已经重建过一次（`connectionStore.save()`），读到的本来就是重建之后的那份。
      await reload();
    } catch (err) {
      ElMessage.error(
        `连接已保存，但重读配置失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : String(err));
  }
}

async function reload() {
  const cfg = await api.getConfigSettings();
  form.endpoints = cfg.endpoints;
  form.defaultModel = cfg.defaultModel;
  form.defaultAgent = cfg.defaultAgent;
  form.dataDir = cfg.dataDir;
  // 「恢复」也把连接配置恢复成 main 上那份（面板里未保存的改动一律丢弃）。
  // 单独包一层：`connection:get` 的约定是「读不到就回默认值、绢不抛错」（D17），
  // 万一那条通道本身出问题，也不该让「默认模型 / API Key」这一屏跟着加载不出来。
  try {
    await loadConnection();
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : String(err));
  }
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

// 连接这一节：说明文字与按钮都缩进到与输入框左边缘对齐（label-width 110px）
.connection-hint {
  margin: 0 0 12px;
  padding-left: 110px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--el-text-color-secondary);

  strong {
    font-weight: 600;
    color: var(--el-text-color-regular);
  }
}

.connection-actions {
  display: flex;
  gap: 8px;
  padding-left: 110px;
  margin-bottom: 12px;
}

.connection-probe {
  margin-bottom: 18px;
}
</style>
