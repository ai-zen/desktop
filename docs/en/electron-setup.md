---
title: Environment Setup
description: Handling Electron binary download failures, path.txt notes, CDP debug port and pnpm layout notes
---

# Electron Environment Setup Notes

## First-time Electron installation

```bash
cd packages/main
pnpm add -D electron
```

## If the Electron binary download fails

After pnpm installs the electron package, it needs to download the corresponding Electron binary.
If the network is unreachable (GitHub blocked), you can download it manually:

### Option 1: Download from a mirror

```
https://npmmirror.com/mirrors/electron/v{version}/electron-v{version}-win32-x64.zip
```

For example v43.1.1:
```
https://npmmirror.com/mirrors/electron/v43.1.1/electron-v43.1.1-win32-x64.zip
```

### Option 2: Manually extract

After downloading, extract to `node_modules/.pnpm/electron@{version}/node_modules/electron/dist/`.

### Key: create path.txt

After extracting, you need to create a `path.txt` file whose content is **plain text** (no trailing newline):

```
electron.exe
```

> **⚠️ Important:** The `path.txt` file content must NOT end with a newline; otherwise Electron's `index.js` will get `dist/electron.exe\n` when concatenating the path, causing the file to not be found and triggering a re-download.

`path.txt` is read by `electron/index.js`:
```js
executablePath = fs.readFileSync(pathFile, 'utf-8');
// If the content is "electron.exe\n", then:
const fullPath = path.join(__dirname, 'dist', executablePath);
// → "dist/electron.exe\n"  ❌ path has a trailing newline, file not found!
```

## CDP Debug Port

To enable Chrome DevTools Protocol you need to pass `--remote-debugging-port` in the **command-line arguments**:

```bash
electron --remote-debugging-port=9222 dist/main.mjs
```

> **⚠️ Note:** Using `app.commandLine.appendSwitch("remote-debugging-port", "9222")` in code is **ineffective**; the argument must be passed at startup.

The current `packages/main/package.json` already has:
```json
"start": "electron --remote-debugging-port=9222 dist/main.mjs"
```

## pnpm Layout Notes

This project uses a pnpm workspace; the Electron package is located at:
```
node_modules/.pnpm/electron@{version}/node_modules/electron/
```

`packages/main/node_modules/.bin/electron.cmd` points to the `cli.js` in that path.
