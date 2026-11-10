import { createApp } from "vue";
import { createPinia } from "pinia";
import ElementPlus from "element-plus";
import * as ElementPlusIconsVue from "@element-plus/icons-vue";
import App from "./App.vue";
import "@/styles/element-variables.scss";
// 程序式 API 弹的提示（`ElMessage.*`：设置页的保存提示、聊天里的通知）不会被
// unplugin-vue-components 自动补样式 —— 它只认模板里的标签，而这是一个函数调用。
// 不显式引一次，`el-message` 就只是个无样式 div（连 `position: fixed` 都在 CSS 里），
// 满屏布局下等于看不见 —— 通知功能就白做了。element-plus 已在 dependencies，不算新依赖。
import "element-plus/es/components/message/style/css";

const app = createApp(App);

app.use(createPinia());

app.use(ElementPlus, { size: "default" });

for (const [key, component] of Object.entries(ElementPlusIconsVue)) {
  app.component(key, component);
}

app.mount("#app");
