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

## 构建与类型检查

```bash
# render 类型检查（改 apis/stores/views 后必跑）
cd packages/render && pnpm exec vue-tsc --noEmit

# main 构建（改 services/storage/main 后必跑）
cd packages/main && pnpm build
```

## 其他

- 数据根目录：`~/.ai-zen/`（共享根，CLI/Desktop 共用）
  - workspaces：`~/.ai-zen/desktop/workspaces/{id}.json`
  - conversations：`~/.ai-zen/desktop/conversations/{wsId}/{convId}.json`
  - 全局配置：`~/.ai-zen/config.json`（含 endpoints/models，DeepSeek apiKey 明文）
- IPC 通道：`invokeService`（业务）+ `window:xxx`（窗口控制）+ `dialog:selectDirectory`（原生目录选择，默认桌面、记住上次位置）
- 调试截图（`preview-*.png`）已加入 `.gitignore`，勿提交
