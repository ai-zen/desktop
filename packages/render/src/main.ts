import { createApp } from "vue";
import ElementPlus from "element-plus";
import * as ElementPlusIconsVue from "@element-plus/icons-vue";
import App from "./App.vue";
import "@/styles/element-variables.scss";

const app = createApp(App);

// 全局注册 Element Plus
app.use(ElementPlus, { size: "default" });

// 全局注册所有图标（方便使用）
for (const [key, component] of Object.entries(ElementPlusIconsVue)) {
  app.component(key, component);
}

app.mount("#app");
