<template>
  <div class="app-wrapper">
    <TitleBar />

    <!--
      优先级 1：设置页。**未连接也必须能进** —— 它是用户唯一的自救路径（改回本地 / 换地址），
      所以它排在「连接就绪」这一关之前。
    -->
    <SettingsView v-if="uiStore.currentView === 'settings'" />
    <!--
      优先级 2：**还没配过**（`unset`）→ 首启引导屏。

      它必须排在连接状态屏之前：那边说的是「正在连 / 连不上」，而这里连一个目标都还没有
      —— 摆一块只有「重试」按钮的屏，重试的对象根本不存在。
    -->
    <SetupView v-else-if="connectionStore.isUnset" />
    <!-- 优先级 3：连接还没 ready（还没查到 / 正在连 / 连不上）→ 整屏交给连接状态屏 -->
    <StatusView v-else-if="!connectionStore.isReady" />
    <GuideView v-else-if="uiStore.currentView === 'guide'" />
    <MainView v-else />
  </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, watch } from "vue";
import { ElMessage } from "element-plus";
import TitleBar from "./components/TitleBar.vue";
import GuideView from "./views/guide/index.vue";
import MainView from "./views/main/index.vue";
import SettingsView from "./views/settings/index.vue";
import SetupView from "./views/setup/index.vue";
import StatusView from "./views/status/index.vue";
import { onChatPush } from "./apis/chat.js";
import { getConfigSettings } from "./apis/config.js";
import { useUiStore } from "./stores/ui.js";
import { useWorkspaceStore } from "./stores/workspace.js";
import { useChatStore } from "./stores/chat.js";
import { useConnectionStore } from "./stores/connection.js";

const uiStore = useUiStore();
const workspaceStore = useWorkspaceStore();
const chatStore = useChatStore();
const connectionStore = useConnectionStore();

let unsubscribe: (() => void) | null = null;
let unsubscribeState: (() => void) | null = null;
/** 组件已经卸载：`startWatching()` 还在飞时先记下来，落地后立刻退订（别留一条没人管的监听） */
let disposed = false;
/**
 * 「这一轮 ready 已经初始化过了」的哨兵。
 *
 * 状态推送不只意味着「连上了」：`connecting(N)` 每到一次重试都会推一条，`error` 也一样。
 * 没有这个哨兵，`watch` 里的 `init()` 会在 ready 期间被反复触发，每次都把 Agent / 模型 /
 * 工作区列表重拉一遍（还会把用户切到别的界面）。
 */
let initialized = false;

/** 统一的 chat:push 处理器 → chat store（单通道收敛） */
const onChatPushHandler = (
  evt: Parameters<typeof chatStore.applyEvent>[0],
) => {
  chatStore.applyEvent(evt);
};

/**
 * 连接 ready 之后才该跑的那些事：拉 Agent / 模型选项、拉工作区（含各工作区的会话），
 * 再按「有没有工作区」决定落到引导页还是主界面（用户正停在设置页时跳过这一步，见下面的守卫）。
 *
 * 这几句以前是 `onMounted` 里直接跑的，现在**必须等连接就绪**：窗口先出来、连接在后面
 * （D25），挂载那一刻这几句会撞在一条还没连上的连接上（一片空白且没有提示）。
 */
async function init(): Promise<void> {
  await uiStore.loadOptions();

  /**
   * 凭据门：服务端上**一个能用的 API Key 都没有** → 把用户送到设置页的「API Key」那一节。
   *
   * 为什么是「送到设置页」而不是另做一屏：那一节本来就是「选端点 + 填密钥」的完整界面
   * （含每个端点的注册链接与明文核对），再画一屏等于把同一件事实现两遍。这里只负责
   * **在那个该被看见的时刻把它推到用户眼前**，否则症状是「连上了、界面全在，一发消息就报
   * 没有 Key」—— 而报错的地方离要改的地方很远。
   *
   * 读不到配置（老服务端 / 通道出问题）就不拦：凭据缺失是一种**确定**的状态，猜不得。
   */
  const settingsConfig = await getConfigSettings().catch(() => null);
  const hasApiKey = settingsConfig?.endpoints.some((endpoint) => endpoint.apiKey?.trim()) ?? true;
  if (!hasApiKey) {
    ElMessage.warning("还没有填写 API Key：请在下方「API Key」一节里选一个服务，填入密钥");
    uiStore.setView("settings");
  }

  await workspaceStore.load();

  // 用户此刻正停在设置页自救（改回本地 / 换一个地址）：**这一句必须让给他**。
  // 上面两次 await 期间，后台那轮自动重试（1s / 2s / 5s）可能恰好连上了 —— 于是 init() 走到这里，
  // 把 currentView 改成 guide / main，人会毫无预兆地被从设置页弹回主界面：他明明还在改配置，
  // 这等于从他手里抢键盘。
  // 注意两件事：
  //   ① 判断读的是**此刻**的 currentView（放在 setView 前一句），不能在函数开头快照一次 ——
  //      loadOptions() / workspaceStore.load() 都是 await，中间用户完全可能已经切去设置页了；
  //   ② 只跳过 setView，**数据照常拉**（上面两句已经跑完）。反过来连数据一起跳过的话，
  //      用户改完配置点「返回」，会看到一个列表全空的主界面。
  if (uiStore.currentView !== "settings") {
    uiStore.setView(workspaceStore.workspaces.length === 0 ? "guide" : "main");
  }
}

/** 只在「变成 ready」的那一刻跑一次 `init()`，失败自己报（不冒成 unhandled rejection） */
async function initOnce(): Promise<void> {
  if (initialized) return;
  initialized = true;
  try {
    await init();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`[app] 初始化失败（连接已就绪，但数据没拉上来）：${reason}`);
    ElMessage.error(`初始化失败：${reason}`);
  }
}

onMounted(async () => {
  // chat:push 与连接状态无关：先挂上（保持原样），别漏掉连接建立之后的第一条事件
  unsubscribe = onChatPush(onChatPushHandler);

  // 状态屏需要知道「此刻是什么状态」：startWatching() 内部**先查一次、再订阅推送**
  try {
    const stop = await connectionStore.startWatching();
    if (disposed) {
      // 订阅落地前组件就没了：立刻退订，否则这条监听会活到进程结束
      stop();
      return;
    }
    unsubscribeState = stop;
  } catch (err) {
    // 查询自身失败（IPC 挂了这种）：不冒成 unhandled rejection，界面停在「正在读取连接配置…」
    console.error(`[app] 查询连接状态失败：${err instanceof Error ? err.message : String(err)}`);
  }
});

/**
 * 连接状态一变，界面就该跟着动：`false → true` 跑一次 `init()`。
 *
 * 离开 ready（断开 → `connecting` / `error`）时把哨兵放下：用户改完配置「重连」成功之后，
 * 数据是**另一台服务端**的，必须重拉一遍（`init()` 里那几句正是重拉）。
 */
watch(
  () => connectionStore.isReady,
  (ready) => {
    if (!ready) {
      initialized = false;
      return;
    }
    void initOnce();
  },
);

onUnmounted(() => {
  disposed = true;
  unsubscribe?.();
  unsubscribe = null;
  unsubscribeState?.();
  unsubscribeState = null;
});
</script>

<style lang="scss">
.app-wrapper {
  height: 100vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
</style>
