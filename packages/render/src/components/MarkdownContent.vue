<template>
  <div class="md-content" v-html="html"></div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import MarkdownIt from "markdown-it";
import hljs from "highlight.js/lib/core";
import type { LanguageFn } from "highlight.js";

// ==================== 代码高亮：按需注册常用语言 ====================
// 只用 hljs core + 显式注册，避免全量 190+ 语言导致包体积膨胀
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import graphql from "highlight.js/lib/languages/graphql";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import lua from "highlight.js/lib/languages/lua";
import makefile from "highlight.js/lib/languages/makefile";
import markdown from "highlight.js/lib/languages/markdown";
import objectivec from "highlight.js/lib/languages/objectivec";
import php from "highlight.js/lib/languages/php";
import plaintext from "highlight.js/lib/languages/plaintext";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import scss from "highlight.js/lib/languages/scss";
import shell from "highlight.js/lib/languages/shell";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

const LANGUAGES: Record<string, LanguageFn> = {
  bash, c, cpp, csharp, css, diff, dockerfile, go, graphql, ini, java,
  javascript, json, kotlin, lua, makefile, markdown, objectivec, php,
  plaintext, python, ruby, rust, scss, shell, sql, swift, typescript,
  xml, yaml,
};
for (const [name, lang] of Object.entries(LANGUAGES)) {
  hljs.registerLanguage(name, lang);
}

// ==================== markdown-it 单例 ====================
// 同步解析，一次成型，无占位符/无视口懒加载/无动态高度
const md = new MarkdownIt({
  html: false,      // 转义原始 HTML（安全，等价于旧 html-policy="escape"）
  linkify: true,    // 自动识别链接
  breaks: false,    // 标准 markdown 换行语义
  typographer: false,
  highlight(code: string, lang: string): string {
    // 有语言且已注册 → 高亮；否则纯文本兜底（不启用自动检测，避免慢且不准）
    if (lang && hljs.getLanguage(lang)) {
      try {
        return (
          `<pre class="hljs-pre"><code class="hljs language-${md.utils.escapeHtml(lang)}">` +
          hljs.highlight(code, { language: lang, ignoreIllegals: true }).value +
          "</code></pre>"
        );
      } catch {
        /* 高亮失败走兜底 */
      }
    }
    return `<pre class="hljs-pre"><code class="hljs">${md.utils.escapeHtml(code)}</code></pre>`;
  },
});

const props = defineProps<{
  /** Markdown 原文 */
  content: string;
}>();

const html = computed(() => md.render(props.content));
</script>

<style lang="scss">
/* 非 scoped：v-html 注入的内容需要全局样式。
   全部 markdown 排版 + 代码高亮配色集中在此，组件自包含。 */

.md-content {
  font-size: 13px;
  line-height: 1.6;
  word-break: break-word;

  p {
    margin: 0 0 10px;

    &:last-child {
      margin-bottom: 0;
    }
  }

  h1, h2, h3, h4 {
    margin: 14px 0 8px;
    font-weight: 600;
    line-height: 1.4;
    color: var(--el-text-color-primary);
  }
  h1 { font-size: 16px; }
  h2 { font-size: 15px; }
  h3 { font-size: 14px; }
  h4 { font-size: 13px; }

  ul, ol {
    margin: 0 0 10px;
    padding-left: 20px;
  }
  li {
    margin: 2px 0;
  }

  a {
    color: var(--el-color-primary);
    text-decoration: none;

    &:hover {
      text-decoration: underline;
    }
  }

  blockquote {
    margin: 10px 0;
    padding: 2px 12px;
    border-left: 3px solid var(--el-color-primary-light-5);
    color: var(--el-text-color-secondary);
    background: var(--el-fill-color-light);
    border-radius: 0 4px 4px 0;
  }

  table {
    margin: 10px 0;
    border-collapse: collapse;
    font-size: 13px;
    width: 100%;
  }
  th, td {
    border: 1px solid var(--el-border-color);
    padding: 6px 10px;
    text-align: left;
  }
  th {
    background: var(--el-fill-color-light);
    font-weight: 600;
  }

  hr {
    border: none;
    border-top: 1px solid var(--el-border-color);
    margin: 14px 0;
  }

  img {
    max-width: 100%;
    border-radius: 6px;
  }

  // 行内代码
  :not(pre) > code {
    padding: 1px 5px;
    background: var(--el-fill-color-light);
    border-radius: 4px;
    color: var(--el-color-primary);
    font-family: "JetBrains Mono", "Fira Code", Consolas, "Courier New", monospace;
    font-size: 0.92em;
  }

  // ==================== 代码块 ====================
  pre.hljs-pre {
    margin: 10px 0;
    padding: 0;                 // 内边距交给 code.hljs
    background: transparent;
    border: 1px solid var(--el-border-color);
    border-radius: 6px;
    overflow: hidden;
  }

  pre.hljs-pre code.hljs {
    display: block;
    padding: 12px 14px;
    overflow-x: auto;
    font-family: "JetBrains Mono", "Fira Code", Consolas, "Courier New", monospace;
    font-size: 13px;
    line-height: 1.6;
    background: var(--md-code-bg, var(--el-fill-color-light));
    // 覆盖行内 code 的 primary 色，让 token 继承语法高亮色
    color: var(--md-code-fg, var(--el-text-color-primary));
  }

  // ==================== 语法高亮 token 配色（GitHub Light/Dark） ====================
  --hl-comment: #6e7781;
  --hl-keyword: #cf222e;
  --hl-string: #0a3069;
  --hl-number: #0550ae;
  --hl-title: #8250df;
  --hl-type: #953800;
  --hl-attr: #116329;
  --hl-builtin: #0550ae;
  --hl-meta: #0550ae;
  --hl-deletion-bg: #ffebe9;
  --hl-addition-bg: #dafbe1;

  .hljs-comment,
  .hljs-quote { color: var(--hl-comment); font-style: italic; }

  .hljs-keyword,
  .hljs-selector-tag,
  .hljs-doctag { color: var(--hl-keyword); }

  .hljs-string,
  .hljs-regexp,
  .hljs-template-string { color: var(--hl-string); }

  .hljs-number,
  .hljs-literal,
  .hljs-variable,
  .hljs-template-variable,
  .hljs-meta .hljs-keyword { color: var(--hl-number); }

  .hljs-title,
  .hljs-title.function_,
  .hljs-section,
  .hljs-selector-id,
  .hljs-symbol { color: var(--hl-title); }

  .hljs-type,
  .hljs-class .hljs-title,
  .hljs-built_in,
  .hljs-attr,
  .hljs-attribute { color: var(--hl-type); }

  .hljs-meta { color: var(--hl-meta); }

  .hljs-emphasis { font-style: italic; }
  .hljs-strong { font-weight: 600; }

  .hljs-addition { background: var(--hl-addition-bg); }
  .hljs-deletion { background: var(--hl-deletion-bg); }

  .hljs-link { text-decoration: underline; }
}

@media (prefers-color-scheme: dark) {
  .md-content {
    --hl-comment: #8b949e;
    --hl-keyword: #ff7b72;
    --hl-string: #a5d6ff;
    --hl-number: #79c0ff;
    --hl-title: #d2a8ff;
    --hl-type: #ffa657;
    --hl-attr: #7ee787;
    --hl-builtin: #79c0ff;
    --hl-meta: #79c0ff;
    --hl-deletion-bg: rgba(248, 81, 73, 0.2);
    --hl-addition-bg: rgba(46, 160, 67, 0.2);
  }
}
</style>
