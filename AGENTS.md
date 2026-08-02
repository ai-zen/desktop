# AGENTS.md — Desktop 开发注意事项

面向 AI Agent / 开发者的项目说明。重点：**启动与调试相关的坑**。

## 协作原则（最高优先级）

- **任何事情无法确定，都直接询问用户，不要自己纠结或擅自假设。**
  - 需求语义不清 → 问
  - 设计取舍拿不准 → 问
  - 是否提交 / 是否改动某处 → 问
  - 宁可多问一句，也不要猜错方向白做。

## 启动

```bash
pnpm dev
```

- 组合：`vite`（render 热更新）+ `rolldown --watch`（main 编译）+ `nodemon`（main 变更重启 electron）+ `electron`（带 `--remote-debugging-port=9222`）
- render 页面加载地址：`http://localhost:5173`（**写死**，见 `packages/main/src/main.ts`）

## ⚠️ 重复启动警告（重要）

**启动前必须先确认没有已存在的 dev 实例在跑**，否则会出严重冲突：

| 冲突项 | 现象 |
|--------|------|
| 两个 vite | 抢 5173 端口，后启动的自动退让到 5174，但 Electron 写死加载 5173 → 页面可能加载到错误的 vite |
| 两个 Electron | 抢 CDP 9222 端口，只有一个能绑定成功，调试行为不可控 |
| 整体 | 多套进程树互相干扰，行为无法预测 |

### 检查是否已有实例在跑

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='electron.exe'" |
  Where-Object { $_.CommandLine -match 'ai-zen|vite|nodemon|rolldown|electron|concurrently|dev.mjs' }
```

- 若已有实例 → **直接用 CDP 调试，不要再 `pnpm dev`**
- 注意区分：`@ai-zen/cli`（CLI 进程）不是 desktop dev，勿误杀

### 杀掉残留实例

```bash
taskkill /PID <根进程PID> /T /F
```

- 根进程 = `pnpm dev` 对应的 node 进程（父进程链最顶端）
- `/T` 会连同整棵子进程树（vite/nodemon/rolldown/electron 全部）一起杀

### 推荐启动方式

通过工具（如 exec_async）启动时，使用 **detached（脱离进程组）** 方式：
即使 Agent 会话退出，dev 仍独立运行，不随之死亡。

```ts
exec_async({ command: "cd <项目根目录> && pnpm dev", detached: true });
```

## 调试（CDP）

- 端口固定 `9222`，只有唯一实例能绑定
- 页面标题 `AI-Zen Desktop`，URL `http://localhost:5173/`
- 常用：`cdp_list_pages` / `cdp_evaluate` / `cdp_screenshot` / `cdp_get_dom`
- **调试截图原则（按模型区分）**：**非视觉模型不要截图**——截图对它无意义，只会产生垃圾文件；只有**视觉模型**才考虑截图（可作视觉上下文分析 UI）。当前项目是非视觉模型（DeepSeek），所以默认不截图；确需截图时用完即删，`preview-*.png` 属临时产物（已 gitignore，但也别留在工作区），留档图放到项目外（如系统临时目录），不要污染仓库目录

## 构建与类型检查

```bash
# render 类型检查（改 apis/stores/views 后必跑）
cd packages/render && pnpm exec vue-tsc --noEmit

# main 构建（改 services/storage/main 后必跑）
cd packages/main && pnpm build
```

## Markdown 渲染（markstream-vue）经验教训

消息正文用 `markstream-vue` 做流式 Markdown 渲染（assistant 消息），Shiki 代码高亮已启用（`main.ts` 注册 `setCustomComponents({ code_block: MarkdownCodeBlockNode })`）。

