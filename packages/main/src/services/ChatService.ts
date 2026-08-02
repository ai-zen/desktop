/**
 * 聊天服务 — 对应 render 的 apis/chat.ts。
 *
 * 设计原则：**agent 是会话状态的唯一真相，运行期驻留、运行完释放**。
 *   - 每个 conversation 的 agent 仅在「运行中」注册（运行注册表），agent.messages
 *     实时持有完整消息（含流式进行中的 user + assistant 占位）；运行结束（done/error）
 *     即释放 —— 不运行时内存不占，状态由 SQLite 快照接管（getState 兜底读磁盘）；
 *   - SQLite 里的 conversation.messages 仅是「磁盘持久化快照」（done 时备份），
 *     不参与运行时状态流转 —— 切换会话/窗口开关不丢状态，全靠在库快照 + 运行注册表；
 *   - 运行中状态用 agent.isHasPendingMessage 查询，main 不另存一份 streaming。
 *
 * 流式协议（chat:push 单通道，见 shared ChatStreamEvent）：
 *   start  →  message（完整消息实时同步：正文/工具调用/工具结果） →  done（全量 messages）/ error
 *   done 后异步自动生成对话标题 → renamed（不阻塞 done，侧栏据此更新名称）
 */

import { AgentNS } from "@ai-zen/agents-core";
import { createAgent, createModel } from "@ai-zen/agents-sdk";
import type { ChatStreamEvent, ConversationState } from "@ai-zen/desktop-shared";
import type { Conversation } from "@ai-zen/desktop-shared";
import type { ConversationRepository } from "../storage/ConversationRepository.js";
import type { WorkspaceRepository } from "../storage/WorkspaceRepository.js";
import type { ProviderPool } from "./ProviderPool.js";

/** 新建会话的默认命名格式（ConversationService.create 生成 `对话_HH:mm`）
 *  注意：用 [0-9] 而非 \d —— rolldown 会把正则字面量里的 \d 转义成 \\d（语义变成反斜杠+d）导致永远不匹配 */
const DEFAULT_NAME_RE = /^对话_[0-9]{2}:[0-9]{2}$/;

type Agent = Awaited<ReturnType<typeof createAgent>>;

interface AgentEntry {
  agent: Agent;
  workspaceId: string;
}

/** ChatService 构造依赖（由 App 单根组装注入） */
export interface ChatServiceOptions {
  workspaceRepo: WorkspaceRepository;
  conversationRepo: ConversationRepository;
  providers: ProviderPool;
  push: (evt: ChatStreamEvent) => void;
}

export class ChatService {
  /** 运行注册表：conversationId -> 运行中的会话 agent（运行完即释放，见 runAgentSend finally） */
  private agents = new Map<string, AgentEntry>();
  /** 正在自动命名中的会话 id（防止并发触发重复命名） */
  private naming = new Set<string>();

  constructor(private opts: ChatServiceOptions) {}

