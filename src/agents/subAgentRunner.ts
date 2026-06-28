import type { ProviderAdapter, ChatMessage, ChatRequest, ContentBlock } from "../providers/ProviderAdapter";
import type { ToolDispatcher } from "../tools/toolDispatcher";
import type { ApprovalGate } from "../approval/approvalGate";
import type { ProjectMap } from "../repo/projectMap";
import type { SubAgentConfig } from "./types";
import type { MemoryMode } from "./types";
import { buildSubAgentSystemPrompt, getSpecialtyDefaultTools } from "./specialtyPresets";

// Этап 5: SubAgentRunner — исполняемая сущность sub-агента.
// Принимает SubAgentConfig + RunContext → строит свой ChatRequest (своя модель,
// свой system prompt = базовый + надстройка specialty) → approval (scope
// "subagent", scopeId = agent.id) → chat → возвращает результат.
//
// Memory-режим (docs/agent-architecture.md раздел 2):
//   none    — stateless, контекст не сохраняется (по умолчанию для critic)
//   task    — помнит до конца задачи (in-memory Map по agent.id + run-id)
//   session — помнит до рестарта VS Code (in-memory Map по agent.id)
//   ask     — спрашивать каждый раз (в этой реализации = none, модал later)
//
// Таймаут 60с (как в архитектуре). Если sub завис → main получает ошибку.

export interface SubAgentRunContext {
  // Базовый системный промт MineAgent (из config/AGENTS.md).
  baseSystemPrompt: string;
  // Задача для sub-агента (одно предложение или развёрнутое описание).
  task: string;
  // Карта проекта (compact JSON) — для контекста.
  projectMap: ProjectMap;
  // Артефакт для оценки (для reviewer/vision/critic) — код, скрин base64, geo.json.
  // Передаётся как user-сообщение; image-блоки добавляются в content если есть.
  artifact?: SubAgentArtifact;
  // Провайдер для вызова модели.
  provider: ProviderAdapter;
  // Dispatcher для tool-calls (если sub-агенту разрешены tools).
  dispatcher?: ToolDispatcher;
  // Signal для отмены.
  signal?: AbortSignal;
}

export interface SubAgentArtifact {
  // Текстовый артефакт (код, JSON, описание).
  text?: string;
  // Image-блоки (base64 PNG) — для vision-оценки.
  images?: Array<{ data: string; mimeType: string }>;
}

export interface SubAgentRunResult {
  // Текстовый ответ модели.
  content: string;
  // Сырой ответ провайдера (для отладки/логирования).
  raw?: unknown;
  // Признак таймаута.
  timedOut: boolean;
}

// In-memory хранилище контекста sub-агентов по memoryMode.
// task: Map<agentId + runId, ChatMessage[]> — живёт до конца задачи.
// session: Map<agentId, ChatMessage[]> — живёт до рестарта VS Code.
const taskMemory = new Map<string, ChatMessage[]>();
const sessionMemory = new Map<string, ChatMessage[]>();

export function clearSubAgentMemory(): void {
  taskMemory.clear();
  sessionMemory.clear();
}

export function clearTaskMemory(runId: string): void {
  for (const key of taskMemory.keys()) {
    if (key.endsWith(`:${runId}`)) {
      taskMemory.delete(key);
    }
  }
}

const SUB_AGENT_TIMEOUT_MS = 60_000;

export class SubAgentRunner {
  public constructor(
    private readonly gate: ApprovalGate,
    // Генератор requestId для approval (тестируемость).
    private readonly makeRequestId: () => string = () => `subagent-${Date.now()}-${Math.random().toString(36).slice(2)}`
  ) {}

  public async run(
    agent: SubAgentConfig,
    context: SubAgentRunContext,
    runId: string = "default"
  ): Promise<SubAgentRunResult> {
    if (!agent.enabled) {
      throw new Error(`Sub-агент «${agent.displayName}» выключен.`);
    }

    // Approval: scope "subagent", scopeId = agent.id (per-sub-agent approval,
    // не per-tool — защищает от модалко-спама когда main зовёт 5 sub-агентов).
    const approved = await this.gate.request({
      requestId: this.makeRequestId(),
      toolName: `subagent.run:${agent.id}`,
      scope: "subagent",
      scopeId: agent.id,
      description: `Запуск sub-агента «${agent.displayName}» (${agent.specialty}): ${context.task.slice(0, 120)}`,
      risk: "read",
      input: { task: context.task }
    });
    if (!approved) {
      throw new Error(`Запуск sub-агента «${agent.displayName}» не одобрен пользователем.`);
    }

    // Строим system prompt: базовый + надстройка specialty (или promptOverride).
    const systemPrompt = buildSubAgentSystemPrompt(
      context.baseSystemPrompt,
      agent.specialty,
      agent.promptOverride
    );

    // Восстанавливаем контекст из памяти (если memoryMode != none).
    const memoryKey = this.memoryKey(agent.id, runId, agent.memoryMode);
    const priorMessages = memoryKey ? (this.readMemory(memoryKey) ?? []) : [];

    // Строим messages: system + prior (из памяти) + user (задача + артефакт).
    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      ...priorMessages,
      ...this.buildUserMessages(context)
    ];

