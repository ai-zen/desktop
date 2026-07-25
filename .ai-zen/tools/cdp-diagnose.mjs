/**
 * CDP 工具：页面综合诊断
 *
 * 一次性获取目标页面的多项关键信息：
 * - 页面标题、URL
 * - 视口尺寸
 * - Vue 应用根组件结构
 * - Element Plus 主题模式（浅色/深色）
 * - 内存使用情况
 * - 控制台错误
 */
import { findTargetPage, evaluate, observeConsole, sendCdpCommand } from "./cdp-shared/index.mjs";

export default {
  function: {
    name: "cdp_diagnose",
    description: "对 Electron 页面进行综合诊断，一次性获取页面标题、视口尺寸、Vue 应用结构、主题模式、内存使用、控制台错误等多维信息。用于快速了解页面整体状态。",
    parameters: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "按页面标题模糊匹配目标页面（可选）",
        },
        url: {
          type: "string",
          description: "按页面 URL 模糊匹配目标页面（可选）",
        },
        index: {
          type: "number",
          description: "按索引选择目标页面（可选，默认 0）",
        },
        host: {
          type: "string",
          description: "CDP 主机地址，默认 127.0.0.1",
          default: "127.0.0.1",
        },
        port: {
          type: "number",
          description: "CDP 调试端口，默认 9222",
          default: 9222,
        },
      },
      required: [],
    },
  },

  /**
   * @param {{ title?: string, url?: string, index?: number, host?: string, port?: number }} args
   */
  exec: async function (args) {
    const {
      title,
      url,
      index,
      host = "127.0.0.1",
      port = 9222,
    } = args || {};

    const page = await findTargetPage({ host, port, title, url, index });
    const ws = page.webSocketDebuggerUrl;

    // 并行获取多项信息
    const results = await Promise.allSettled([
      // 1. 页面基本信息
      evaluate(ws, `({
        title: document.title,
        url: location.href,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        userAgent: navigator.userAgent,
      })`),

      // 2. Vue 应用信息
      evaluate(ws, `(() => {
        const app = document.querySelector('#app');
        if (!app) return { appExists: false };
        const root = app.firstElementChild;
        return {
          appExists: true,
          rootTag: root?.tagName || 'unknown',
          rootClass: root?.className || '',
          childCount: root?.children?.length || 0,
          hasSidebar: !!root?.querySelector('.sidebar'),
          hasChatPanel: !!root?.querySelector('.chat-panel'),
        };
      })()`),

      // 3. 主题信息（CSS 变量）
      evaluate(ws, `(() => {
        const s = getComputedStyle(document.documentElement);
        const isDark = s.getPropertyValue('--el-bg-color').includes('15,15,26');
        return {
          isDarkMode: isDark,
          bgColor: s.getPropertyValue('--el-bg-color'),
          textPrimary: s.getPropertyValue('--el-text-color-primary'),
          primary: s.getPropertyValue('--el-color-primary'),
        };
      })()`),

      // 4. 性能信息
      evaluate(ws, `({
        memory: performance.memory ? {
          jsHeapSizeLimit: Math.round(performance.memory.jsHeapSizeLimit / 1048576) + 'MB',
          totalJSHeapSize: Math.round(performance.memory.totalJSHeapSize / 1048576) + 'MB',
          usedJSHeapSize: Math.round(performance.memory.usedJSHeapSize / 1048576) + 'MB',
        } : '不可用（非 Chromium）',
        timing: {
          domContentLoaded: performance.timing?.domContentLoadedEventEnd - performance.timing?.navigationStart + 'ms',
          load: performance.timing?.loadEventEnd - performance.timing?.navigationStart + 'ms',
        },
      })()`),

      // 5. 控制台错误（监听 2 秒）
      observeConsole(ws, 2000),
    ]);

    // 构建诊断报告
    const sections = [
      "═══════════════════════════════════════",
      "  🔍 CDP 页面综合诊断报告",
      "═══════════════════════════════════════",
      "",
      `  页面标题: ${page.title || "(无标题)"}`,
      `  页面 URL: ${page.url}`,
      `  WebSocket: ${page.webSocketDebuggerUrl}`,
      "",
    ];

    // 基本信息
    if (results[0].status === "fulfilled" && results[0].value) {
      const info = results[0].value;
      sections.push("── 📐 页面信息 ──");
      sections.push(`  视口尺寸: ${info.viewport?.width} x ${info.viewport?.height}`);
      if (info.memory) {
        sections.push(`  内存: 已用 ${info.memory.usedJSHeapSize} / 总计 ${info.memory.totalJSHeapSize}`);
      }
      sections.push("");
    }

    // Vue 应用
    if (results[1].status === "fulfilled" && results[1].value) {
      const app = results[1].value;
      sections.push("── 🏗️ Vue 应用结构 ──");
      if (app.appExists) {
        sections.push(`  根组件: <${app.rootTag}> class="${app.rootClass}"`);
        sections.push(`  子元素数: ${app.childCount}`);
        sections.push(`  侧边栏: ${app.hasSidebar ? "✅ 存在" : "❌ 不存在"}`);
        sections.push(`  对话面板: ${app.hasChatPanel ? "✅ 存在" : "❌ 不存在"}`);
      } else {
        sections.push("  ⚠️ 未检测到 #app 根元素");
      }
      sections.push("");
    }

    // 主题
    if (results[2].status === "fulfilled" && results[2].value) {
      const theme = results[2].value;
      sections.push("── 🎨 主题信息 ──");
      sections.push(`  模式: ${theme.isDarkMode ? "🌙 深色" : "☀️ 浅色"}`);
      sections.push(`  主色: ${theme.primary}`);
      sections.push(`  背景色: ${theme.bgColor}`);
      sections.push(`  文字色: ${theme.textPrimary}`);
      sections.push("");
    }

    // 性能
    if (results[3].status === "fulfilled" && results[3].value) {
      const perf = results[3].value;
      sections.push("── ⚡ 性能信息 ──");
      if (typeof perf.memory === "object") {
        sections.push(`  JS 堆内存限制: ${perf.memory.jsHeapSizeLimit}`);
        sections.push(`  已分配堆内存: ${perf.memory.totalJSHeapSize}`);
        sections.push(`  已使用堆内存: ${perf.memory.usedJSHeapSize}`);
      } else {
        sections.push(`  ${perf.memory}`);
      }
      sections.push("");
    }

    // 控制台错误
    if (results[4].status === "fulfilled" && results[4].value) {
      const logs = results[4].value;
      const errors = logs.filter((l) => l.level === "error");
      const warnings = logs.filter((l) => l.level === "warn");
      sections.push("── 📋 控制台日志 ──");
      sections.push(`  总日志数: ${logs.length}`);
      sections.push(`  错误: ${errors.length} 条`);
      sections.push(`  警告: ${warnings.length} 条`);
      if (errors.length > 0) {
        sections.push("");
        sections.push("  ❌ 错误详情:");
        errors.slice(0, 5).forEach((e, i) => {
          sections.push(`    [${i + 1}] ${e.text.slice(0, 200)}`);
        });
      }
      if (warnings.length > 0) {
        sections.push("");
        sections.push("  ⚠️ 警告详情:");
        warnings.slice(0, 5).forEach((w, i) => {
          sections.push(`    [${i + 1}] ${w.text.slice(0, 200)}`);
        });
      }
      sections.push("");
    }

    sections.push("═══════════════════════════════════════");

    return sections.join("\n");
  },
};
