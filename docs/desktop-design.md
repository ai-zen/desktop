# Desktop 设计大纲（v0.5 定稿）

> 状态：**架构 + 关键决策 + 用户场景 + render 分层已定稿**。
> 开发策略：**UI 先行**——原型 = UI = 实际交互，main 按 UI 需求补齐。
> 前置：SDK 0.5.0 已移除会话/草稿产品层，Desktop 自建产品层。

---

## 1. 定位

- Desktop 是 Electron 桌面应用，消费 `@ai-zen/agents-sdk`（引擎）与 `@ai-zen/agents-core`（消息模型）。
- SDK 只管"驱动 + 能力"（Provider / Agent / 工具 / 插件）；Workspace、Conversation 是**产品数据**，Desktop 自己维护。
- 目标形态：多工作空间（每空间指向一个本地目录）、多会话并行、流式对话界面。

---

## 2. 分层骨架

```
render    Vue + Pinia 视图层（transport / stores / views / components）
shared    类型契约层（纯类型）       —— 实体 + IPC 事件 DTO
main      主进程宿主层（面向对象：类 + 构造注入）
  ├─ services/   应用服务类（ProviderPool / Workspace / Conversation / Chat）
  ├─ storage/    存储类（Workspace 仓储 / Conversation 仓储）
  ├─ events/     事件分发（接口 + Electron 实现）
  ├─ provider/   引擎交互封装类（ProviderFactory / AgentFactory）
  ├─ ipc/        IPC 注册类
  ├─ window/     窗口管理类
  ├─ container.ts  手动 DI 组装（new 全部，按依赖顺序）
  └─ main.ts       入口 boot
```

依赖方向：render → shared；main → shared + SDK；各层构造注入/依赖收敛，无全局单例、无散落调用。

---

## 3. 核心实体（概念）

- **Workspace**：`{ id, name, cwd }` —— 唯一持久化实体，存 `workspaces.json`。
- **Conversation**：`{ id, workspaceId, agentId, modelId, name, messages, 时间戳 }` —— 每 workspace 下多个会话，一文件一会话。
  - `modelId` 是**对话级局部参数**，覆盖 Agent 定义（优先级：对话 > Agent 定义 > 全局默认）。
- **消息模型**：直接沿用 Core 的 `AgentNS.Message`，不另造、不做 adapter；确需扩展用继承。
- **事件 DTO**：`chat:push { conversationId, type: start|delta|done|error, ... }` —— 单通道发布/订阅。

---

## 4. 设计决策（定稿）

### A. 架构决策

| # | 决策 | 理由 |
|---|------|------|
| A1 | Workspace 唯一持久化；**Provider 不落盘**，运行时 1:1 映射，**懒加载** | 避免双写；按需创建 |
| A2 | 每 workspace 一个 Provider（注入 `cwd`），**多会话并行**互不干扰 | 工具以 Provider.cwd 为基准 |
| A3 | 会话仓储复用 SDK `EntityRepository`，目录 `conversations/{wsId}/{id}.json` | 复用成熟 CRUD；目录隔离天然安全 |
| A4 | 删除 `conversations-index.json`，列表由仓储扫描派生 | 单一事实来源，无双写 |
| A5 | **preload 只是通信渠道（transport）**：`invoke/on/off` + 窗口四件套，零业务定义，可替换（未来 ws/http 也可） | 换传输不影响契约；preload 堆定义是反面 |
| A6 | 业务推送走 **EventDispatcher（pub/sub）**：ChatService 只管 emit，render 按需订阅 | 解耦窗口对象；多消费方直接订阅 |
| A7 | 消息模型**直接沿用 Core `AgentNS.Message`**，三层统一零转换 | 避免双模型割裂 |
| A8 | 恢复历史 `agent.messages = 历史`；`agent.send()` 后**全量快照**落盘，错误也落盘 | 单一事实来源；不手动构造用户消息 |

### B. 产品决策

| # | 决策 | 说明 |
|---|------|------|
| B1 | Provider 懒加载 | 用才建，可选 warmUp |
| B2 | main 依赖 SDK 用**线上 0.5.0** | 与 CLI 一致；开发期临时 link |
| B3 | **UI 先行**：从用户使用角度把 UI 完整开发为可交互原型，main 按 UI 需求补齐 | 原型 = UI = 实际交互 |
| B4 | 消息不预埋扩展字段 | YAGNI，用到再加 |
| B5 | 新建对话：按钮 + 下拉选 Agent；对话内切模型（对话级局部参数覆盖） | `agent.model = createModel(provider, conv.modelId)`，model 是 Core 可写字段，**无需改 SDK** |
| B6 | 事件单通道 `chat:push` + discriminated union | render 一个订阅函数收敛 |

### C. 工程原则（OO 但不过度抽象）