    // Toolset: из config.allowedTools ИЛИ дефолт по specialty.
    const toolNames = agent.allowedTools.length ? agent.allowedTools : getSpecialtyDefaultTools(agent.specialty);

    const chatRequest: ChatRequest = {
      model: agent.model,
      temperature: 0.2,
      maxTokens: 1600,
      messages,
      signal: context.signal
    };

    // Добавляем tools если есть dispatcher и toolset непустой.
    if (context.dispatcher && toolNames.length) {
      const tools = this.buildTools(context.dispatcher, toolNames);
      if (tools && tools.length) {
        chatRequest.tools = tools;
      }
    }

    // Таймаут 60с (docs/agent-architecture.md раздел 2).
    const timeoutController = new AbortController();
    const timeoutId = setTimeout(() => timeoutController.abort(), SUB_AGENT_TIMEOUT_MS);
    // Комбинируем с внешним signal если есть.
    if (context.signal) {
      context.signal.addEventListener("abort", () => timeoutController.abort(), { once: true });
    }

    try {
      const response = await context.provider.chat({
        ...chatRequest,
        signal: timeoutController.signal
      });

      // Сохраняем контекст в память (если memoryMode != none).
      if (memoryKey) {
        const updated = [...priorMessages, { role: "user" as const, content: this.buildUserText(context) }, { role: "assistant" as const, content: response.content }];
        this.writeMemory(memoryKey, updated);
      }

      return {
        content: response.content,
        raw: response.raw,
        timedOut: false
      };
    } catch (error) {
      if (timeoutController.signal.aborted && (!context.signal?.aborted)) {
        return {
          content: `Sub-агент «${agent.displayName}» превысил таймаут ${SUB_AGENT_TIMEOUT_MS / 1000}с.`,
          timedOut: true
        };
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // Строит user-сообщения: задача + артефакт (text + image-блоки).
  private buildUserMessages(context: SubAgentRunContext): ChatMessage[] {
    const artifact = context.artifact;
    if (artifact?.images?.length) {
      // Multimodal: content = массив блоков (text + image_url).
      const blocks: ContentBlock[] = [];
      const textParts = [context.task];
      if (artifact.text) {
        textParts.push(artifact.text);
      }
      blocks.push({ type: "text", text: textParts.join("\n\n") });
      for (const img of artifact.images) {
        blocks.push({
          type: "image_url",
          image_url: {
            url: `data:${img.mimeType};base64,${img.data}`,
            detail: "low"
          }
        });
      }
      // Карта проекта — отдельным text-сообщением для prefix-cache-friendliness.
      return [
        { role: "user", content: `Карта проекта:\n${JSON.stringify(this.compactProjectMap(context.projectMap), null, 2)}` },
        { role: "user", content: blocks }
      ];
    }
    // Text-only: обычная строка.
    const artifactText = artifact?.text ? `\n\nАртефакт для оценки:\n${artifact.text}` : "";
    return [
      {
        role: "user",
        content: `Карта проекта:\n${JSON.stringify(this.compactProjectMap(context.projectMap), null, 2)}\n\nЗадача: ${context.task}${artifactText}`
      }
    ];
  }

  // Текстовая версия user-сообщения для сохранения в память (без image-блоков).
  private buildUserText(context: SubAgentRunContext): string {
    const artifact = context.artifact;
    const parts = [context.task];
    if (artifact?.text) {
      parts.push(artifact.text);
    }
    if (artifact?.images?.length) {
      parts.push(`[передано ${artifact.images.length} изображений для vision-оценки]`);
    }
    return parts.join("\n\n");
  }

  private compactProjectMap(projectMap: ProjectMap): Record<string, unknown> {
    return {
      loader: projectMap.loader,
      minecraftVersion: projectMap.minecraftVersion,
      javaVersion: projectMap.javaVersion,
      mainModId: projectMap.mainModId,
      registries: projectMap.registries.slice(0, 10),
      eventHandlers: projectMap.eventHandlers.slice(0, 10)
    };
  }

  private buildTools(dispatcher: ToolDispatcher, toolNames: string[]): ChatRequest["tools"] {
    // Собираем только tools, чьи контракты зарегистрированы в dispatcher.
    const tools: NonNullable<ChatRequest["tools"]> = [];
    for (const name of toolNames) {
      const contract = dispatcher.contractFor(name);
      if (contract) {
        tools.push({
          type: "function",
          function: {
            name: contract.name,
            description: contract.description,
            parameters: contract.inputSchema
          }
        });
      }
    }
    return tools;
  }

  private memoryKey(agentId: string, runId: string, mode: MemoryMode): string | undefined {
    switch (mode) {
      case "none":
        return undefined;
      case "task":
        return `${agentId}:${runId}`;
      case "session":
        return agentId;
      case "ask":
        // В этой реализации "ask" = none (модал later). Возвращаем undefined,
        // чтобы не накапливать контекст без явного согласия.
        return undefined;
    }
  }

  private readMemory(key: string): ChatMessage[] | undefined {
    return taskMemory.get(key) ?? sessionMemory.get(key);
  }

  private writeMemory(key: string, messages: ChatMessage[]): void {
    // task-ключи содержат ":" (agentId:runId), session-ключи — нет.
    if (key.includes(":")) {
      taskMemory.set(key, messages);
    } else {
      sessionMemory.set(key, messages);
    }
  }
}
