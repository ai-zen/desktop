/**
 * 词典用例：13 个通知 code 都得有一句中文，而且参数得**真的**代进句子里。
 *
 * ## 为什么这一层要单独测（不只靠 `events.test.ts` 的真链路）
 *
 * 真链路一次只造得出一条通知（服务端今天只在这些时刻发，`askHandoffMode` 能稳定造出的
 * 是 `migrationSkipped`）。剩下那 12 条 code 的文案没有任何路径能跑到 —— 而它们的坏法很
 * 具体：**参数名对不上**（服务端给 `path`，词典读 `file`）时界面上会少一截，**漏一个
 * code** 时整条落到兜底，用户看到「未知通知」。两种坏法都不抛错、不报警，只有断言能抓到。
 *
 * 断言的形状：`params` 代入的挑 `toContain`（句子措辞可以改，代进去的**值**不能丢），
 * 无参数的挑非空 + 不带 `undefined`。
 */

import { describe, expect, it } from "vitest";
import { GLOBAL_NOTICE_CODES, SESSION_NOTICE_CODES } from "@ai-zen/agents-client";
import { noticeText } from "./notices.js";

/** 协议里全部 13 个 code（11 个对话内 + 2 个全局） */
const ALL_CODES = [...Object.values(SESSION_NOTICE_CODES), ...Object.values(GLOBAL_NOTICE_CODES)];

describe("词典：每个 code 都有文案", () => {
  it("13 个 code 逐个出非空文案，且不落到「未知通知」兜底", () => {
    // 数目先钉住：协议加了第 14 个 code 而词典没跟上时，这条用例先红
    expect(ALL_CODES).toHaveLength(13);

    for (const code of ALL_CODES) {
      // 最坏的调用形状（`params` 整个缺失）也必须出话：服务端只在有可变部分时才带 params
      const text = noticeText(code);
      expect(text.length, `${code} 没有文案`).toBeGreaterThan(0);
      expect(text, `${code} 落到了未知兜底`).not.toContain("未知通知");
      // `String(undefined)` / `String([object Object])` 漏进句子的那种坏法
      expect(text, `${code} 的文案里漏了 undefined`).not.toContain("undefined");
    }
  });
});

describe("词典：params 代进句子（字段名对着服务端的 emit 点）", () => {
  it("handoffPath 带路径、handoffArchived 带旧会话 id、persistFailed 带错误原文", () => {
    expect(noticeText("handoffPath", { path: "/proj/.ai-zen/handoffs/a.md" })).toContain(
      "/proj/.ai-zen/handoffs/a.md",
    );
    // `params.sessionId` 是**旧**会话（`SessionManager.autoMigrate` / `migrate`）
    expect(noticeText("handoffArchived", { sessionId: "chat_7" })).toContain("chat_7");
    expect(noticeText("persistFailed", { error: "ENOSPC: no space left" })).toContain(
      "ENOSPC: no space left",
    );
  });

  it("handoffAutoDetected 带 used/limit，handoffMigrated 带条数", () => {
    const detected = noticeText("handoffAutoDetected", {
      used: 9_000,
      limit: 8_000,
      mode: "self",
    });
    expect(detected).toContain("9000/8000");
    // 枚举值要翻成人话：中文界面里冒出 `（self）` 就是把协议词汇漏给了用户
    expect(detected).toContain("原 agent 自交接");
    expect(detected).not.toContain("self");

    expect(noticeText("handoffMigrated", { n: 5 })).toContain("5");
  });

  it("subAgentFailed 带序号与原文，序号缺了句子也成立", () => {
    expect(noticeText("subAgentFailed", { index: 2, message: "模型炸了" })).toContain("2");
    expect(noticeText("subAgentFailed", { index: 2, message: "模型炸了" })).toContain("模型炸了");
    // 只有原文（`index` 缺）：不出 `子 Agent # 出错`，也不出 undefined
    expect(noticeText("subAgentFailed", { message: "模型炸了" })).toBe("子 Agent 出错：模型炸了");
  });

  it("migrationDegraded 两个执行者都翻成人话，mcpUnavailable / storeUnavailable 带名字与原因", () => {
    const degraded = noticeText("migrationDegraded", { requested: "self", mode: "summary" });
    expect(degraded).toContain("原 agent 自交接");
    expect(degraded).toContain("独立摘要");

    expect(noticeText("mcpUnavailable", { name: "filesystem" })).toContain("filesystem");
    expect(noticeText("storeUnavailable", { error: "EACCES" })).toContain("EACCES");
  });
});

describe("词典：params 缺字段时照出话（空着就空着）", () => {
  it("缺字段出的是「空位」而不是 undefined，且该省的说法整块省掉", () => {
    // 只留一个尾巴：句子照样是一句话，用户不会看到字段名
    expect(noticeText("handoffPath")).toBe("交接文档：");
    // 两个数缺一个就整块省掉，不留 `（9000/ tokens）` 这种半截
    expect(noticeText("handoffAutoDetected", { used: 9_000, mode: "self" })).not.toContain("/");
    // 后置说明（`（独立摘要）`）缺值就整块省掉，不留空括号
    expect(noticeText("handoffWriting")).toBe("正在编写任务交接文档…");
    // 引号里必须有个词的位置，缺值时说「未指定」，不留一对空引号
    expect(noticeText("migrationDegraded")).toContain("未指定");
  });
});

describe("词典：未知 code 不静默", () => {
  it("服务端版本比桌面端新时，文案里带着原 code（能拿去查），而不是被丢掉", () => {
    // 协议把文案交给客户端 → 版本偏斜是常态；静默丢弃才是 bug（用户只会看到「什么都没发生」）
    const text = noticeText("brandNewNotice");
    expect(text).toContain("未知通知");
    expect(text).toContain("brandNewNotice");
  });
});