- **最大坑：Shadow DOM 隔离**。代码高亮在 `<diffs-container>` 的 shadowRoot 里，常规 DOM 查询（textContent/innerHTML/querySelector）看不到内容，极易误判"内容丢失/没渲染"。检查渲染结果要访问 `el.shadowRoot`。看到"内容为空"先怀疑渲染隔离，不要急着下"库有 bug"的结论
- **启用 Shiki**：装 `markstream-vue` + `shiki@3.23.0` + `stream-markdown`；组件配 `code-renderer="shiki"` + `html-policy="escape"`（防 XSS）+ `:final`（流式结束才 true）+ `max-live-nodes="0"`（chat 打字机模式）
- **不要装 stream-diffs**：peer 版本冲突会导致渲染静默失败，且 markstream 自带 runtime，不需要它（装了反而抢占 Shiki 路径）
- **shiki 用 3.23.0**：满足 stream-markdown peer，4.x 有 API 变化风险
- 装新依赖后建议重启 dev（vite 重新 optimize），热更新可能造成状态混乱假象

## main 端调试经验教训（本次自动命名踩坑）

- **rolldown 会把正则字面量里的 `\d` 转义成 `\\d`**（语义从「数字」变成「反斜杠+d」），正则永远不匹配——排查时先 `node -e` 验证构建产物里的正则源码。**规避：正则里用 `[0-9]` 而非 `\d`**
- **`import type { AgentNS }` 是 type-only**，运行时 `AgentNS` 是 undefined，`AgentNS.Role.User` 访问直接 TypeError（被 async void 调用吞掉，症状是函数"莫名提前结束"）。**需要运行时枚举值必须用值导入 `import { AgentNS }`**
- **main 进程异步逻辑异常排查**：`void this.xxx()` 的 rejection 会被吞（无人监听），症状是"执行到一半没下文"。定位手段：关键步骤写文件日志（`appendFileSync` 到项目根，dev 是 detached 无 stdout），逐段确认执行流；切忌只改代码重测而不看证据
- **electron 加载的 dist 版本 ≠ 源码版本**：rolldown watch + nodemon 有编译/重启时序，改完 main 代码后必须确认 `(Get-Process electron).StartTime` 晚于 dist 的 `LastWriteTime`，再实测
- **electron 由根目录 `pnpm dev` 的 nodemon 管理**：nodemon watch `packages/main/dist/main.mjs`，main 源码变更自动编译+重启 electron（自动带 `NODE_ENV=development` 加载 localhost:5173）。**不要手动 `pnpm build` / kill electron / 单独 `pnpm start`**——手动启动的 electron 缺 NODE_ENV 会加载 file:// 旧 render 产物，且与 nodemon 实例抢 9222 端口造成多实例混乱。需重启 electron 时：touch dist/main.mjs 触发 nodemon，或等 watch 编译自动触发
- **main 进程是 ESM**（package.json `type: module`）：调试日志用 `import { appendFileSync } from "node:fs"`，不能用 `require`（ReferenceError 会被 try/catch 吞掉，症状是"日志写不出来"）

## 其他

- 数据根目录：`~/.ai-zen/`（共享根，CLI/Desktop 共用）
  - **持久化：SQLite**（`~/.ai-zen/desktop/ai-zen.db`，WAL 模式）——当前唯一数据源
    - 实现：`packages/main/src/storage/db.ts`（`node:sqlite` `DatabaseSync` 单例，懒初始化；**Electron 43 = Node 24.18 内置，勿引入 better-sqlite3/sqlite3 native 依赖**）
    - 表：`workspaces(id, name, cwd, created_at)`、`conversations(id, workspace_id, agent_id, model_id, name, message_count, messages JSON blob, created_at, updated_at)` + 索引 `(workspace_id, updated_at DESC)`
    - Repository 接口不变（list/read/write/delete/removeWorkspace），services/render 零感知
  - 全局配置：`~/.ai-zen/config.json`（含 endpoints/models，DeepSeek apiKey 明文）
- IPC 通道：`invokeService`（业务）+ `window:xxx`（窗口控制）+ `dialog:selectDirectory`（原生目录选择，默认桌面、记住上次位置）
- 业务语义：工作空间 cwd **选填，默认桌面**（`app.getPath("desktop")` 兜底）；删 workspace 级联删会话，删会话不碰 workspace
- 调试截图（`preview-*.png`）已加入 `.gitignore`，勿提交
