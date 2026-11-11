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

        <!--
          以下这一节（默认模型 / 默认 Agent / API Key / 数据目录）全部是**服务端的事实**：
          它们走 `invokeService`，需要一条连着的服务端。窗口现在先出来、连接在后面
          （D25），所以面板可能是「连不上」的时候打开的 —— 那时这四样一个都读不到。

          读不到时：这一节**留空**（不弹红条，也不报错），只在这里挂**一条**说明。
          上面那一节「服务端连接」与这儿无关（它走 main 本地的 `connection:get`），一定照常可用。
        -->
        <el-alert
          v-if="serverUnavailable"
          class="settings-warning"
          type="info"
          title="未连接服务端，这一节的配置读不到；连上后会自动带出来"
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

        <!--
          盘上那个默认模型已经不在服务端的模型清单里（被删了 / 换了名字）：下拉框只会显示空白，
          而 main 的 `update()` 对空串是「不写」（服务端窄方法只收非空 id），点「保存」什么都不会
          改，盘上仍是那个旧 id。不说一声，「空白」就会被当成「已保存」。
        -->
        <el-alert
          v-if="modelNotice"
          class="settings-warning"
          type="warning"
          :title="modelNotice"
          :closable="false"
          show-icon
        />

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

        <!-- 同默认模型：Agent 那一份清单里没有这个 id，就是用户看到空白的原因 -->
        <el-alert
          v-if="agentNotice"
          class="settings-warning"
          type="warning"
          :title="agentNotice"
          :closable="false"
          show-icon
        />

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

        <!--
          一条汇总提示（不是每个端点一条）：哪些端点在服务端那一侧已经不存在 / 新加了出来。
          「不存在」的那几个，用户填在框里的 API Key 是**写不进去**的（main 按 id 匹配，匹配不上
          就 `continue`）—— 所以保存前先把这句话说出来，保存后 `reload()` 把表单拉回盘上的
          样子，这条提示跟着自然消失（它是 computed，不靠谁去清标记）。
        -->
        <el-alert
          v-if="endpointMismatchNotice"
          class="settings-warning"
          :type="staleEndpoints.length ? 'warning' : 'info'"
          :title="endpointMismatchNotice"
          :closable="false"
          show-icon
        />

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

/**
 * 服务端那一半（默认模型 / 默认 Agent / API Key / 数据目录）**读不到**。
 *
 * 它的唯一成因是「还没连上服务端」（窗口先出来、连接在后面，D25）：这时那几样一个都读不到，
 * 面板上留空 + 一条说明就好 —— 不是什么异常，所以既不弹红条也不打日志。
 * 一旦读到（`reload()` 成功）就自己落下，说明也跟着消失。
 */
const serverUnavailable = ref(false);

/**
 * 最近一次从服务端读到的端点 id 清单（`reload()` 刷、保存前那次只读探测也刷）。
 *
 * 它代表的不是「表单里有什么」，而是「服务端那一侧有什么」—— 两者一对就能看出面板开着的
 * 这段时间里，别的客户端（CLI / 另一台桌面端）动过哪些端点。只存 id：提示只需要名字和数量，
 * 比对只需要 id。
 */
const serverEndpointIds = ref<string[]>([]);

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

    // 保存已经生效，界面该回主界面：用户改完配置还停在设置页时，main 那边已经在等他。
    // 不管模式有没有变（本地 → 本地也算一次保存），只要保存成了就走这一句；
    // 它在保存失败走不到的位置（外层 `catch` 后面）。
    uiStore.setView("main");
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : String(err));
  }
}

/**
 * 默认模型「盘上那个还在不在」—— 这就是用户在框里看到空白的原因。
 *
 * 判据就是同一下拉框的选项来源（`uiStore.models`）：框里能出现的每一行都来自这份清单，
 * 所以「盘上的 id 不在这份清单里」= 框里必然空白。空串也是同一种事（服务端没有默认模型），
 * 而且空串**保存不上去**（main 那边 `if (input.defaultModel)` 直接跳过），所以要说明白。
 *
 * 清单为空时（`loadOptions()` 还没回来 / 失败）不下结论：那时我们根本不知道服务端有哪几个
 * 模型，说「已不存在」就是新的谎话。
 */
