# TODO — desktop

待办按「最小下一步 + 验收标准」写，不写愿望。每条都注明**为什么还没做**，免得下次有人以为它已经验过。
已完成的不进这个文件（那些进 git 历史与 `docs/`）。

---

## 1. 首启引导屏只经单测 / 类型 / 打包验证，**没跑过真 GUI**

**现状（事实，不是推断）**

- `views/setup/index.vue`（首启引导屏）与 `unset` 态那套逻辑，验证方式是：`controller.test.ts` 里 5 条 `unset` 用例、`vue-tsc --noEmit` 0 错、`pnpm build` 通过。
- 单测全绿不等于功能能用：上一轮「连接屏两屏共用组件 state」那个 bug 就是单测全绿、真跑才暴露的。
- 本机没有 electron 二进制（`node_modules/electron` 目录不存在），devDependency 里写的是 `electron@^43.1.1`。
- 本机没有图形环境（`DISPLAY` / `WAYLAND_DISPLAY` 都为空），但 **`/usr/bin/xvfb-run` 存在** —— 无头 X 这条路是通的。

**最小下一步**

```bash
cd desktop
pnpm add -D electron          # 约 100MB，需要网络；只是装二进制，版本号不变、不进 git（node_modules）
# 用一个干净的 AI_ZEN_DIR，「没配过」才成立（别动你自己的 ~/.ai-zen）
export AI_ZEN_DIR=/tmp/aizen-gui && mkdir -p "$AI_ZEN_DIR"
pnpm build
xvfb-run -a pnpm --filter @ai-zen/desktop-main start   # main 自带 --remote-debugging-port=9222
```

`AI_ZEN_DIR` 是被尊重的（`packages/main/src/config.ts`：环境变量优先于 `app.getPath("home")`），所以可以用临时目录反复重来。

要看屏幕就把 devtools 协议当眼睛（别再靠「进程没崩」猜）：

```bash
curl -s localhost:9222/json/list | head            # 拿 webSocketDebuggerUrl
# 用 CDP 发 Page.captureScreenshot，存成 png 后看图
```

**验收标准（逐条走一遍，错一条就是没做完）**

1. 全新 `AI_ZEN_DIR` 启动 → 出现**引导屏**（而不是连接状态屏）。这是 `unset` 独立成态的全部意义：默认值兜底会让首启去拉起一个服务端。
2. 引导屏选「本机」→ 服务端被拉起 / 探通 → 进主界面。
3. 引导屏选「远程」+ 一个连不上的地址（如 `127.0.0.1:1`）→ 屏上给出原因，且**可重试 / 可改地址**，不是死路。
4. 走完后退出：`<AI_ZEN_DIR>/desktop/connection.json` 内容与盘上预期一致、`stat -c %a` 是 `600`；连不上时**不该**留下这个文件。
5. 第二次启动：直接进主界面（不摆屏）。
6. 首启 + 本地服务端 + 一个 API Key 都没有 → 凭据门（见下一条）出现。

---

## 2. 「选服务 + 填 API Key」在桌面端不是独立向导，只是「提示一句 + 跳到设置页」

**现状（事实）**

- `App.vue` 的 `init()`：连上之后发现所有端点都没有 apiKey → `ElMessage.warning` + `uiStore.setView("settings")`。
- 能救急，但不是「引导」：消息一闪而过，用户落到设置页要自己在四节里找到「API Key」那一节；而这一节还混着「服务端连接 / 默认模型 / 数据目录」。
- CLI 那边有完整的 `ConfigWizard`，桌面端没有对应屏。
- 之所以没直接做：那一节的表单（每个端点 + 注册链接 + 明文核对）在 `views/settings/index.vue` 里。再画一屏等于把同一件事实现两遍，两份必然漂。

**最小下一步**

1. 把 `views/settings/index.vue` 的 **API Key 那一节**连同它的提示抽成组件（建议 `components/ApiKeyForm.vue`）：输入 `endpoints`、对外抛改动，注册链接与明文核对一起带走。**抽组件，不复制**。
2. 设置页改用这个组件（行为不变，先把「只有一份实现」坐实）。
3. 新增 `views/credentials/index.vue`（或做成 `setup` 的第二形态）：只放这一个组件 + 「保存并继续」。保存成功 → `uiStore.setView("main")`。
4. `App.vue` 的优先级链加一格：`设置页 → setup(unset) → 状态屏(未就绪) → 凭据屏(连上了但没有 Key) → guide / main`。
   注意守住现有那条：用户在设置页自救时**不许**被自动弹走（`currentView !== "settings"` 的守卫）。

**验收标准**

1. 连上但没有任何 API Key → 落到凭据屏（不是设置页），屏上能填、能存。
2. 填完保存 → 进主界面，并且**能真发出一条消息**（不是只弹了个成功提示）。
3. 有 Key 的机器启动 → 不出现凭据屏。
4. 设置页那一节与凭据屏用的是同一个组件：`grep -rn "apiKey" packages/render/src --include=*.vue` 里，绑定 `v-model` 的输入框只有一处。
5. 未连接时打开设置页仍然完好（那一节留空 + 一条说明，不弹红条）—— 老行为不许被这次改动带坏。
