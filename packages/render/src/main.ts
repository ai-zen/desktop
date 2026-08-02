import { createApp } from "vue";
import { createPinia } from "pinia";
import ElementPlus from "element-plus";
import * as ElementPlusIconsVue from "@element-plus/icons-vue";
import App from "./App.vue";
import "@/styles/element-variables.scss";
import MarkdownRender, {
  MarkdownCodeBlockNode,
  setCustomComponents,
} from "markstream-vue";
import "markstream-vue/index.css";

// markstream：注册 Shiki 代码块渲染器（流式 markdown 用）
setCustomComponents({ code_block: MarkdownCodeBlockNode });

const app = createApp(App);

app.use(createPinia());

// 全局注册 Element Plus
app.use(ElementPlus, { size: "default" });

// 全局注册所有图标（方便使用）
for (const [key, component] of Object.entries(ElementPlusIconsVue)) {
  app.component(key, component);
}

app.component("MarkdownRender", MarkdownRender);

app.mount("#app");