| # | 原则 | 说明 |
|---|------|------|
| C1 | **一切皆类 + 构造注入**，无全局单例 | 依赖关系显式，AI 读构造函数即知边界 |
| C2 | **不预埋抽象**：只有"确实存在多个实现 / 需要运行时替换 / 跨外部边界"才抽接口 | 拒绝 Java 式 interface/impl 双份膨胀 |
| C3 | **当前抽象**：main 侧 `IEventDispatcher`；render 侧 `Transport`（均因多实现：electron ↔ mock/ws） | 真实多实现边界 |
| C4 | 组合优先、单一职责；SDK 交互收拢到工厂类（ProviderFactory / AgentFactory） | 避免 SDK 调用散落 |
| C5 | `container.ts` 手动 DI 组装；render 的 `mock-transport` 可整体替换 | 无框架；换实现即可测/即可联调 |

### D. 场景决策

| # | 决策 | 说明 |
|---|------|------|
| D1 | **MVP 范围** = 11 个 P0 场景（见第 5 节） | 核心链路：启动→建空间→建对话→聊天→切换 |
| D2 | 首次启动显示**引导页**（无 workspace 时） | `GuideView`，创建后切主界面 |
| D3 | **记住上次活跃状态**（workspace + 会话），启动自动恢复 | 单独 UI 状态文件，不进 workspace 实体 |
| D4 | Agent 列表 = `~/.ai-zen/agents`（复用 SDK `AgentRepository`） | 单来源；sub-agent 多来源 SDK 已处理 |
| D5 | 模型列表 = 全局 `config.models`（复用 SDK `ConfigManager`） | 与 CLI 共享配置 |
| D6 | 流式**数据全量**，UI 折中：正文为主，**思考/工具调用折叠展开** | 数据拿全，渲染按需 |
| D7 | 错误后提供**重试**（同内容再 send） | 高频场景，体验好 |
| D8 | 多会话并行：**聚焦当前 + 侧栏运行中标记** | 后台会话完成时刷新其列表 |

---

## 5. 用户使用场景清单

### P0（MVP 核心链路）

| # | 场景 | 动作 → 界面表现 |
|---|------|-----------------|
| 1 | 首次启动引导 | 无 workspace → `GuideView`"创建第一个工作空间" |
| 2 | 启动恢复 | 加载列表，恢复上次活跃 workspace/会话 |
| 3 | 新建 workspace | 填名称 + 选目录 → 侧栏出现并激活 |
| 6 | 新建对话 | 按钮 + 右侧下拉选 Agent（默认预选）→ 进入对话 |
| 7 | 会话列表 | 名称/消息数/时间，按更新时间倒序；运行中标记 |
| 8 | 切换会话 | 加载历史消息 |
| 11 | 发送消息 | 用户消息上屏 → AI 流式回复 |
| 12 | 流式渲染 | 思考/正文/工具调用增量显示（思考与工具调用可折叠） |
| 13 | 发送中状态 | 输入可继续打字；回复中显示标识 |
| 15 | 错误反馈 | 明确提示 + 重试按钮；会话保留进展 |
| 18 | 窗口控制 | 无边框自绘标题栏（已有） |

### P1（增强）

| # | 场景 | 动作 → 界面表现 |
|---|------|-----------------|
| 4 | 重命名 workspace | 悬停/右键 → 重命名 |
| 5 | 删除 workspace | 确认后删除，连带删除其会话 |
| 9 | 删除会话 | 确认后删除 |
| 14 | 对话内切模型 | 对话头部选模型 → 后续消息生效 |
| 17 | 多 workspace 并行 | 各自 Provider，互不干扰；侧栏运行中标记 |
| 20 | **设置页** | `SettingsView`：API Key / 默认模型 / Agent 列表 / 数据目录 |

### P2（后置）

| # | 场景 |
|---|------|
| 10 | 重命名会话 |
| 16 | 清空对话 |
| 19 | 主题（亮/暗跟随系统） |

---

## 6. render 分层

```
render/src/
  transport/            # 通信层 —— 唯一抽象（mock ↔ electron 两个实现）
    transport.ts        #   Transport 接口：invoke(service,method,...args) / on / off
    electron-transport.ts   # Electron 实现（包 window.electronAPI）
    mock-transport.ts       # Mock 实现（UI 先行：内存数据 + 模拟流式推送）
    api.ts                  # 类型化 API：invoke 收敛成方法（从 UI 使用倒推契约）

  stores/               # 状态层 —— 唯一数据入口
    workspace.store.ts
    conversation.store.ts
    chat.store.ts
    ui.store.ts         #   页面切换（currentView）+ 引导状态

  views/                # 页面层 —— 每页一个目录，入口固定 index.vue，其余组件大驼峰
    guide/
      index.vue         # 引导页
    main/
      index.vue         # 主界面：组合 Sidebar + ChatPanel
      Sidebar.vue
      ChatPanel.vue
      MessageBubble.vue
      NewChatDialog.vue
      ModelSelect.vue
    settings/
      index.vue         # 设置页
      ApiKeyForm.vue

  components/           # 跨页共享组件（出现第二个使用方才提升，YAGNI）
    TitleBar.vue

  App.vue               # 根：按 uiStore.currentView 切换页面（v-if，不引 router）
  main.ts
  styles/
```

