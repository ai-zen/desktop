<template>
  <div class="chat-panel">
    <!-- 空状态：无会话 -->
    <div v-if="!activeConversationId" class="empty-state">
      <el-icon :size="48" color="var(--el-text-color-secondary)">
        <ChatDotRound />
      </el-icon>
      <p class="empty-title">选择一个对话开始</p>
      <p class="empty-desc">从左侧选择一个对话，或点击「新建对话」开始新的 AI 对话</p>
    </div>

    <!-- 对话区域 -->
    <template v-else>
      <!-- 头部：会话名 -->
      <div class="chat-header">
        <span class="chat-title">{{ conversationStore.activeConversation?.name }}</span>
      </div>

      <!-- Agent 栏目：主对话 + 当前这一轮的各子 Agent。
           位置在会话标题下方、消息列表上方 —— 它切换的就是紧跟着的那块消息列表，
           所以要紧贴被它控制的那块区域（TUI 放在列表下方，是因为它的输入框在底部）。
           没有子 Agent 时整条栏目不存在（主对话就是全部），连高度也不占。 -->
      <div v-if="agentTabs.length > 0" class="agent-tabs">
        <span
          v-for="tab in agentTabs"
          :key="tab.id"
          class="agent-tab"
          :class="{ 'is-active': tab.id === chatStore.activeAgentId }"
          @click="chatStore.selectAgent(activeConversationId, tab.id)"
        >
          <!-- 状态圆点只给子 Agent：主对话忙不忙由输入区的停止按钮表示（与 TUI 同一取舍） -->
          <span v-if="tab.status" class="status-dot" :class="`is-${tab.status}`"></span>
          {{ tab.label }}
        </span>
      </div>

      <!-- 消息列表（QQ/微信式：DOM 常驻 + 首屏最近 N 条 + 上翻分页加载历史）
           items 带稳定 key（= 消息 id），prepend 更早消息时已有消息 key 不变
           → DOM 常驻，折叠状态天然保持；
           分页窗口内的消息全部完整渲染（不惰性），滚动不触发渲染 → 无高度抖动 -->
      <div
        class="messages"
        ref="messagesRef"
        @scroll="onScroll"
      >
        <!-- 上翻加载历史提示（v-show：DOM 常驻，仅切换 display，保持子节点顺序稳定） -->
        <div v-show="hasOlder" class="load-older-hint">
          <span>{{ loadingOlder ? "正在加载更早消息…" : "上翻加载更早消息" }}</span>
        </div>

        <MessageBubble
          v-for="msg in items"
          :key="msg.id"
          :message="msg"
          @retry="chatStore.retry"
        />

        <!-- 正在生成标识（v-show：DOM 常驻，仅切换 display，保持子节点顺序稳定）。
             只在主对话视图显示：子 Agent 的忙碌由它标签上的圆点表示（与 TUI 同一取舍） -->
        <div v-show="chatStore.streaming && !chatStore.activeAgentId" class="streaming-hint">
          <span class="dot"></span>
          正在思考...
        </div>
      </div>

      <!-- 输入区域（模型切换在输入框上方工具栏） -->
      <div class="input-area">
        <div class="input-toolbar">
          <el-select
            :model-value="currentModelId"
            size="small"
            class="model-select"
            @change="handleModelChange"
          >
            <el-option
              v-for="m in uiStore.models"
              :key="m.id"
              :label="m.name"
              :value="m.id"
            />
          </el-select>
        </div>
        <el-input
          v-model="inputText"
          type="textarea"
          :rows="3"
          placeholder="输入消息... (Enter 发送, Shift+Enter 换行)"
          :disabled="chatStore.streaming"
          @keydown="onInputKeydown"
          resize="none"
          class="chat-input"
        />
        <div class="input-footer">
          <span class="hint">Enter 发送 · Shift+Enter 换行</span>
          <el-button
            v-if="chatStore.streaming"
            type="danger"
            plain
            :icon="VideoPause"
            @click="handleStop"
          >
            停止
          </el-button>
          <el-button
            v-else
            type="primary"
            :icon="Promotion"
            :disabled="!inputText.trim()"
            @click="handleSend"
          >
            发送
          </el-button>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from "vue";
import { ChatDotRound, Promotion, VideoPause } from "@element-plus/icons-vue";
import type { SubAgentView } from "@ai-zen/desktop-shared";
import MessageBubble from "./MessageBubble.vue";
import { useUiStore } from "../../stores/ui.js";
import { useWorkspaceStore } from "../../stores/workspace.js";
import { useConversationStore } from "../../stores/conversation.js";
import { useChatStore } from "../../stores/chat.js";
import { MAIN_AGENT_VIEW_ID, nextAgentViewId } from "../../stores/agentView.js";
import { useMessageWindow } from "../../composables/useMessageWindow.js";
import { useAutoScroll } from "../../composables/useAutoScroll.js";

