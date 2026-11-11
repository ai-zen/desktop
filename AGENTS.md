# AGENTS.md — Desktop 开发注意事项

面向 AI Agent / 开发者的项目说明。重点：**启动与调试相关的坑**。

## 协作原则（最高优先级）

- **任何事情无法确定，都直接询问用户，不要自己纠结或擅自假设。**
  - 需求语义不清 → 问
  - 设计取舍拿不准 → 问
  - 是否提交 / 是否改动某处 → 问
  - 宁可多问一句，也不要猜错方向白做。

## 执行纪律（防止自作主张）

你是执行者，不是决策者。**用户没有明确说的，一律不做。**

1. **告知 ≠ 指派**：用户报告问题、陈述事实、吐槽、表达不满——都只是告知，不是让我行动。
   只有出现明确的祈使指令（「去做 X」「修改 Y」「提交」）才动手。
2. **先确认再动手**：任何文件修改、命令执行、代码改动，都必须在用户明确指示之后发生。
   不确定时，正确动作是「停下等待」，不是「猜一个最像的去做」。
3. **被纠正立即停**：用户说「没让你做」「别动」「我让你改了吗」时——
   立刻停止一切操作，只撤销自己越权的改动（如 `git restore`），
   不道歉后趁机换种方式继续，不衍生任何新动作、新猜测。
4. **禁止推测性行动**：没有「顺手」「顺便」「自然延伸」。
   每件事都要有明确指令对应，否则就是越权。
5. **默认什么都不做**：拿不准时，默认状态是「静止」，直到收到明确指令。

## 启动

```bash
pnpm dev
```

- 组合：`vite`（render 热更新）+ `rolldown --watch`（main 编译）+ `nodemon`（main 变更重启 electron）+ `electron`（带 `--remote-debugging-port=9222`）
- render 页面加载地址：`http://localhost:5173`（**写死**，见 `packages/main/src/app.ts` 的 `createMainWindow`）

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

# main 构建（改 server/main 后必跑）
cd packages/main && pnpm build
```

## Markdown 渲染

消息正文由 `packages/render/src/components/MarkdownContent.vue` 用 `markdown-it` + `highlight.js`（`lib/core` + 按需注册语言）同步渲染成 HTML，一次成型：没有占位符、没有视口懒加载、也没有动态高度，滚动位置因此稳定。

- 新增语言：在同一个文件里再 `import` 一个 `highlight.js/lib/languages/*` 并注册 —— 全量引入会让包体积膨胀一个数量级
- 改渲染链后要重启 dev（vite 重新 optimize），热更新可能造成状态混乱假象

## main 端调试经验

- **rolldown 会把正则字面量里的 `\d` 转义成 `\\d`**（语义从「数字」变成「反斜杠+d」），正则永远不匹配——排查时先 `node -e` 验证构建产物里的正则源码。**规避：正则里用 `[0-9]` 而非 `\d`**
- **`import type { AgentNS }` 是 type-only**，运行时 `AgentNS` 是 undefined，`AgentNS.Role.User` 访问直接 TypeError（被 async void 调用吞掉，症状是函数"莫名提前结束"）。**需要运行时枚举值必须用值导入 `import { AgentNS }`**
- **main 进程异步逻辑异常排查**：`void this.xxx()` 的 rejection 会被吞（无人监听），症状是"执行到一半没下文"。定位手段：关键步骤写文件日志（`appendFileSync` 到项目根，dev 是 detached 无 stdout），逐段确认执行流；切忌只改代码重测而不看证据
- **electron 加载的 dist 版本 ≠ 源码版本**：rolldown watch + nodemon 有编译/重启时序，改完 main 代码后必须确认 `(Get-Process electron).StartTime` 晚于 dist 的 `LastWriteTime`，再实测
- **electron 由根目录 `pnpm dev` 的 nodemon 管理**：nodemon watch `packages/main/dist/main.mjs`，main 源码变更自动编译+重启 electron（自动带 `NODE_ENV=development` 加载 localhost:5173）。**不要手动 `pnpm build` / kill electron / 单独 `pnpm start`**——手动启动的 electron 缺 NODE_ENV 会加载 file:// 旧 render 产物，且与 nodemon 实例抢 9222 端口造成多实例混乱。需重启 electron 时：touch dist/main.mjs 触发 nodemon，或等 watch 编译自动触发
- **main 进程是 ESM**（package.json `type: module`）：调试日志用 `import { appendFileSync } from "node:fs"`，不能用 `require`（ReferenceError 会被 try/catch 吞掉，症状是"日志写不出来"）

## 其他

- 数据根目录：`~/.ai-zen/`（共享根，CLI/Desktop 共用）
  - **数据文件仍然只归服务端**：工作区、会话存档、Agent 定义、模型配置全在常驻 `agents-server` 那边（它的 `AI_ZEN_DIR`），桌面端不碰。main 从盘上只读 `<AI_ZEN_DIR>/run/` 下的两件事：`server.json`（**默认**的地址来源：服务端此刻在哪个端口）与 `token`（凭证，服务端启动时读或生成，`0600`），见 `packages/main/src/server/index.ts`
  - **唯一的本地写是连接配置**：`<AI_ZEN_DIR>/desktop/connection.json`（`0600` + 原子写，里面有凭证；读不到 / 坏 JSON / 字段不合法一律回退「本地」并照常启动）。这**不是**「桌面端开始落盘了」，而是**先有鸡先有蛋**：服务端手上有全部业务配置，可要问它，得先知道**连哪台** —— 把「连哪台」也存到服务端，等于要求用户先连上服务端才能选服务端。路径的唯一实现处是 `packages/main/src/connection/settings.ts`（`config.ts` 只剩 `AI_ZEN_DIR`，不拼这个子路径）。**除这一处，不新增任何往本地写数据的入口** —— 有意的例外，不是松绑
  - **连哪台在设置页里切**（「设置」页开头的「服务端连接」那一节）：本地 = 发现文件 + 本机 `run/token`；远程 = 用户填的地址（`ws://` / `wss://` / `http://` / `https://`，支持 path，如 `wss://example.com/ai-zen`）与凭证（留空 = 用本机 `run/token`）。远程**只连、不拉起**捆绑的 server（本机拉起来的一定不在那个地址上；只留一条只说地址、不含凭证的 log）
    - 这一节自带「测试连接」（只探测候选值：不落盘、不影响当前连接）与「保存并重连」（先落盘 → dispose 旧层 → 建新 → start，**立刻**生效、不必重启 App，进行中的回答会中断），与页面底部那个「保存」（把默认模型 / 默认 Agent / API Key 写给**服务端**，不换连接）分开
    - 实现：`connection/{settings,controller}.ts` + 三条专用 IPC `connection:get` / `connection:save` / `connection:test`（**不进** `invokeService` 的 service 表 —— 那六个键是服务端的方法面）
  - 会话历史由服务端的 `<workspace>/workspace.json` + `<workspace>/sessions/*.json` 存档接管，main 侧没有本地库
  - 全局配置：`~/.ai-zen/config.json`（含 endpoints/models，DeepSeek apiKey 明文）——**由服务端读写**，桌面端只走 `config.get` / 窄方法
- IPC 通道：`invokeService`（业务）+ `connection:get/save/test`（连接设置，见上）+ `window:xxx`（窗口控制）+ `dialog:selectDirectory`（原生目录选择，默认桌面、记住上次位置）
- 业务语义：工作空间 cwd **选填，默认桌面**（`app.getPath("desktop")` 兜底）；删 workspace 级联删会话，删会话不碰 workspace
- 调试截图（`preview-*.png`）已加入 `.gitignore`，勿提交