### render 分层原则

| 原则 | 落地 |
|------|------|
| 组件/页面不碰 transport | 只调 store 动作 / 读 store 状态 |
| store 是唯一数据入口 | store 内部调 api（类型化方法） |
| transport 收敛 invoke/on/off | 无散落 `invoke("workspace","list")` 字符串 |
| **mock 在 transport 层** | UI 先行用 mock-transport，真实 main 就绪切 electron-transport，UI 代码零改动 |
| 页面专属组件就近放页面目录 | 跨页共享才提升到 `components/` |
| 组件命名 | 页面入口 `index.vue`，其余**大驼峰**（PascalCase） |
| 页面切换 | `uiStore.currentView` + v-if（页面少，不引 router） |

---

## 7. main 分层（面向对象，不过度抽象）

```
main/src/
  services/    ProviderPool / WorkspaceService / ConversationService / ChatService
  storage/     WorkspaceRepository / ConversationRepository（复用 EntityRepository）
  events/      IEventDispatcher + ElectronEventDispatcher（唯一抽象）
  provider/    ProviderFactory / AgentFactory（SDK 交互收拢）
  ipc/         IpcRegistrar
  window/      WindowManager
  container.ts 手动 DI 组装
  main.ts      boot
```

模块职责一句话级：
- **ProviderPool**：workspaceId → Provider 的 1:1 映射 + 懒加载生命周期。
- **WorkspaceService**：workspace CRUD，组合 ProviderPool。
- **ConversationService**：会话 CRUD + 消息快照保存（只动存储，不碰 Agent）。
- **ChatService**：send → 取 Provider → AgentFactory 建 Agent → 发送 → 流式推送 → 落盘。
- **WorkspaceRepository**：workspaces.json 读写。
- **ConversationRepository**：复用 EntityRepository，目录 `conversations/{wsId}`。
- **EventDispatcher**：`emit(channel, payload)`（接口 + Electron 实现）。
- **ProviderFactory**：封装 `Provider.create(cwd)`。
- **AgentFactory**：封装 `createAgent + 恢复历史 + 覆盖模型`。
- **IpcRegistrar**：注册 invoke 路由 + 窗口控制。
- **WindowManager**：窗口创建/管理。
- **container**：组装依赖图；**main.ts**：boot。

---

## 8. 核心数据流（概念）

发送一条消息：
1. render `chatStore.send` → api → main `ChatService`
2. 读会话 → ProviderPool 取 workspace 的 Provider → AgentFactory 建 Agent（恢复历史 → 覆盖模型）
3. `agent.send()`，chunk 事件 → EventDispatcher → `chat:push` 推送 → render `chatStore.applyEvent` → 增量渲染
4. 发送结束 → 全量消息落盘 → 推送 `done`

---

## 9. 与 SDK 的边界

| SDK / Core 提供 | Desktop 自建 |
|-----------------|-------------|
| Provider（cwd / 能力管线） | ProviderPool（1:1 懒加载管理） |
| createAgent / SdkAgent / 工具 / 插件 | AgentFactory（恢复历史 + 覆盖模型）、会话存储、流式推送适配、UI |
| `AgentNS.Message`（消息模型） | 直接沿用（不另造） |
| `AgentRepository` / `ConfigManager` | Agent/模型列表直接复用（D4/D5） |

---

## 10. 实现顺序（UI 先行）

1. **搭 UI 骨架**：transport（mock）+ stores + App 页面切换 + GuideView 引导页（场景 1）
2. **主界面**：MainView（Sidebar 树 + 会话列表 + 新建对话 → ChatPanel 流式聊天，场景 2/3/6/7/8/11/12/13/15）
3. **从 UI 提取服务契约**：api.ts 方法签名 + 事件 channel + shared 类型
4. **main 实现**（services → storage → events → provider → ipc → container），切 electron-transport 联调
5. **增强**：P1（重命名/删除/切模型/并行/设置页）
6. **联调验证**：多 workspace 并行、模型覆盖、流式渲染、重试

---

## 11. 已决策 / 后置事项

- **已决策**：A1–A8、B1–B6、C1–C5、D1–D8；P0/P1/P2 场景；render 分层（views 组织、大驼峰命名、v-if 页面切换）；main 分层。
- **后置**：窗口形态（单主窗口 + 自绘标题栏维持现状）、渲染技术细节（流式 diff、markdown 渲染）、IPC 方法全量清单（UI 定稿后派生）、存储是否需要接口（出现第二个实现再提取）。