// ==================== QQ/微信式渲染参数 ====================
/** 首屏加载条数（底部开始，加载最近 N 条） */
const INITIAL_LOAD = 20;
/** 上翻历史每次加载条数 */
const PAGE_SIZE = 20;
/** DOM 常驻上限（超出丢最旧，控制 DOM 数量） */
const MAX_LOADED = 200;
/** 距顶部多少 px 触发加载更早历史 */
const LOAD_OLDER_TOP = 120;

const uiStore = useUiStore();
const workspaceStore = useWorkspaceStore();
const conversationStore = useConversationStore();
const chatStore = useChatStore();

const inputText = ref("");
const messagesRef = ref<HTMLElement | null>(null);
const scroller = () => messagesRef.value;

const activeConversationId = computed(() => conversationStore.activeConversationId);

const currentModelId = computed(() => {
  // 当前会话的 modelId（summary 上有）。取不到就空着 —— 模型解析是服务端的三级链
  // （会话级覆盖 > Agent 定义 > 全局默认），客户端没有第四档：拿「配置里第一个模型」
  // 顶上去，等于把「这段会话在用什么」换成一个没人验证过的猜测
  return conversationStore.activeConversation?.modelId ?? "";
});

/**
 * 消息列表当前显示的那一份：主对话或选中的子 Agent。
 *
 * 只认 store 的 `viewMessages`（唯一判据）：下面的渲染窗口、滚动、打字机跟随等每一个
 * watch 都读它，判断散在多处迟会有一处漏改。
 */
const viewMessages = computed(() => chatStore.viewMessages);

/** 一个栏目标签 */
interface AgentTabItem {
  /** `""` = 主对话，否则是子 Agent id（与 store 的 `activeAgentId` 同一口径） */
  id: string;
  label: string;
  /** 缺省 = 不画圆点（主对话） */
  status?: SubAgentView["status"];
}

/**
 * 栏目条目：主对话 + 各子 Agent。
 *
 * 标签文字直接印服务端给的 `index`，本地不数 —— 切到某个子 Agent、或中途接上连接时
 * 本地都没数过它，自己数就一定对不上。没有子 Agent 时返回空数组 = 栏目不存在（主对话就是全部）。
 */
const agentTabs = computed<AgentTabItem[]>(() => {
  if (chatStore.agents.length === 0) return [];
  return [
    { id: MAIN_AGENT_VIEW_ID, label: "主对话" },
    ...chatStore.agents.map((agent) => ({
      id: agent.id,
      label: `子AGENT${agent.index}`,
      status: agent.status,
    })),
  ];
});

// ==================== 渲染窗口 / 滚底策略（由 composables 提供） ====================
const { items, hasOlder, loadingOlder, resetToTail, loadOlder } =
  useMessageWindow(() => viewMessages.value, scroller, {
    initialLoad: INITIAL_LOAD,
    pageSize: PAGE_SIZE,
    maxLoaded: MAX_LOADED,
  });

const { scrollToBottom, alignToBottom, followIfNearBottom } = useAutoScroll(scroller);

// ==================== 时序：会话初始化 ====================
// initializing 表示「等待当前会话首帧消息」：消息数组被替换（getChatState 返回）
// 前保持该状态；空数组 = 仍在加载，等待下一次替换。
let initializing = false;

/** 完成初始化：窗口对齐最近 INITIAL_LOAD 条 + 滚底 */
function finalizeInitialization() {
  if (!initializing || viewMessages.value.length === 0) return;
  initializing = false;
  resetToTail();
  alignToBottom(); // markdown/代码块异步渲染高度延迟稳定，多次延迟滚底对齐真底
}

/** 开始一次会话初始化：消息已就绪立即完成，否则等 messages watch 消费 */
function beginConversation() {
  initializing = true;
  // 新会话默认关注底部，清除上翻状态
  userScrollingUp = false;
  if (scrollUpResetTimer) {
    clearTimeout(scrollUpResetTimer);
    scrollUpResetTimer = 0;
  }
  lastScrollTop = 0;
  resetToTail(); // 立即对齐（即使空数组也安全），消息到达后再对齐一次
  finalizeInitialization();
}

watch(activeConversationId, () => beginConversation());