const modelNotice = computed(() => {
  // 未连接时这一节整个读不到（上面已经挂了一条说明），谈不上「已不存在」——
  // 再说一句「当前没有默认模型」就成了新的谎话（服务端上有没有，这会儿根本不知道）。
  if (serverUnavailable.value) return "";
  if (!form.defaultModel) return "当前没有默认模型，请先选一个（空值不会被保存）";
  if (!uiStore.models.length) return "";
  if (!uiStore.models.some((m) => m.id === form.defaultModel)) {
    return "当前默认模型已不存在，请重新选一个";
  }
  return "";
});

/** 同 `modelNotice`，只是对着 Agent 那一份清单说话 */
const agentNotice = computed(() => {
  if (serverUnavailable.value) return "";
  if (!form.defaultAgent) return "当前没有默认 Agent，请先选一个（空值不会被保存）";
  if (!uiStore.agents.length) return "";
  if (!uiStore.agents.some((a) => a.id === form.defaultAgent)) {
    return "当前默认 Agent 已不存在，请重新选一个";
  }
  return "";
});

/**
 * 表单里有、服务端最新那份清单里没有的端点 —— 它们已在别处被删掉。
 *
 * 这几个端点的 API Key 是**写不进去**的：main 的 `update()` 按 id 在服务端那份配置里找
 * 目标端点，找不到就 `continue`（有意为之：整份写回会把别人刚改的字段抹掉）。所以这些行里
 * 用户正在敲的字，得当场告诉他是写不进去的，而不是等他点完保存再假装已保存。
 */
const staleEndpoints = computed(() =>
  form.endpoints.filter((ep) => !serverEndpointIds.value.includes(ep.id)),
);

/** 服务端有、表单里没有的端点数（在别处新加的：不丢数据，但列表对不上） */
const serverOnlyCount = computed(
  () => serverEndpointIds.value.filter((id) => !form.endpoints.some((ep) => ep.id === id)).length,
);

/**
 * 端点列表与服务端对不上的**一条**汇总提示（不是每个端点一条）。
 *
 * 它是 computed：`reload()` 一跑，表单和服务端那份清单就从同一次读里来，这句话自己就没了 ——
 * 不需要谁去 `setFlag(false)`，也不会出现「提示还在、事实已经变了」。
 */
const endpointMismatchNotice = computed(() => {
  if (staleEndpoints.value.length) {
    const names = staleEndpoints.value.map((ep) => ep.name).join("、");
    const count = staleEndpoints.value.length;
    return `有 ${count} 个端点已在别处被删除（${names}），这些端点上的改动不会被保存`;
  }
  if (serverOnlyCount.value) {
    return `服务端有 ${serverOnlyCount.value} 个端点不在本页列表里，保存后会跟着刷新出来`;
  }
  return "";
});

async function reload() {
  try {
    const cfg = await api.getConfigSettings();
    form.endpoints = cfg.endpoints;
    // 「服务端那一侧」的端点清单只跟着这次读刷新：下面两条提示是拿表单跟它比出来的
    serverEndpointIds.value = cfg.endpoints.map((ep) => ep.id);
    form.defaultModel = cfg.defaultModel;
    form.defaultAgent = cfg.defaultAgent;
    form.dataDir = cfg.dataDir;
    serverUnavailable.value = false;
  } catch {
    // 未连接服务端：这一节**留空**（模板里那条说明靠这个标记出现）。
    // **不弹红条、不打日志**：这不是故障，是「还没连上」这件正常的事。
    //
    // 清空而不是「原样留着」：如果是面板开着时连接断了，框里会留着上一台的值 ——
    // 框里有值、盘上却读不到，人就会把那当成当前配置（本面板最不能犯的错）。
    serverUnavailable.value = true;
    form.endpoints = [];
    serverEndpointIds.value = [];
    form.defaultModel = "";
    form.defaultAgent = "";
    form.dataDir = "";
  }

  // 下面这一段与上面那半部分**完全无关**：它读 `connection:get`，走 main 本地，不需要服务端。
  // 所以上面读不到也必须照常执行 —— 「服务端连接」是用户改回本地 / 换地址的唯一入口，
  // 绝不能被「服务端那半部分读不到」连累（被连累的后果就是他没地方自救了）。
  //
  // 「恢复」也把连接配置恢复成 main 上那份（面板里未保存的改动一律丢弃）。
  // 单独包一层：`connection:get` 的约定是「读不到就回默认值、绢不抛错」（D17），
  // 万一那条通道本身出问题，也不该让「默认模型 / API Key」这一屏跟着加载不出来。
  try {
    await loadConnection();
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : String(err));
  }
}

