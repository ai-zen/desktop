/**
 * ui store — 页面切换 + 全局选项（Agent/Model 列表）。
 */

import { defineStore } from "pinia";
import type { AgentOption, ModelOption } from "@ai-zen/desktop-shared";
import * as api from "../apis/index.js";

export type ViewName = "guide" | "main" | "settings";

export const useUiStore = defineStore("ui", {
  state: () => ({
    currentView: "main" as ViewName,
    agents: [] as AgentOption[],
    models: [] as ModelOption[],
  }),

  actions: {
    setView(view: ViewName) {
      this.currentView = view;
    },

    /** 加载 Agent / 模型选项（新建对话下拉、模型选择用） */
    async loadOptions() {
      this.agents = await api.listAgents();
      this.models = await api.listModels();
    },
  },
});
