---
title: 环境搭建
description: Electron 二进制下载失败处理与 path.txt 注意事项
---

# Electron 环境搭建备忘

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
