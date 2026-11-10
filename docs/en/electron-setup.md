---
title: Environment Setup
description: Handling Electron binary download failures and path.txt notes
---

# Electron Environment Setup Notes

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