// ==================== 时序：切换查看的 Agent ====================
// 渲染窗口（loadedStart）与 scrollTop 都是**上一个视图**的量：窗口起点指向旧数组的第 n 条，
// 滚动位置也停在旧内容处。切过去不重置，子 Agent 那几条会被窗口切掉、或视口停在空处，
// 看起来就像「这个子 Agent 什么都没说」。所以切视图 = 窗口对齐新视图尾部 + 滚到底。
// 也包括「选中项失效退回主对话」那条（store 修正 activeAgentId 后这里同样触发）。
watch(
  () => chatStore.activeAgentId,
  () => {
    resetToTail();
    alignToBottom();
  },
);

// ==================== 用户上翻：暂停自动滚底 ====================
// 用户主动向上滚动（上翻历史）后一段时间内，流式增量 / done 替换消息数组
// 触发的 followIfNearBottom 不执行 —— 避免「底部附近滚两下就被拽回底部」。
let userScrollingUp = false;
let scrollUpResetTimer = 0;
let lastScrollTop = 0;

// 消息数组引用替换（activate 首载 / done 完成 / 子 Agent 栏目整份替换）：
// - initializing（切会话首载）→ finalizeInitialization()
// - 已完成初始化（done 替换）→ 若在底部附近重新对齐（用户上翻中则跳过）
watch(
  () => viewMessages.value,
  (msgs) => {
    if (initializing) {
      if (msgs.length === 0) return; // 仍在加载（槽位未填充），保持 initializing
      finalizeInitialization();
    } else if (!userScrollingUp) {
      followIfNearBottom();
    }
  },
);

// 消息条数变化（user 事件 push / 流式 append）：追加时仅在底部附近跟随滚底
watch(
  () => viewMessages.value.length,
  () => {
    if (!initializing && !userScrollingUp) followIfNearBottom();
  },
);

// 流式增量：最后一条 content 变长时，若在底部附近则跟随（打字机滚底）
watch(
  () => {
    const last = viewMessages.value.at(-1);
    return typeof last?.content === "string" ? last.content.length : 0;
  },
  () => {
    if (!userScrollingUp) followIfNearBottom();
  },
);

// 流式结束（done 替换消息数组、高度变化）：若在底部附近重新对齐
watch(
  () => chatStore.streaming,
  (s) => {
    if (!s && !userScrollingUp) followIfNearBottom();
  },
);

// ==================== 滚动处理：上翻加载历史 + 用户上翻检测 ====================
function onScroll() {
  const el = scroller();
  if (el) {
    // 检测主动上翻：scrollTop 减小（loadOlder 补偿是增大，不会误判）
    if (el.scrollTop < lastScrollTop - 2) {
      userScrollingUp = true;
      if (scrollUpResetTimer) clearTimeout(scrollUpResetTimer);
      scrollUpResetTimer = window.setTimeout(() => {
        userScrollingUp = false;
        scrollUpResetTimer = 0;
      }, 2000);
    }
    lastScrollTop = el.scrollTop;
  }
  if (el && el.scrollTop < LOAD_OLDER_TOP) {
    void loadOlder(); // 内部处理 loadingOlder 防重入 + scrollTop 补偿
  }
}

// ==================== 发送 / 模型 ====================
async function handleModelChange(modelId: string) {
  const wsId = workspaceStore.activeWorkspaceId;
  const convId = conversationStore.activeConversationId;
  if (!wsId || !convId) return;
  await conversationStore.setModel(wsId, convId, modelId);
}

async function handleSend() {
  const text = inputText.value.trim();
  if (!text) return;
  inputText.value = "";
  // 发送 = 用户回到关注底部，清除上翻状态（否则流式增量不会滚底）
  userScrollingUp = false;
  if (scrollUpResetTimer) {
    clearTimeout(scrollUpResetTimer);
    scrollUpResetTimer = 0;
  }
  await chatStore.send(text);
  scrollToBottom();
}

/** 停止生成：main 对运行中 agent 调 abort，保留已生成部分，done 事件结束流式态 */
async function handleStop() {
  await chatStore.abort();
}

function onInputKeydown(e: KeyboardEvent) {
  if (e.key === "Tab") {
    handleTabKey(e);
    return;
  }
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    handleSend();
  }
}

/**
 * Agent 栏目切换：输入框为空时的 `Tab` 在「主对话 → 子1 → 子2 → … → 主对话」之间循环。
 *
 * 为什么只在输入框为空时才拦：有文字时 Tab 是浏览器的焦点导航，也是键盘用户离开输入框的
 * 唯一通道 —— 为了切栏目把它吞掉，就等于把这块区域封死。有文字时一个键都不碰，交回默认行为。
 *
 * 为什么必须 `preventDefault`：textarea 里 Tab 的默认行为是把焦点移走，不拦的话按下 Tab
 * 焦点就跑了，循环切换看上去只生效一次。
 *
 * 为什么没有子 Agent 时也不拦：那时栏目根本不存在，Tab 没有任何可切的东西。
 */