  async send(
    workspaceId: string,
    conversationId: string,
    content: string,
  ): Promise<void> {
    // 只等待「取/建 agent」完成（快速返回）；流式循环后台执行，结果走 chat:push 事件
    try {
      const conversation = await this.opts.conversationRepo.read(workspaceId, conversationId);
      if (!conversation) throw new Error(`会话不存在: ${conversationId}`);

      // 运行中复用：若该会话 agent 正在回复（含上一轮未结束）则忽略本次重复提交
      // （前端 streaming 兜底已禁用输入，此处仅为防 IPC 直调/毫秒级竞态的防御）；
      // 否则（空闲/未聊过）新建 agent —— 每次新建都带最新 conversation.modelId，
      // 无需单独的模型懒同步。
      const existing = this.agents.get(conversationId);
      if (
        existing &&
        existing.workspaceId === workspaceId &&
        existing.agent.isHasPendingMessage
      ) {
        return;
      }
      const agent = await this.createAndRegisterAgent(
        workspaceId,
        conversationId,
        conversation,
      );

      // 流式循环后台执行（user/delta/done 均由 agent 事件驱动），不阻塞本调用
      void this.runAgentSend(workspaceId, conversationId, agent, content);
    } catch (error) {
      // 取 agent 阶段的错误（会话不存在/创建失败等）通过事件通知 UI
      this.opts.push({
        conversationId,
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * 后台执行完整一轮流式（agent.send 可含多轮工具调用，全程不阻塞 send 调用方）。
   * 订阅 agent 事件转发 chat:push，事件驱动、不手动读 agent.messages：
   *   inner-loops-start（整组开始，一次 send 仅一次）→ user + start
   *   chunk-parsed（每 chunk）                        → message（完整 receiver 实时同步：正文/reasoning/tool_calls/status）
   *   inner-loop-end（每轮结束）                      → message（补推本轮新增的工具结果 Tool/Function）
   *   inner-loops-end（整组结束，一次 send 仅一次）   → 落库 + done + 自动命名
   */
  private async runAgentSend(
    workspaceId: string,
    conversationId: string,
    agent: Agent,
    content: string,
  ): Promise<void> {
    // 整组内循环开始：user + assistant 占位已就绪（事件参数 messages 即当前完整消息）
    const onLoopsStart = (messages: AgentNS.Message[]) => {
      const userMsg = messages.at(-2)!; // send 无条件追加 user + assistant 两条（带真实 id）
      this.opts.push({ conversationId, type: "user", id: userMsg.id!, content });
      this.opts.push({ conversationId, type: "start" });
    };

    // 流式实时同步 → message（chunk-parsed 带当前 receiver 完整对象，
    // 正文/reasoning/tool_calls/status 一次到位，前端按 id 就地替换）
    const onChunkParsed = (receiver: AgentNS.Message) => {
      this.opts.push({
        conversationId,
        type: "message",
        id: receiver.id!, // agent 内消息构造即带 id
        message: receiver,
      });
    };

    // 每轮内循环结束：补推本轮新增的工具结果消息（Tool/Function）——
    // chunk-parsed 只覆盖 assistant，工具执行结果靠这里实时上屏，
    // 前端无需全量替换即可看到「调用了什么工具、返回了什么」
    const pushedToolIds = new Set<string>();
    const onLoopEnd = () => {
      for (const m of agent.messages) {
        if (
          (m.role === AgentNS.Role.Tool || m.role === AgentNS.Role.Function) &&
          m.id &&
          !pushedToolIds.has(m.id)
        ) {
          pushedToolIds.add(m.id);
          this.opts.push({
            conversationId,
            type: "message",
            id: m.id,
            message: m,
          });
        }
      }
    };

    agent.events.on("inner-loop-end", onLoopEnd);

    // 整组内循环结束：messages 为完整结果（正常/error/abort 均到达）→ 落库 + done + 自动命名
    const onLoopsEnd = async (messages: AgentNS.Message[]) => {
      await this.persistSnapshot(workspaceId, conversationId, messages);
      this.opts.push({ conversationId, type: "done", messages });
      // 自动生成对话标题：异步执行，不阻塞 done（防重复由 naming Set + 默认名判断保证）
      void this.autoRename(workspaceId, conversationId);
    };

    agent.events.on("inner-loops-start", onLoopsStart);
    agent.events.on("chunk-parsed", onChunkParsed);
    agent.events.on("inner-loop-end", onLoopEnd);
    agent.events.on("inner-loops-end", onLoopsEnd);

    try {
      // user/delta/done 均由 agent 事件驱动；此处 await 仅等待流式跑完（异常兜底）
      await agent.send(content);
    } catch (error) {
      // 兜底：send 意外 reject（正常/error 均走 inner-loops-end，一般不会到这里）
      this.opts.push({
        conversationId,
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      agent.events.off("inner-loops-start", onLoopsStart);
      agent.events.off("chunk-parsed", onChunkParsed);
      agent.events.off("inner-loop-end", onLoopEnd);
      agent.events.off("inner-loops-end", onLoopsEnd);
      // 运行结束释放：仅当注册表里仍是本 agent 才删（新一轮可能已注册新 agent，
      // 或被 release 提前清掉 —— 都跳过，避免误删）
      if (this.agents.get(conversationId)?.agent === agent) {
        this.agents.delete(conversationId);
      }
    }
  }

  /**
   * 把消息快照写入 SQLite（每轮内循环结束 / 最终完成时调用）。
   * 持久化失败不打断对话（后续轮次/最终 done 还会再落库）。
   */
  private async persistSnapshot(
    workspaceId: string,
    conversationId: string,
    messages: AgentNS.Message[],
  ): Promise<void> {
    try {
      const conversation = await this.opts.conversationRepo.read(workspaceId, conversationId);
      if (!conversation) return;
      conversation.messages = messages;
      conversation.updatedAt = new Date().toISOString();
      await this.opts.conversationRepo.write(workspaceId, conversation);
    } catch {
      // ignore: 持久化失败不中断对话
    }
  }

  /**
   * 读取会话实时状态（render 切换会话时调用，前端始终访问服务而非绕开它读磁盘）。
   * 有运行中 agent → 返回 agent.messages（含流式进行中的 user + 部分 assistant）+ 运行中标记；
   * 无运行中 agent（已完成/未聊过） → 返回 SQLite 持久化快照，streaming=false。
   */
  async getState(
    workspaceId: string,
    conversationId: string,
  ): Promise<ConversationState> {
    const entry = this.agents.get(conversationId);
    if (entry && entry.workspaceId === workspaceId) {
      return {
        messages: entry.agent.messages,
        streaming: entry.agent.isHasPendingMessage,
      };
    }
    const conversation = await this.opts.conversationRepo.read(workspaceId, conversationId);
    return {
      messages: conversation?.messages ?? [],
      streaming: false,
    };
  }

  /**
   * 新建并注册运行中的 agent（仅在 send 时调用，运行结束由 runAgentSend finally 释放）。
   * 把持久化快照（conversation.messages）载入 agent.messages 作为初始历史，
   * 注册 onInnerLoopEnd 落库插件，并用对话级 modelId 建模型（无需懒同步）。
   */
  private async createAndRegisterAgent(
    workspaceId: string,
    conversationId: string,
    conversation: Conversation,
  ): Promise<Agent> {
    const workspace = await this.opts.workspaceRepo.read(workspaceId);
    if (!workspace) throw new Error(`工作空间不存在: ${workspaceId}`);

    const provider = await this.opts.providers.get(workspace);
    const agent = await createAgent(provider, conversation.agentId);
    // 载入持久化历史（此后 agent.messages 即运行时真相）
    if (conversation.messages.length > 0) {
      agent.messages = conversation.messages;
    }
    agent.model = createModel(provider, conversation.modelId);

    // 注册持久化插件：每轮内循环结束（工具调用结果已写入 messages、下一轮开始前）
    // 落库当前快照。必须用插件而非直接赋 onInnerLoopEnd —— SdkAgent.send 内部会
    // 用插件分发器覆盖该字段，直接赋值会被吞掉。
    agent.use({
      onInnerLoopEnd: async () => {
        await this.persistSnapshot(workspaceId, conversationId, agent.messages);
      },
    });

    this.agents.set(conversationId, { agent, workspaceId });
    return agent;
  }

  /** 释放会话的运行中 agent（删除会话时调用；中止进行中的任务并清出注册表） */
  async release(conversationId: string): Promise<void> {
    const entry = this.agents.get(conversationId);
    if (entry) {
      try {
        entry.agent.abort();
      } catch {
        /* ignore */
      }
      this.agents.delete(conversationId);
    }
  }

  /** 释放某工作空间下的全部运行中 agent（删除工作空间级联删会话时调用） */
  async releaseWorkspace(workspaceId: string): Promise<void> {
    for (const [convId, entry] of this.agents) {
      if (entry.workspaceId === workspaceId) {
        try {
          entry.agent.abort();
        } catch {
          /* ignore */
        }
        this.agents.delete(convId);
      }
    }
  }

  /**
   * 首轮对话完成后自动命名：仅当会话名仍为默认 `对话_HH:mm` 时触发，
   * 用对话级模型静默生成 4~12 字标题（createCompletion，不触发流式事件，
   * 也不走运行注册表 agent —— 避免污染会话消息状态）；
   * 生成失败/超时则降级为取首条用户消息前 16 字符。
   */
  private async autoRename(
    workspaceId: string,
    conversationId: string,
  ): Promise<void> {
    if (this.naming.has(conversationId)) return;
    this.naming.add(conversationId);
    try {
      const conversation =
        await this.opts.conversationRepo.read(workspaceId, conversationId);
      if (!conversation) return;
      // 仅对默认名自动命名（用户手动改过则不再覆盖）
      if (!DEFAULT_NAME_RE.test(conversation.name)) return;

      const firstUser = this.firstUserText(conversation.messages);
      if (!firstUser) return;

      const workspace = await this.opts.workspaceRepo.read(workspaceId);
      if (!workspace) return;
      const provider = await this.opts.providers.get(workspace);

      let name = "";
      try {
        name = await this.generateTitle(provider, conversation.modelId, firstUser);
      } catch {
        // LLM 调用失败走本地兜底
      }
      if (!name) name = this.fallbackTitle(firstUser);

      // 生成标题耗时期间用户可能手动改过名：写库前重新读取校验，
      // 若已非默认格式（被手动重命名/已被其他命名）则放弃，避免覆盖
      const latest = await this.opts.conversationRepo.read(workspaceId, conversationId);
      if (!latest || !DEFAULT_NAME_RE.test(latest.name)) return;

      latest.name = name;
      latest.updatedAt = new Date().toISOString();
      await this.opts.conversationRepo.write(workspaceId, latest);
      this.opts.push({ conversationId, type: "renamed", name });
    } finally {
      this.naming.delete(conversationId);
    }
  }

  /** 静默调用对话级模型生成标题（tools 传空，不带任何工具/MCP） */
  private async generateTitle(
    provider: Awaited<ReturnType<ProviderPool["get"]>>,
    modelId: string,
    userMessage: string,
  ): Promise<string> {
    const model = createModel(provider, modelId);
    const res = await model.createCompletion({
      tools: [],
      messages: [
        {
          role: AgentNS.Role.System,
          content:
            "你是对话标题生成器。根据用户的第一条消息，用 4 到 12 个字概括对话主题。只输出标题本身，不要引号、不要标点、不要任何解释。",
        },
        { role: AgentNS.Role.User, content: userMessage },
      ],
    });
    return this.cleanTitle(this.contentToText(res.choices?.[0]?.message?.content));
  }

  /** 从消息快照中取第一条纯文本 user 消息（跳过图片等非文本内容） */
  private firstUserText(messages: AgentNS.Message[]): string {
    for (const m of messages) {
      if (m.role !== AgentNS.Role.User) continue;
      const text = this.contentToText(m.content);
      if (text) return text;
    }
    return "";
  }

  /** content 可能是 string 或 sections 数组，统一提取纯文本 */
  private contentToText(content: AgentNS.MessageContent | undefined): string {
    if (typeof content === "string") return content.trim();
    if (Array.isArray(content)) {
      return content
        .filter((s) => s.type === "text")
        .map((s) => (s as { text?: string }).text ?? "")
        .join("")
        .trim();
    }
    return "";
  }

  /** 清洗标题：去首尾空白/引号/书名号，截断到 30 字符 */
  private cleanTitle(title: string): string {
    return title
      .trim()
      .replace(/^[「『"'《]|[」』"'》]+$/g, "")
      .trim()
      .slice(0, 30);
  }

  /** 本地兜底：取首条用户消息前 16 字符 */
  private fallbackTitle(userMessage: string): string {
    const t = userMessage.trim();
    return t.length <= 16 ? t : `${t.slice(0, 16)}…`;
  }
}
