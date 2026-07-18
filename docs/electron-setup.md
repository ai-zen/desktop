# Electron 环境搭建备忘

## 首次安装 Electron

```bash
cd packages/main
pnpm add -D electron
```

## 如果 Electron 二进制下载失败

pnpm 安装 electron 包后，需要下载对应的 Electron 二进制文件。
如果网络不通（GitHub 被墙），可以手动下载：

### 方案一：从镜像站下载

```
https://npmmirror.com/mirrors/electron/v{版本}/electron-v{版本}-win32-x64.zip
```

例如 v43.1.1：
```
https://npmmirror.com/mirrors/electron/v43.1.1/electron-v43.1.1-win32-x64.zip
```

### 方案二：手动解压

下载后解压到 `node_modules/.pnpm/electron@{version}/node_modules/electron/dist/`。

### 关键：创建 path.txt

解压后需要创建 `path.txt` 文件，内容为 **纯文本**（不要带换行符）：

```
electron.exe
```

> **⚠️ 重要：** `path.txt` 文件内容不能以换行符结尾，否则 Electron 的 `index.js` 在拼接路径时会得到 `dist/electron.exe\n`，导致文件找不到而触发重新下载。

`path.txt` 会被 `electron/index.js` 读取：
```js
executablePath = fs.readFileSync(pathFile, 'utf-8');
// 如果内容是 "electron.exe\n"，则：
const fullPath = path.join(__dirname, 'dist', executablePath);
// → "dist/electron.exe\n"  ❌ 路径带换行，文件找不到！
```

## CDP 调试端口

开启 Chrome DevTools Protocol 需要在 **命令行参数** 中传递 `--remote-debugging-port`：

```bash
electron --remote-debugging-port=9222 dist/main.mjs
```

> **⚠️ 注意：** 在代码中用 `app.commandLine.appendSwitch("remote-debugging-port", "9222")` 是**无效**的，必须在启动时传参。

当前 `packages/main/package.json` 中已配置：
```json
"start": "electron --remote-debugging-port=9222 dist/main.mjs"
```

## pnpm 结构说明

本项目使用 pnpm workspace，Electron 包位于：
```
node_modules/.pnpm/electron@{version}/node_modules/electron/
```

`packages/main/node_modules/.bin/electron.cmd` 指向的是这个路径的 `cli.js`。