/**
 * 保存（页面底部那个按钮）：只发默认模型 / 默认 Agent / 各端点的 API Key。
 *
 * 这个按钮最容易骗人的地方在 main 的 `ServerConfigService.update()`：它有两处**静默丢弃** ——
 *   1. 空串不写（`if (input.defaultModel)` / `if (input.defaultAgent)`）：服务端的窄方法
 *      只收非空 id（空串是 `bad-params`）。于是「盘上那个模型已被删除 → 下拉框空白 → 点保存」
 *      什么都不会写，盘上仍是那个旧 id；
 *   2. 端点按 id 匹配（`if (!target) continue`）：面板开着期间被 CLI 等外部删掉的端点，
 *      用户在那个已消失端点的框里改的 apiKey 直接丢掉。
 *
 * 两处语义都是**有意**的（窄方法只接受非空 id；整份写回会抹掉对方刚改的字段），不在这里改，
 * 也不改发给 main 的数据形状。界面能做的是**说实话**：保存之后重新读一遍盘上的事实。
 *
 * 不重读就会让「静默丢弃」变成「界面**说谎**」—— 用户看到的是自己想填的值（空白的新模型、
 * 在已删端点上敲的 Key），盘上是另一个值（旧 id、根本没有这个端点），而且只有点「恢复」
 * 才看得出差别。
 */
async function save() {
  saving.value = true;
  try {
    // 保存前先只读地看一眼服务端**此刻**的端点清单：这一屏是面板打开那一刻的快照，开着的
    // 这段时间里别的客户端可能已经删掉 / 加过端点。读不到不要紧（就不比），不能因此让保存失败。
    try {
      const latest = await api.getConfigSettings();
      serverEndpointIds.value = latest.endpoints.map((ep) => ep.id);
    } catch {
      // 一次只读探测的失败不是保存的失败：下面的写入照常进行
    }
    // 说在写之前：这几个端点的改动马上就会被 main 丢掉，等 `reload()` 把表单拉回盘上的样子，
    // 那条提示（computed）就跟着消失了 —— 所以要在这里弹一次，用户才真的读到它。
    if (endpointMismatchNotice.value) ElMessage.warning(endpointMismatchNotice.value);

    await api.updateConfigSettings({
      defaultModel: form.defaultModel,
      defaultAgent: form.defaultAgent,
      endpoints: form.endpoints,
    });

    ElMessage.success("设置已保存");
    try {
      // 保存已经生效了：下面两行只是把界面拉回盘上的事实，重读失败只报「重读失败」，
      // 绝不能把这次保存说成失败。
      //
      // 先 `loadOptions()`：`modelNotice` / `agentNotice` 是拿 `uiStore.models` / `agents`
      // 的 id 清单判断「盘上那个默认值还在不在」的。模型刚被删掉时，清单不刷新，那条提示
      // 就只能停在「不知道」上——而这正是最需要它开口的时刻。
      await uiStore.loadOptions();
      // 再 `reload()`：把默认模型 / Agent / 各端点（含 apiKey）按盘上那份重新灌进表单。
      // 于是「框里空着」不再是「保存后的样子」，而是「服务端上没有这个模型」；已删端点的那一行
      // 当场消失，也不会留着用户填的字装成已保存。
      await reload();
    } catch (err) {
      ElMessage.error(
        `已保存，但重读配置失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
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
  // 这两件都经过服务端，未连接时会抛（窗口先出来、连接在后面，D25）。
  // 不弹红条、也不该冒到控制台：那是「还没连上」这件正常的事，界面照常显示，
  // 服务端那一半留空（见模板里那条说明）；下面那一节「服务端连接」照常可用。
  if (!uiStore.models.length) {
    try {
      await uiStore.loadOptions();
    } catch {
      // 未连接：模型 / Agent 清单留空（下拉框空着，比弹一条红字诚实）
    }
  }
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

// 表单里的提示条（默认模型 / 默认 Agent 已不存在、端点与服务端对不上）：与输入框同宽
.settings-warning {
  margin-bottom: 18px;
}
</style>