function handleTabKey(e: KeyboardEvent) {
  if (inputText.value.length > 0) return;
  if (agentTabs.value.length === 0) return;
  e.preventDefault();
  chatStore.selectAgent(
    activeConversationId.value,
    nextAgentViewId(chatStore.agents, chatStore.activeAgentId),
  );
}

onMounted(() => {
  if (!uiStore.models.length) {
    void uiStore.loadOptions();
  }
  // 应用启动即恢复会话：挂载时会话可能已激活且消息已就绪，
  // watch(activeConversationId) 不会触发（id 未变化），需手动补齐初始化。
  if (activeConversationId.value) beginConversation();
});
</script>

<style lang="scss" scoped>
.chat-panel {
  flex: 1;
  display: flex;
  flex-direction: column;
  height: 100%;
  background-color: var(--el-bg-color-page);
  border: 1px solid var(--el-border-color);
  border-radius: 8px;
  overflow: hidden;
}

// ==================== 空状态 ====================
.empty-state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: var(--el-text-color-secondary);

  .empty-title {
    font-size: 18px;
    font-weight: 600;
    margin: 0;
  }

  .empty-desc {
    font-size: 14px;
    margin: 0;
    max-width: 300px;
    text-align: center;
    line-height: 1.6;
  }
}

// ==================== 头部 ====================
.chat-header {
  display: flex;
  align-items: center;
  padding: 10px 16px;
  border-bottom: 1px solid var(--el-border-color);
  background-color: var(--el-bg-color);

  .chat-title {
    font-size: 15px;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}

// ==================== Agent 栏目（主对话 / 子 Agent 切换） ====================
.agent-tabs {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--el-border-color);
  background-color: var(--el-bg-color);
}

.agent-tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 10px;
  border-radius: 6px;
  font-size: 13px;
  color: var(--el-text-color-secondary);
  cursor: pointer;
  user-select: none;

  // 高亮规则只有一条：活动项 = 深色背景 + 加粗；非活动项**没有背景**（否则整条都像被选中）
  &.is-active {
    background-color: var(--el-fill-color-dark);
    font-weight: 600;
    color: var(--el-text-color-primary);
  }

  // 状态圆点：三种状态同形不同色（运行中蓝 / 完成绿 / 失败红），不新增图标库
  .status-dot {
    flex: none;
    width: 7px;
    height: 7px;
    border-radius: 50%;

    &.is-running {
      background-color: var(--el-color-primary);
    }

    &.is-done {
      background-color: var(--el-color-success);
    }

    &.is-failed {
      background-color: var(--el-color-danger);
    }
  }
}

// ==================== 消息列表（普通 flex 布局，DOM 常驻） ====================
.messages {
  flex: 1;
  overflow-y: auto;
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  position: relative;
  // 禁用浏览器滚动锚定：消息增量/渲染变化时锚定会擅自调整 scrollTop，
  // 滚动位置由我们自己的 loadOlder 补偿逻辑管理。
  overflow-anchor: none;
}

.load-older-hint {
  align-self: center;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  padding: 4px 0;
}

.streaming-hint {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  align-self: flex-start;
  font-size: 13px;
  color: var(--el-text-color-secondary);

  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--el-color-primary);
    animation: blink 1.2s infinite;
  }
}

@keyframes blink {
  0%, 100% { opacity: 0.2; }
  50% { opacity: 1; }
}

// ==================== 输入区域 ====================
.input-area {
  padding: 10px 20px 16px;
  border-top: 1px solid var(--el-border-color);
  background-color: var(--el-bg-color);
}

// ==================== 输入框上方工具栏（模型切换） ====================
.input-toolbar {
  display: flex;
  align-items: center;
  margin-bottom: 10px;

  .model-select {
    width: 180px;
  }
}

.chat-input {
  :deep(.el-textarea__inner) {
    background-color: var(--el-fill-color);
    border-color: var(--el-border-color);
    border-radius: 8px;
    padding: 12px 16px;
    font-size: 14px;
    line-height: 1.6;
    transition: border-color 0.2s;

    &:focus {
      border-color: var(--el-color-primary);
    }
  }
}

.input-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 8px;

  .hint {
    font-size: 12px;
    color: var(--el-text-color-secondary);
  }
}
</style>
