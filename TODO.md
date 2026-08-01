# TODO — AI-Zen Desktop

功能开发待办清单（按优先级排序）。

## 1. Markdown 渲染支持

- 现状：消息正文用 `v-html` 直接输出文本，无 Markdown 渲染
- 目标：对话消息支持 Markdown（代码块、行内代码、列表、加粗、链接等）
- 注意：工具结果（`role=tool`）折叠区保持纯文本即可；渲染需防 XSS（不直接 `v-html` 用户输入）

## 2. 对话重命名与删除

- 现状：workspace 有悬停操作，conversation 无任何操作入口；`conversation.remove` API 已就绪，重命名 API 待确认/补充
- 目标：侧栏对话右键菜单或悬停操作（重命名 / 删除）

## 3. 自动生成对话名称

- 现状：对话名称为手动输入（NewChatDialog）
- 目标：首轮对话后根据消息内容自动生成名称（如截取首条用户消息前 N 字，或调用模型总结）

## 4. 设置页（低优先级）

- 现状：`uiStore.currentView` 已支持 `settings`，入口未加
- 目标：设置页 SettingsView，内容：API Key / 默认模型 / Agent 列表 / 数据目录
