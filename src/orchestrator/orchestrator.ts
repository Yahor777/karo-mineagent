import type { MineAgentConfig, ResearchLedger } from "../config/types";
import { ProviderRequestError } from "../providers/openaiCompatibleProvider";
import type { ProviderAdapter, ProviderModel, ChatResponse, ChatMessage, ChatRequest, ToolCall } from "../providers/ProviderAdapter";
import { hasImageBlocks, extractTextFromContent } from "../providers/ProviderAdapter";
import type { ProviderRegistry } from "../providers/providerRegistry";
import { TokenBudgetService, type BudgetSnapshot, type ModelPricing } from "../providers/tokenBudget";
import type { ProjectMap } from "../repo/projectMap";
import { RepoIndexer } from "../repo/repoIndexer";
import { GradleTools } from "../tools/gradleTools";
import type { CommandEvidence } from "../tools/gradleTools";
import { parseMinecraftLog, type ParsedLogSummary } from "../tools/logParser";
import type { ToolDispatcher } from "../tools/toolDispatcher";
import { buildToolSchemas, TOOL_LOOP_TOOLS } from "../tools/toolSchemas";
import type { BlockbenchBridge } from "../mcp/blockbenchBridge";
import type { MinecraftBridge } from "../mcp/minecraftBridge";
import type { McpBridge } from "../mcp/bridgeTypes";
import { createInitialRunPhases, type RunPhaseState } from "./phases";
import type { VisionEvaluator, VisionVerdict } from "./visionEvaluator";
import type { CriticRunner, CriticVerdict } from "./criticRunner";
import { resolveConsensus } from "./criticRunner";
import type { SkillService } from "../skills/skillService";
import type { SkillMatchResult } from "../skills/types";
import type { KnowledgeBaseService } from "../knowledge/knowledgeBase";
import type { KnowledgeSearchResult } from "../knowledge/types";
import type { ProjectMemoryService } from "../memory/projectMemory";
import { EvidenceService } from "../evidence/evidenceService";
import { PreflightProbe } from "../providers/preflightProbe";

export interface RunRequest {
  prompt: string;
  mode: "ask" | "plan" | "build" | "playtest";
  rules?: string;
  researchLedger?: ResearchLedger;
  signal?: AbortSignal;
  onActivity?: (event: RunActivityEvent) => void;
  // Этап 6: релевантные скиллы (retrieval) — подмешиваются в system prompt.
  matchedSkills?: SkillMatchResult[];
  // Этап 6: релевантные записи Knowledge Base — подмешиваются в system prompt.
  matchedKnowledge?: KnowledgeSearchResult[];
  // Фаза 1: готовый блок «память проекта» (.mineagent/project.md), подмешивается
  // в начало контекста. Провайдеро-независимо (просто текст, без embeddings).
  projectMemory?: string;
}

export interface RunReport {
  id: string;
  prompt: string;
  phases: RunPhaseState[];
  projectMap: ProjectMap;
  summary: string;
  // Этап 2: след всех tool-call'ов за run (имя, input, результат, была ли
  // ошибка/deny). Нужно для evidence и UI-отладки tool-loop.
  toolCalls?: ToolCallTrace[];
}

// Запись о пройденном tool-call'е в loop. error заполняется при deny
// пользователя или падении handler'а — loop при этом продолжается, модель
// видит отказ и может отреагировать.
export interface ToolCallTrace {
  name: string;
  input: unknown;
  result?: unknown;
  error?: string;
  // Срабатывал ли авто-trigger gradle.run после этого вызова.
  autoBuildTriggered?: boolean;
  // Сработавший auto-build: exitCode (null = ещё не завершён/упал до close).
  autoBuildExitCode?: number | null;
  // Этап 5: image-блоки (base64 PNG) из NormalizedToolResult.images —
  // сохраняются для vision-фазы. НЕ кладутся в role:"tool" (JSON.stringify
  // убил бы base64 и раздул контекст). Источник: blockbench.render,
  // minecraft.screenshot.
  images?: Array<{ data: string; mimeType: string }>;
}

// Внутренний результат askConfiguredModel: итоговый текст ответа + опционально
// след tool-call'ов для RunReport (evidence/UI).
interface ModelOutcome {
  summary: string;
  toolCalls?: ToolCallTrace[];
}

export interface RunActivityEvent {
  phase?: RunPhaseState["name"];
  status: "started" | "progress" | "complete" | "failed";
  message: string;
  // Этап 5: reasoning_content (chain-of-thought) от reasoning-моделей.
  // Передаётся отдельным полем, чтобы UI мог отрисовать его особым стилем.
  reasoningContent?: string;
  // Событие стоп-предложения по токен-бюджету. Появляется только ПОСЛЕ
  // завершения ответа модели и только если лимит превышен и юзер не скрыл
  // уведомление для сессии.
  budgetExceeded?: BudgetSnapshot;
  // Этап 2: текущая итерация tool-loop (для прогресс-индикатора в UI).
  toolLoopIteration?: number;
  // Этап 5: результат vision-оценки артефакта (скрин/рендер).
  visionVerdict?: {
    matches: boolean;
    confidence: number;
    notes: string;
    model: string;
    sourceTool: string;
  };
  // Этап 5: результат critic-оценки артефакта. Показывается в UI:
  // consensus → применить, disagreement → модалка с обоими мнениями.
  criticVerdict?: {
    verdict: "approve" | "reject" | "uncertain";
    reasoning: string;
    model: string;
    isSelfCritique: boolean;
    // Что main думает об артефакте (для модалки разногласия).
    mainApproved: boolean;
    // Действие по консенсусу: "apply" = авто-применение, "ask-user" = модалка.
    action: "apply" | "ask-user";
  };
}

export class MineAgentOrchestrator {
  // Этап 3/4: все MCP-bridge'и, чьи инструменты могут попасть в tool-loop.
  // Сейчас это BlockbenchBridge (blockbench.*) и MinecraftBridge (minecraft.*).
  // Хранится как массив — orchestrator итерирует по нему единообразно, без
  // branch'ей на конкретный тип моста. Префиксы имён исключают коллизии.
  private readonly bridges: McpBridge[];
  // Этап 5: опциональные vision/critic сервисы. Включаются по config —
  // передаются в конструктор как опциональные зависимости (как bridges).
  // Triggered на чекпойнтах внутри runToolLoop, НЕ на каждой итерации.
  private readonly visionEvaluator?: VisionEvaluator;
  private readonly criticRunner?: CriticRunner;
  // Этап 6: опциональные skills/knowledge сервисы. При run() — retrieval
  // выбирает релевантные скиллы + записи базы знаний → подмешиваются в system prompt.
  private readonly skillService?: SkillService;
  private readonly knowledgeBase?: KnowledgeBaseService;
  // Фаза 1: сервис живой памяти проекта (.mineagent/project.md). Если передан —
  // run() грузит память в контекст и дописывает журнал/факты после задачи.
  private readonly projectMemory?: ProjectMemoryService;
  private readonly preflightProbe?: PreflightProbe;

  public constructor(
    private readonly root: string,
    private readonly config: MineAgentConfig,
    private readonly providers: ProviderRegistry,
    private readonly tokenBudget?: TokenBudgetService,
    // Опциональный dispatcher: если передан, опасные tool-вызовы (gradle.run в
    // playtest) идут через ApprovalGate. Иначе — прямой вызов (legacy/тесты).
    private readonly dispatcher?: ToolDispatcher,
    // Этап 3: опциональный Blockbench-bridge. Сохранён как позиционный параметр
    // для обратной совместимости с тестами Этапа 3 (передаётся 6-м аргументом).
    blockbenchBridge?: BlockbenchBridge,
    // Этап 4: опциональный Minecraft-bridge. Если передан И подключён — его
    // minecraft.*-инструменты добавляются в tool-loop наравне с blockbench.*.
    minecraftBridge?: MinecraftBridge,
    // Этап 5: опциональные vision/critic сервисы. Если переданы —
    // triggered на чекпойнтах (после blockbench.render / minecraft.screenshot
    // для vision, после repo.patch для critic).
    visionEvaluator?: VisionEvaluator,
    criticRunner?: CriticRunner,
    // Этап 6: опциональные skills/knowledge сервисы.
    skillService?: SkillService,
    knowledgeBase?: KnowledgeBaseService,
    // Фаза 1: опциональный сервис памяти проекта.
    projectMemory?: ProjectMemoryService,
    preflightProbe?: PreflightProbe
  ) {
    const list: McpBridge[] = [];
    if (blockbenchBridge) {
      list.push(blockbenchBridge);
    }
    if (minecraftBridge) {
      list.push(minecraftBridge);
    }
    this.bridges = list;
    this.visionEvaluator = visionEvaluator;
    this.criticRunner = criticRunner;
    this.skillService = skillService;
    this.knowledgeBase = knowledgeBase;
    this.projectMemory = projectMemory;
    this.preflightProbe = preflightProbe;
  }

  public async run(request: RunRequest): Promise<RunReport> {
    const startedAt = new Date().toISOString();
    const phases = createInitialRunPhases();
    request.onActivity?.({
      status: "started",
      message: "Принял задачу. Собираю карту проекта перед запросом к модели."
    });
    const projectMap = await this.completePhase(phases, "Understand", request, async () => {
      return new RepoIndexer(this.root).buildProjectMap();
    });

    // Фаза 1 («не забывать ничего»): загружаем живую память проекта и кладём её
    // в начало контекста. Параллельно синхронизируем факты идентичности из свежей
    // карты проекта — так агент помнит loader/версии/modId даже после сжатия истории.
    if (this.projectMemory) {
      try {
        await this.projectMemory.syncIdentity({
          loader: projectMap.loader,
          minecraftVersion: projectMap.minecraftVersion,
          javaVersion: projectMap.javaVersion,
          mainModId: projectMap.mainModId,
          registriesCount: projectMap.registries.length,
          eventHandlersCount: projectMap.eventHandlers.length,
          updatedAt: projectMap.indexedAt
        });
        // Конвенции архитектуры из индексатора (DeferredRegister, GeckoLib и т.п.)
        // записываем в память — дедупликация не плодит повторов между запусками.
        for (const hint of projectMap.architectureHints) {
          await this.projectMemory.appendToSection("conventions", hint);
        }
        request.projectMemory = await this.projectMemory.renderForPrompt();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        request.onActivity?.({ phase: "Understand", status: "progress", message: `Память проекта недоступна: ${message}` });
      }
    }

    if (request.mode === "playtest") {
      await this.completePhase(phases, "Build", request, async () => {
        // Если передан dispatcher — gradle build идёт через ApprovalGate.
        // Иначе — прямой вызов (обратная совместимость с тестами без gate).
        if (this.dispatcher) {
          return this.dispatcher.dispatch(
            "gradle.run",
            { task: this.config.minecraft.gradleBuildTask },
            `Gradle build (${this.config.minecraft.gradleBuildTask})`
          ) as Promise<CommandEvidence>;
        }
        const tools = new GradleTools(this.root);
        return tools.build(this.config.minecraft.gradleBuildTask);
      });
    }
    // Этап 6: skills + knowledge retrieval перед запросом к модели.
    // Retrieval дёшев (embedding similarity), но экономит токены — модель
    // получает только релевантные скиллы/записи, а не весь каталог.
    if (this.skillService && this.config.agent.skillsTopK > 0) {
      try {
        request.matchedSkills = await this.skillService.match(
          request.prompt,
          this.config.agent.skillsTopK
        );
        if (request.matchedSkills.length) {
          request.onActivity?.({
            phase: "Report",
            status: "progress",
            message: `Skills: выбрано ${request.matchedSkills.length} скиллов — ${request.matchedSkills.map((s) => s.skill.name).join(", ")}.`
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        request.onActivity?.({ phase: "Report", status: "progress", message: `Skills retrieval не удался: ${message}` });
      }
    }
    if (this.knowledgeBase && this.config.agent.knowledgeTopK > 0) {
      try {
        request.matchedKnowledge = await this.knowledgeBase.search(
          request.prompt,
          this.config.agent.knowledgeTopK
        );
        if (request.matchedKnowledge.length) {
          request.onActivity?.({
            phase: "Report",
            status: "progress",
            message: `Knowledge Base: найдено ${request.matchedKnowledge.length} релевантных записей.`
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        request.onActivity?.({ phase: "Report", status: "progress", message: `Knowledge retrieval не удался: ${message}` });
      }
    }
    const modelPhase = modelPhaseForMode(request.mode);
    const modelOutcome = request.prompt.trim()
      ? await this.completePhase(phases, modelPhase, request, async () => this.askConfiguredModel(request, projectMap))
      : undefined;
    this.markUnavailablePhases(phases, request.mode);

    // Фаза 1: после задачи дописываем журнал в память проекта (если был запрос).
    // Это сохраняет «что делали и чем закончилось» навсегда, независимо от сжатия чата.
    if (this.projectMemory && request.prompt.trim() && modelOutcome) {
      try {
        await this.projectMemory.appendRunLog({
          at: new Date().toISOString(),
          mode: request.mode,
          task: request.prompt,
          summary: modelOutcome.summary
        });
      } catch {
        // запись журнала не должна валить основной flow
      }
    }

    const runId = `run-${Date.now()}`;
    const summary = modelOutcome?.summary ?? createRunSummary(request, projectMap);

    try {
      const evidenceService = new EvidenceService(this.root, this.config.paths.runs);
      await evidenceService.saveRunEvidence(
        runId,
        request.prompt,
        startedAt,
        new Date().toISOString(),
        summary,
        projectMap,
        modelOutcome?.toolCalls,
        phases
      );
    } catch (error) {
      console.error("Не удалось сохранить evidence запуска:", error);
    }

    return {
      id: runId,
      prompt: request.prompt,
      phases,
      projectMap,
      summary,
      toolCalls: modelOutcome?.toolCalls
    };
  }

  public async listProviderStatuses(): Promise<Array<{ id: string; hasKey: boolean }>> {
    return this.providers.providerStatuses();
  }

  private async completePhase<T>(
    phases: RunPhaseState[],
    name: RunPhaseState["name"],
    request: RunRequest,
    task: () => Promise<T>
  ): Promise<T> {
    const phase = phases.find((item) => item.name === name);
    if (phase) {
      phase.status = "active";
      phase.startedAt = new Date().toISOString();
    }
    request.onActivity?.({
      phase: name,
      status: "started",
      message: phaseStartedMessage(name)
    });
    try {
      const result = await task();
      if (phase) {
        phase.status = "complete";
        phase.completedAt = new Date().toISOString();
      }
      request.onActivity?.({
        phase: name,
        status: "complete",
        message: phaseCompleteMessage(name)
      });
      return result;
    } catch (error) {
      if (phase) {
        phase.status = "failed";
        phase.summary = error instanceof Error ? error.message : String(error);
        phase.completedAt = new Date().toISOString();
      }
      request.onActivity?.({
        phase: name,
        status: "failed",
        message: phase?.summary ?? "Фаза завершилась ошибкой."
      });
      throw error;
    }
  }

  private markUnavailablePhases(phases: RunPhaseState[], mode: RunRequest["mode"]): void {
    for (const phase of phases) {
      if (phase.status !== "pending") {
        continue;
      }
      phase.status = "skipped";
      phase.summary = skippedPhaseSummary(phase.name, mode);
      phase.completedAt = new Date().toISOString();
    }
  }

  private async askConfiguredModel(request: RunRequest, projectMap: ProjectMap): Promise<ModelOutcome> {
    const provider = await this.providers.get(this.config.providers.defaultProvider);
    request.onActivity?.({
      phase: "Report",
      status: "progress",
      message: `Проверяю список моделей у ${provider.displayName}.`
    });
    const models = await provider.listModels();
    // Auto-tiering: рутина (ask) → routineModel, сложные задачи → complexModel.
    // Если специализированной модели нет — fallback на defaultModel.
    const tierModel = this.tierModelForMode(request.mode);
    const candidates = selectModelCandidates(tierModel, models);
    if (!candidates.length) {
      throw new Error(`No model configured for ${provider.displayName}.`);
    }

    let lastError: unknown;
    const tried = new Set<string>();
    const queue = [...candidates];
    for (let index = 0; index < queue.length; index += 1) {
      const model = queue[index]!;
      if (tried.has(model)) {
        continue;
      }
      tried.add(model);
      try {
        if (this.preflightProbe) {
          request.onActivity?.({
            phase: "Report",
            status: "progress",
            message: `Preflight-проверка модели ${model}…`
          });
          const probeResult = await this.preflightProbe.probe(provider, model, request.signal);
          if (!probeResult.alive || !probeResult.respondsText) {
            throw new Error(`Модель "${model}" не прошла preflight-проверку: ${probeResult.error || "Модель не ответила на тестовый запрос"}.`);
          }
        }

        request.onActivity?.({
          phase: "Report",
          status: "progress",
          message: `Отправляю запрос в ${provider.displayName}: ${model}.`
        });
        // Этап 2: если есть dispatcher и выбранная модель умеет tools — крутит
        // tool-loop (read/patch/gradle + авто-build + diagnose). Иначе старый
        // одноразовый chat. Проверка capabilities.tools защищает от посылки
        // tools-схем моделям, которые их не поддерживают (QwQ, deepseek-r1...).
        // Этап 3/4: loop также включается, если подключён хотя бы один MCP-bridge
        // (blockbench.* и/или minecraft.*) — тогда в схему попадают их
        // инструменты (resolveToolLoopNames итерирует по this.bridges).
        const modelMeta = models.find((item) => item.id === model);
        const toolsAvailable = Boolean(this.dispatcher)
          && Boolean(modelMeta?.capabilities.tools)
          && (TOOL_LOOP_TOOLS.some((name) => this.isToolRegistered(name))
            || this.bridges.some((bridge) => bridge.isConnected()));
        // Фаза 1 (P1.3): инструменты доступны, но выбранная модель их не тянет —
        // НЕ молчим (capability-резолвер): явно сообщаем вместо тихого fallback.
        const toolsRegistered = Boolean(this.dispatcher)
          && (TOOL_LOOP_TOOLS.some((name) => this.isToolRegistered(name))
            || this.bridges.some((bridge) => bridge.isConnected()));
        if (toolsRegistered && !modelMeta?.capabilities.tools) {
          request.onActivity?.({
            phase: "Report",
            status: "progress",
            message: `Внимание: модель ${model} не поддерживает инструменты (tools). Отвечаю обычным chat без tool-loop. Для полноценной работы выберите модель с поддержкой tools.`
          });
        }
        const toolCalls: ToolCallTrace[] = [];
        if (toolsAvailable) {
          request.onActivity?.({
            phase: "Report",
            status: "progress",
            message: `Модель ${model} поддерживает tools: включаю tool-loop.`
          });
        }
        const response = toolsAvailable
          ? await this.runToolLoop(request, projectMap, provider, model, models, toolCalls)
          : await this.singleChat(request, projectMap, provider, model, models);

        // Пустой ответ = нет ни текста, ни tool-call'ов. Ловим только на самом
        // первом шаге loop'а: внутри loop пустой content с tool_calls — норма.
        // ФИКС: если finish_reason: length — модель обрезана по maxTokens.
        // НЕ переключаемся на другую модель — возвращаем то что есть с пометкой.
        if (!response.content.trim() && !response.toolCalls?.length) {
          const finishReason = extractFinishReason(response.raw);
          if (finishReason === "length") {
            request.onActivity?.({
              phase: "Report",
              status: "progress",
              message: `Модель ${model} достигла лимита токенов (finish_reason: length). Увеличь maxTokens или упрости задачу.`
            });
            // Возвращаем пустой ответ с пояснением — НЕ переключаем модель.
            return {
              summary: `Модель ${model} достигла лимита токенов (finish_reason: length). Попробуй упростить задачу или разбить на части.`,
              toolCalls: toolCalls.length ? toolCalls : undefined
            };
          }
          lastError = new Error(`${provider.displayName} returned an empty response for ${model}. ${describeRawResponseShape(response.raw)}`);
          request.onActivity?.({
            phase: "Report",
            status: "progress",
            message: `Модель ${model} вернула ответ без текста (${describeRawResponseShape(response.raw)}). Пробую следующий вариант.`
          });
          continue;
        }
        const fallbackNote = model !== candidates[0]
          ? `\n\nMineAgent автоматически переключился на доступную модель: ${model}.`
          : "";
        request.onActivity?.({
          phase: "Report",
          status: "complete",
          message: `${provider.displayName} ответил. Готовлю сообщение в чат.`
        });
        // Стоп-предложение появляется ТОЛЬКО после завершения ответа модели,
        // не прерывая его (правило из roadmap.md). Если лимит превышен и юзер
        // ещё не скрыл уведомление — шлём событие tokenBudgetExceeded.
        this.emitBudgetCheckIfExceeded(request);
        return {
          summary: `${response.content}${fallbackNote}`,
          toolCalls: toolCalls.length ? toolCalls : undefined
        };
      } catch (error) {
        lastError = error;
        // 408 timeout от Cloudflare — reasoning-модель не успела за лимит времени.
        // НЕ падаем, НЕ переключаем модель — возвращаем понятное сообщение.
        if (error instanceof ProviderRequestError && error.status === 408) {
          request.onActivity?.({
            phase: "Report",
            status: "progress",
            message: `Модель ${model} превысила время ожидания (408). Reasoning-модели могут долго думать. Попробуй упростить задачу.`
          });
          return {
            summary: `Модель ${model} превысила время ожидания Cloudflare (408 timeout). Reasoning-модели (GLM 5.2, Kimi K2.7) могут долго думать. Попробуй:\n1. Упростить задачу (разбить на части)\n2. Использовать более быструю модель (GLM 4.7 Flash)\n3. Уменьшить режим на "ask" вместо "build"`
          };
        }
        if (!(error instanceof ProviderRequestError) || !error.isModelNotFound()) {
          throw error;
        }
        request.onActivity?.({
          phase: "Report",
          status: "progress",
          message: `Модель ${model} недоступна. Пробую следующий вариант из списка провайдера.`
        });
        const replacement = error.suggestedReplacementModel();
        if (replacement && !tried.has(replacement)) {
          request.onActivity?.({
            phase: "Report",
            status: "progress",
            message: `Провайдер предложил замену: ${replacement}. Пробую ее следующим запросом.`
          });
          queue.splice(index + 1, 0, replacement);
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  // Результат обращения к модели: итоговый текст + след tool-call'ов.

  // Одноразовый chat без tools — legacy/обратная-совместимость путь (когда
  // dispatcher не передан или модель не умеет tools). Существующие тесты
  // orchestrator'а идут именно сюда.
  private async singleChat(
    request: RunRequest,
    projectMap: ProjectMap,
    provider: ProviderAdapter,
    model: string,
    models: ProviderModel[]
  ): Promise<ChatResponse> {
    const chatRequest: ChatRequest = {
      model,
      temperature: 0.2,
      maxTokens: this.resolveMaxTokens(request.mode, Boolean(models.find((m) => m.id === model)?.capabilities.reasoning), this.config.providers.defaultProvider),
      messages: createChatMessages(request, projectMap),
      reasoning_effort: this.resolveReasoningEffort(Boolean(models.find((m) => m.id === model)?.capabilities.reasoning)),
      signal: request.signal
    };
    const response = await provider.chat(chatRequest);
    const modelPricing = this.lookupPricing(models, model);
    this.recordTokenUsage(request, response, model, modelPricing, chatRequest);
    return response;
  }

  // Этап 2, пункт 1: tool-loop «модель → tool_call → результат → модель».
  // Пункты 2 и 3 — внутри executeToolCall (авто gradle.run после repo.patch +
  // diagnose-loop при exitCode !== 0).
  //
  // Токен-экономия: messages append-only, system+user НЕ пересоздаются между
  // итерациями → prefix-cache friendly. Tools-схемы статичны весь loop.
  private async runToolLoop(
    request: RunRequest,
    projectMap: ProjectMap,
    provider: ProviderAdapter,
    model: string,
    models: ProviderModel[],
    trace: ToolCallTrace[]
  ): Promise<ChatResponse> {
    // Потолок безопасности (анти-runaway), НЕ продуктивный лимит. Цикл идёт,
    // пока модель делает прогресс; остановка — по завершению задачи, по
    // зацикливанию или по токен-бюджету. Жёсткого «5 итераций» больше нет.
    const safetyCeiling = this.resolveMaxToolIterations();
    const baseMessages = createChatMessages(request, projectMap);
    // Этап 3: blockbench.*-инструменты добавляются в схему ТОЛЬКО когда bridge
    // подключён. Без подключения — набор остаётся базовым (repo/gradle), что
    // экономит токены (правило «не жечь токены»).
    const toolNames = this.resolveToolLoopNames();
    const tools = buildToolSchemas(toolNames);
    const modelPricing = this.lookupPricing(models, model);
    // Диагностические итерации учитаются отдельно и внутри общего лимита
    // (диагноз не должен бесконечно плодить round-trip'ов).
    let diagnoseIterations = 0;
    const maxDiagnose = this.resolveMaxDiagnoseIterations();
    let lastResponse: ChatResponse | undefined;
    // Анти-зацикливание (экономия): запоминаем сигнатуры шагов (имена+аргументы
    // tool-вызовов). Если модель повторяет ТОТ ЖЕ набор вызовов подряд — она не
    // прогрессирует, прекращаем и просим финальный ответ, не жжём токены впустую.
    const recentSignatures: string[] = [];
    let stopReason: "loop" | "budget" | "ceiling" | undefined;
    let iteration = 0;

    for (; iteration < safetyCeiling; iteration += 1) {
      // Экономия: если токен-бюджет сессии уже превышен — не начинаем новый
      // дорогой round-trip, переходим к финализации по тому, что уже собрано.
      if (this.tokenBudget?.checkAfterResponse().snapshot.exceeded) {
        stopReason = "budget";
        break;
      }
      // Адаптивный maxTokens: reasoning-модели (GLM 5.2, Kimi K2.7) генерируют
      // скрытый reasoning_content который сжирает max_tokens. Нужно 16384+.
      // Проверяем capabilities.reasoning из метаданных модели.
      const modelMeta = models.find((m) => m.id === model);
      const isReasoning = Boolean(modelMeta?.capabilities.reasoning);
      const chatRequest: ChatRequest = {
        model,
        temperature: 0.2,
        maxTokens: this.resolveMaxTokens(request.mode, isReasoning, this.config.providers.defaultProvider),
        messages: baseMessages,
        tools,
        reasoning_effort: this.resolveReasoningEffort(isReasoning),
        signal: request.signal
      };
      const response = await provider.chat(chatRequest);
      this.recordTokenUsage(request, response, model, modelPricing, chatRequest);
      lastResponse = response;

      // Этап 5: показываем reasoning_content (chain-of-thought) reasoning-моделей
      // в activity-ленте, чтобы пользователь видел ход мыслей модели. Шлём полный
      // текст — webview рендерит его последовательно, не обрезаем на 500 символов.
      if (response.reasoningContent) {
        request.onActivity?.({
          phase: "Report",
          status: "progress",
          message: "Модель размышляет…",
          reasoningContent: response.reasoningContent
        });
      }

      // Нет tool_calls → модель дала финальный текстовый ответ, выходим.
      const calls = response.toolCalls;
      if (!calls || !calls.length) {
        return response;
      }

      request.onActivity?.({
        phase: "Report",
        status: "progress",
        message: `Tool-loop: шаг ${iteration + 1} (${calls.length} вызов(ов)).`,
        toolLoopIteration: iteration + 1
      });

      // Анти-зацикливание: сигнатура шага = отсортированные имя+аргументы всех
      // вызовов. Два одинаковых шага подряд = модель «тупит», прекращаем.
      const signature = calls
        .map((c) => `${c.name}:${c.arguments ?? ""}`)
        .sort()
        .join("|");
      recentSignatures.push(signature);
      if (recentSignatures.length > 3) {
        recentSignatures.shift();
      }
      const looping =
        recentSignatures.length >= 2 &&
        recentSignatures[recentSignatures.length - 1] === recentSignatures[recentSignatures.length - 2];

      // Фиксируем assistant-сообщение с tool_calls (обязательно между вызовом и
      // результатом по OpenAI-конвенции, иначе провайдер rejectedает диалог).
      baseMessages.push({
        role: "assistant",
        content: response.content,
        tool_calls: calls
      });

      // Исполняем все tool_calls текущего шага. Каждый результат — отдельное
      // role:"tool" сообщение с tool_call_id.
      for (const call of calls) {
        await this.executeToolCall(call, request, baseMessages, trace, () => {
          if (diagnoseIterations < maxDiagnose) {
            diagnoseIterations += 1;
            return true;
          }
          return false;
        });
      }

      if (looping) {
        stopReason = "loop";
        iteration += 1;
        break;
      }
    }
    if (!stopReason) {
      stopReason = "ceiling";
    }

    // FIX (forced finalization): цикл tool-вызовов остановлен (задача собрана,
    // обнаружено зацикливание, исчерпан токен-бюджет или достигнут потолок
    // безопасности) без текстового ответа. Tool-greedy reasoning-модели
    // (kimi/glm/minimax) склонны бесконечно звать инструменты и не давать ответ.
    // Делаем ОДИН запрос с tool_choice "none", чтобы модель обязана была
    // остановиться и ответить по уже собранному контексту.
    const stopLabel =
      stopReason === "loop"
        ? "повтор шагов (зацикливание)"
        : stopReason === "budget"
          ? "токен-бюджет сессии"
          : `потолок безопасности (${safetyCeiling})`;
    request.onActivity?.({
      phase: "Report",
      status: "progress",
      message: `Завершаю tool-loop: ${stopLabel}. Прошу финальный ответ.`
    });
    baseMessages.push({
      role: "user",
      content:
        "You have reached the tool-call budget. Do NOT call any more tools. " +
        "Based strictly on the information you have already gathered, give your final answer now."
    });
    try {
      const finalRequest: ChatRequest = {
        model,
        temperature: 0.2,
        maxTokens: this.resolveMaxTokens(request.mode, true, this.config.providers.defaultProvider),
        messages: baseMessages,
        // tool_choice:"none" → схемы инструментов модели уже не нужны. НЕ шлём
        // их повторно: при подключённом Blockbench это ~94 схемы (десятки тысяч
        // токенов) на запрос, который ими не воспользуется. Правило «не жечь токены».
        tool_choice: "none",
        signal: request.signal
      };
      const finalResponse = await provider.chat(finalRequest);
      // Учитываем расход финального запроса в бюджете сессии (раньше не учитывался).
      this.recordTokenUsage(request, finalResponse, model, modelPricing, finalRequest);
      if (finalResponse.content && finalResponse.content.trim()) {
        return {
          id: finalResponse.id,
          model,
          content: finalResponse.content,
          raw: finalResponse.raw,
          usage: finalResponse.usage
        };
      }
      lastResponse = finalResponse;
    } catch {
      // fall through to the note below
    }

    const note =
      lastResponse && lastResponse.content.trim()
        ? lastResponse.content
        : `I reached the tool-loop limit (${stopLabel}) before finishing. Ask me to continue if needed.`;
    return {
      id: lastResponse?.id,
      model,
      content: note,
      raw: lastResponse?.raw,
      usage: lastResponse?.usage
    };
  }

  // Исполняет один tool_call: dispatch через ApprovalGate (read-only без
  // модалки, write/command — с approval). Реализует пункты 2 и 3 задачи:
  //  - после repo.patch (accepted=true) → авто gradle.run;
  //  - после gradle.run (exitCode !== 0) → parseMinecraftLog + диагноз в модель.
  // deny/ошибка handler'а НЕ прерывают loop — модель видит отказ и реагирует.
  private async executeToolCall(
    call: ToolCall,
    request: RunRequest,
    messages: ChatMessage[],
    trace: ToolCallTrace[],
    allowDiagnose: () => boolean
  ): Promise<void> {
    const input = safeParseArgs(call.arguments);
    request.onActivity?.({
      phase: "Report",
      status: "progress",
      message: `Выполняю tool: ${describeToolCall(call.name, input)}.`
    });
    let result: unknown;
    let errorMessage: string | undefined;
    try {
      result = await this.dispatcher!.dispatch(call.name, input, describeToolCall(call.name, input));
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
      result = { error: errorMessage };
    }
    // Этап 5: NormalizedToolResult может содержать images[] (base64 PNG из
    // blockbench.render / minecraft.screenshot). JSON.stringify(result) в
    // role:"tool" убил бы base64 и раздул контекст. Решение: в role:"tool"
    // кладём текстовую часть (text + isError), а images поднимаем в trace
    // для vision-фазы. Текст-модели видят "рендер получен (image сохранён)",
    // vision-модели получают image-блоки отдельно.
    const toolImages = extractToolImages(result);
    const toolText = stripToolImages(result);
    messages.push({
      role: "tool",
      tool_call_id: call.id,
      name: call.name,
      content: JSON.stringify(toolText)
    });
    const entry: ToolCallTrace = { name: call.name, input, result, error: errorMessage, images: toolImages };
    trace.push(entry);

    // Этап 5: vision-чекпойнт — после blockbench.render / minecraft.screenshot
    // (или других tool'ов из config.agent.visionTriggers), если результат
    // содержит images[] и visionEvaluator передан. НЕ на каждой итерации —
    // только на чекпойнтах дизайна (правило «не жечь токены»).
    if (toolImages?.length && this.visionEvaluator && this.isVisionTrigger(call.name)) {
      await this.runVisionCheckpoint(call.name, toolImages, request);
    }

    // Пункт 2: авто gradle.run после успешного repo.patch.
    if (call.name === "repo.patch" && isAccepted(result)) {
      await this.runAutoBuildAfterPatch(request, messages, entry);
    }

    // Пункт 3: diagnose-loop после неудачной gradle.run (включая авто-build).
    if (call.name === "gradle.run" && isFailedBuild(result) && allowDiagnose()) {
      this.feedDiagnoseMessage(result as CommandEvidence, messages);
      request.onActivity?.({
        phase: "Report",
        status: "progress",
        message: `Gradle упал (exit ${String((result as CommandEvidence).exitCode)}): кормлю ошибку обратно в модель.`
      });
    }
  }

  // Пункт 2: автоматически запускает gradle.run после принятого repo.patch.
  // Результат подмешивается в диалог как role:"tool" (синтетический id), чтобы
  // модель сразу видела статус сборки. Это и есть «написал → собрал» из roadmap.
  private async runAutoBuildAfterPatch(
    request: RunRequest,
    messages: ChatMessage[],
    entry: ToolCallTrace
  ): Promise<void> {
    const task = this.config.minecraft.gradleBuildTask;
    request.onActivity?.({
      phase: "Report",
      status: "progress",
      message: `Patch принят: автоматически запускаю Gradle ${task}.`
    });
    entry.autoBuildTriggered = true;
    let buildResult: unknown;
    let buildError: string | undefined;
    try {
      buildResult = await this.dispatcher!.dispatch("gradle.run", { task }, `Авто-build после patch (${task})`);
    } catch (error) {
      buildError = error instanceof Error ? error.message : String(error);
      buildResult = { error: buildError };
    }
    messages.push({
      role: "tool",
      tool_call_id: `autobuild-${Date.now().toString(36)}`,
      name: "gradle.run",
      content: JSON.stringify(buildResult)
    });
    if (isCommandEvidence(buildResult)) {
      entry.autoBuildExitCode = buildResult.exitCode;
    }
    // Пункт 3 срабатывает и для авто-build: при падении кормим диагноз в модель.
    // Диагностический лимит проверяется вызывающим кодом (executeToolCall),
    // здесь лишь формируем сообщение. Чтобы не дублировать лимит-логику,
    // diagnose для авто-build ставим безусловно — он учтён в общем maxIterations.
    if (isFailedBuild(buildResult)) {
      this.feedDiagnoseMessage(buildResult as CommandEvidence, messages);
    }
  }

  // Пункт 3: парсит лог неудачной сборки и кладёт компактный summary обратно в
  // диалог как role:"tool". parseMinecraftLog уже умеет извлекать fatalLines,
  // exceptions и likelyCause (см. logParser.ts) — модель получает выжимку, а не
  // весь stderr, что экономит токены.
  private feedDiagnoseMessage(evidence: CommandEvidence, messages: ChatMessage[]): void {
    const summary: ParsedLogSummary = parseMinecraftLog(`${evidence.stderr}\n${evidence.stdout}`);
    messages.push({
      role: "tool",
      tool_call_id: `diagnose-${Date.now().toString(36)}`,
      name: "diagnose",
      content: JSON.stringify(summary)
    });
  }

  private isToolRegistered(name: string): boolean {
    // Dispatcher не экспонирует registry, но findContract/contractFor доступны.
    return Boolean(this.dispatcher?.contractFor(name));
  }

  // Этап 3/4: собирает имена tools для tool-loop. Базовый набор TOOL_LOOP_TOOLS
  // + инструменты всех подключённых MCP-bridge'ей (blockbench.*, minecraft.*).
  // Порядок: сначала базовый (prefix-cache-friendly), затем в порядке массива
  // bridges — чтобы при отсутствии подключений wire-формат запроса был идентичен
  // Этапу 2. Префиксы имён (blockbench. / minecraft.) исключают коллизии между
  // мостами; дополнительная проверка contractFor — защита от рассинхрона
  // bridge↔registry.
  private resolveToolLoopNames(): string[] {
    const names = [...TOOL_LOOP_TOOLS];
    for (const bridge of this.bridges) {
      if (!bridge.isConnected()) {
        continue;
      }
      for (const name of bridge.listRegisteredToolNames()) {
        if (this.dispatcher?.contractFor(name)) {
          names.push(name);
        }
      }
    }
    return names;
  }

  private resolveMaxToolIterations(): number {
    const value = this.config.agent.maxToolIterations;
    // Это ПОТОЛОК БЕЗОПАСНОСТИ (анти-runaway), а не продуктивный лимит. Реальная
    // остановка — по завершению задачи, зацикливанию или токен-бюджету. Дефолт
    // высокий (100), чтобы длинные build-задачи (модель из десятков костей/кубов)
    // доводились до конца. Явно заданный в конфиге меньший потолок уважается.
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 100;
  }

  // Адаптивный maxTokens: reasoning-модели генерируют скрытый reasoning_content
  // который сжирает max_tokens budget. Cloudflare обрывает долгие запросы (408),
  // поэтому для Cloudflare caps ниже. Другие провайдеры (WaveSpeed, OpenAI,
  // Fireworks) не имеют 408-constraint — можно дать больше пространства.
  private resolveMaxTokens(mode: RunRequest["mode"], isReasoning: boolean, providerId?: string): number {
    const isCloudflare = providerId === "cloudflare";
    if (isReasoning) {
      // Cloudflare: 12288 для reasoning (~8k reasoning + ~4k ответ), больше = 408.
      // Не-Cloudflare: 24576 — reasoning-модели на WaveSpeed/OpenAI не имеют 408.
      if (isCloudflare) {
        return mode === "build" ? 12288 : 6144;
      }
      return mode === "build" ? 24576 : 8192;
    }
    return mode === "build" ? 6144 : 3072;
  }

  // Фаза 1 (P1.5): reasoning_effort шлём ТОЛЬКО reasoning-моделям и только
  // если задан в конфиге. Иначе undefined → не сериализуется (безопасно).
  private resolveReasoningEffort(isReasoning: boolean): "low" | "medium" | "high" | undefined {
    if (!isReasoning) {
      return undefined;
    }
    return this.config.agent.reasoningEffort;
  }

  private resolveMaxDiagnoseIterations(): number {
    const value = this.config.agent.maxDiagnoseIterations;
    return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 2;
  }

  // Этап 5: проверяет, является ли tool-name триггером vision-оценки.
  // Триггеры задаются в config.agent.visionTriggers (имена tool'ов).
  private isVisionTrigger(toolName: string): boolean {
    const triggers = this.config.agent.visionTriggers ?? [];
    return triggers.includes(toolName);
  }

  // Этап 5: vision-чекпойнт — оценивает images[] через vision-модель.
  // Эмитит activity-событие с вердиктом (для UI-индикатора). НЕ блокирует
  // tool-loop — модель видит текстовый результат, vision идёт параллельно
  // как оценка качества.
  private async runVisionCheckpoint(
    sourceTool: string,
    images: Array<{ data: string; mimeType: string }>,
    request: RunRequest
  ): Promise<void> {
    if (!this.visionEvaluator) {
      return;
    }
    request.onActivity?.({
      phase: "Report",
      status: "progress",
      message: `Vision-оценка: анализирую артефакт от ${sourceTool} (${images.length} изображений).`
    });
    try {
      const verdict = await this.visionEvaluator.evaluate({
        images,
        taskDescription: `Оцени артефакт от tool'а ${sourceTool}. Модель видна? Эффект выглядит как задумано?`,
        sourceTool
      });
      request.onActivity?.({
        phase: "Report",
        status: "progress",
        message: `Vision-вердикт: ${verdict.matches ? "соответствует" : "не соответствует"} (confidence ${verdict.confidence.toFixed(2)}).`,
        visionVerdict: {
          matches: verdict.matches,
          confidence: verdict.confidence,
          notes: verdict.notes,
          model: verdict.model,
          sourceTool
        }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      request.onActivity?.({
        phase: "Report",
        status: "progress",
        message: `Vision-оценка не удалась: ${message}`
      });
    }
  }

  // Этап 5: critic-чекпойнт — оценивает артефакт (patch/код) через critic-модель.
  // Эмитит activity-событие с вердиктом + action (apply/ask-user). При
  // разногласии UI показывает модалку с обоими мнениями.
  public async runCriticCheckpoint(
    taskDescription: string,
    artifact: string,
    mode: "code" | "design" | "vision",
    mainApproved: boolean,
    projectMap: ProjectMap,
    request: RunRequest
  ): Promise<CriticVerdict | undefined> {
    if (!this.criticRunner || this.config.agent.criticMode === "off") {
      return undefined;
    }
    request.onActivity?.({
      phase: "Report",
      status: "progress",
      message: `Critic: оцениваю артефакт (режим ${mode}).`
    });
    try {
      const verdict = await this.criticRunner.evaluate({
        projectMap,
        taskDescription,
        artifact,
        mode
      });
      const action = resolveConsensus(mainApproved, verdict);
      request.onActivity?.({
        phase: "Report",
        status: "progress",
        message: action === "apply"
          ? `Critic: консенсус — применяю.`
          : verdict.isSelfCritique
            ? `Critic: ${verdict.verdict} (self-critique, объективность ниже).`
            : `Critic: ${verdict.verdict} — нужно решение пользователя.`,
        criticVerdict: {
          verdict: verdict.verdict,
          reasoning: verdict.reasoning,
          model: verdict.model,
          isSelfCritique: verdict.isSelfCritique,
          mainApproved,
          action
        }
      });
      return verdict;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      request.onActivity?.({
        phase: "Report",
        status: "progress",
        message: `Critic-оценка не удалась: ${message}`
      });
      return undefined;
    }
  }

  // Записывает потребление токенов в бюджет сессии. Если провайдер отдал
  // реальные цифры usage — используем их. Иначе оцениваем по chars/4.
  // Этап 5: visionCalls инкрементируется когда в запросе были image-блоки.
  private recordTokenUsage(request: RunRequest, response: ChatResponse, model: string, pricing?: ModelPricing, chatRequest?: ChatRequest): void {
    if (!this.tokenBudget) {
      return;
    }
    // Этап 5: считаем vision-вызовы по наличию image-блоков в запросе.
    const visionCalls = chatRequest && hasImageBlocks(chatRequest.messages) ? 1 : 0;
    if (response.usage && (response.usage.inputTokens !== undefined || response.usage.outputTokens !== undefined)) {
      this.tokenBudget.record({
        inputTokens: response.usage.inputTokens ?? 0,
        outputTokens: response.usage.outputTokens ?? 0,
        visionCalls
      }, undefined, pricing);
      return;
    }
    // Оценка по эвристике chars/4. Input = система+user промт, output = ответ.
    // Этап 5: extractTextFromContent обрабатывает array-content (vision).
    const messages = createChatMessages(request, {} as ProjectMap);
    const inputText = messages.map((message) => extractTextFromContent(message.content)).join("\n");
    const estimated = {
      inputTokens: TokenBudgetService.estimateTokens(inputText),
      outputTokens: TokenBudgetService.estimateTokens(response.content),
      visionCalls
    };
    this.tokenBudget.record(undefined, estimated, pricing);
    void model;
  }

  // Находит pricing (нейроны за 1M токенов) модели по id из списка.
  private lookupPricing(models: ProviderModel[], modelId: string): ModelPricing | undefined {
    const model = models.find((m) => m.id === modelId);
    const caps = model?.capabilities;
    if (!caps) {
      return undefined;
    }
    return {
      neuronsPerMInput: caps.neuronsPerMInput,
      neuronsPerMOutput: caps.neuronsPerMOutput
    };
  }

  // Auto-tiering: выбирает модель под режим запроса.
  // - ask (вопросы/чтение) → routineModel (дешёвая, по умолчанию GLM 4.7 Flash)
  // - build/plan/playtest (код/архитектура) → complexModel (дорогая, Kimi K2.7 Code)
  // Fallback: если специализированная модель не задана — defaultModel.
  private tierModelForMode(mode: RunRequest["mode"]): string | undefined {
    const providers = this.config.providers;
    // Фаза 1 (P1.2): замок модели — auto-tiering выключен, отвечает только defaultModel.
    if (providers.lockModel) {
      return providers.defaultModel;
    }
    if (mode === "ask") {
      return providers.routineModel?.trim() || providers.defaultModel;
    }
    return providers.complexModel?.trim() || providers.defaultModel;
  }

  // Шлёт событие budgetExceeded через onActivity, если лимит превышен и юзер
  // ещё не скрыл уведомление. Вызывается строго ПОСЛЕ завершения ответа модели.
  private emitBudgetCheckIfExceeded(request: RunRequest): void {
    if (!this.tokenBudget) {
      return;
    }
    const check = this.tokenBudget.checkAfterResponse();
    if (!check.exceeded) {
      return;
    }
    request.onActivity?.({
      phase: "Report",
      status: "progress",
      message: `Превышен лимит токенов за сессию: ${check.snapshot.sessionUsed} из ${check.snapshot.sessionLimit}.`,
      budgetExceeded: check.snapshot
    });
  }
}

function describeRawResponseShape(raw: unknown): string {
  if (!raw || typeof raw !== "object") {
    return "Raw response is not an object.";
  }
  const record = raw as Record<string, unknown>;
  const keys = Object.keys(record).slice(0, 10);
  const firstChoice = Array.isArray(record.choices) ? record.choices[0] as Record<string, unknown> | undefined : undefined;
  const firstMessage = firstChoice?.message as Record<string, unknown> | undefined;
  const details = [
    `top-level keys: ${keys.join(", ") || "none"}`,
    firstChoice?.finish_reason ? `finish_reason: ${String(firstChoice.finish_reason)}` : undefined,
    firstMessage ? `message keys: ${Object.keys(firstMessage).join(", ") || "none"}` : undefined
  ].filter(Boolean);
  return details.join("; ");
}

// Извлекает finish_reason из raw-ответа провайдера.
// "length" = модель обрезана по maxTokens — НЕ ошибка модели.
function extractFinishReason(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const firstChoice = Array.isArray(record.choices) ? record.choices[0] as Record<string, unknown> | undefined : undefined;
  const finishReason = firstChoice?.finish_reason;
  return typeof finishReason === "string" ? finishReason : undefined;
}

function phaseStartedMessage(name: RunPhaseState["name"]): string {
  switch (name) {
    case "Understand":
      return "Индексирую проект: loader, версии, mod id, ресурсы и registries.";
    case "Build":
      return "Запускаю Gradle build и собираю evidence.";
    case "Report":
      return "Готовлю контекст проекта для выбранной модели.";
    default:
      return `Начинаю фазу ${name}.`;
  }
}

function phaseCompleteMessage(name: RunPhaseState["name"]): string {
  switch (name) {
    case "Understand":
      return "Карта проекта обновлена.";
    case "Build":
      return "Build завершен, evidence добавлен.";
    case "Report":
      return "Ответ модели получен.";
    default:
      return `Фаза ${name} завершена.`;
  }
}

function createChatMessages(request: RunRequest, projectMap: ProjectMap): ChatMessage[] {
  const modeInstructions = [
    instructionsForMode(request.mode),
    "If Research Ledger is present, treat it as user-reviewed source memory. Follow userNotes and rejected/accepted source status."
  ].join("\n");
  const workspaceRulesText = request.rules?.trim()
    ? `\n\n## Workspace Rules (AGENTS.md)\n${request.rules.trim()}`
    : "";
  const researchLedgerText = formatResearchLedger(request.researchLedger);
  // Фаза 1: блок памяти проекта идёт ПЕРВЫМ в пользовательском сообщении — это
  // долговременный контекст, на который модель опирается прежде всего.
  const memoryText = request.projectMemory?.trim()
    ? `${request.projectMemory.trim()}\n\n`
    : "";
  // Этап 6: skills + knowledge retrieval подмешиваются в system prompt.
  const skillsText = request.matchedSkills?.length
    ? `\n\n${request.matchedSkills.map((s) => `## Скилл: ${s.skill.name}\n${s.skill.content}`).join("\n\n")}`
    : "";
  const knowledgeText = request.matchedKnowledge?.length
    ? `\n\n## Knowledge Base (топ-${request.matchedKnowledge.length} релевантных записей)\n${request.matchedKnowledge.map((k) => `- [${k.entry.category}] ${k.entry.title ?? k.entry.url}: ${k.entry.summary}`).join("\n")}`
    : "";
  return [
    {
      role: "system" as const,
      content: [
        "Ты MineAgent — ассистент для разработки модов Minecraft Java Edition. Отвечай на русском.",
        "",
        "Формат ответа:",
        "- Пиши лаконично, обычным языком. Текст — абзацами, без разметки.",
        "- НЕ используй эмодзи, markdown-таблицы, заголовки (#), жирный (**), списки со звёздочками, если пользователь явно не попросил.",
        "- Не вставляй разделители (---) и не повторяй слова «Рекомендуемые следующие шаги».",
        "- Если уместно дать шаги — оформляй их нумерованным списком (1. 2. 3.), а не таблицей.",
        "- Не пересказывай карту проекта обратно пользователю — он её видит в UI. Если что-то важно, упомяни одним предложением.",
        "",
        "Содержание:",
        "- Не выдумывай Minecraft API, сигнатуры методов, имена классов или поведение движка. Если не уверен — честно скажи, что нужно проверить в источниках (Forge/Fabric/NeoForge docs, mappings, исходники).",
        "- Не копируй защищённые имена, лор, ассеты, текстуры, звуки или логотипы из существующих IP. Делай оригинальный дизайн.",
        "- Если данных о проекте не хватает — задай 1-2 коротких вопроса, не пиши длинных вводных.",
        "",
        modeInstructions,
        workspaceRulesText,
        skillsText,
        knowledgeText
      ].join("\n")
    },
    {
      role: "user" as const,
      content: [
        memoryText,
        `Запрос пользователя: ${request.prompt}`,
        `Режим MineAgent: ${request.mode}`,
        "",
        "Карта проекта:",
        "Research Ledger:",
        researchLedgerText,
        "",
        "Project Map JSON:",
        JSON.stringify({
          loader: projectMap.loader,
          minecraftVersion: projectMap.minecraftVersion,
          javaVersion: projectMap.javaVersion,
          mainModId: projectMap.mainModId,
          gradleTasks: projectMap.gradleTasks,
          registries: projectMap.registries.slice(0, 30),
          eventHandlers: projectMap.eventHandlers.slice(0, 30),
          networkPackets: projectMap.networkPackets.slice(0, 30),
          clientOnlyClasses: projectMap.clientOnlyClasses.slice(0, 30),
          resources: projectMap.resources,
          mixins: projectMap.mixins,
          architectureHints: projectMap.architectureHints
        }, null, 2)
      ].join("\n")
    }
  ];
}

function formatResearchLedger(ledger: ResearchLedger | undefined): string {
  if (!ledger) {
    return "No reviewed web/source research ledger is available yet.";
  }
  return JSON.stringify({
    topic: ledger.topic,
    status: ledger.status,
    userNotes: ledger.userNotes,
    sources: ledger.sources.map((source) => ({
      url: source.url,
      title: source.title,
      status: source.status,
      summary: source.summary,
      learned: source.learned,
      usedFor: source.usedFor
    }))
  }, null, 2);
}

function modelPhaseForMode(mode: RunRequest["mode"]): RunPhaseState["name"] {
  switch (mode) {
    case "plan":
      return "Research";
    case "build":
      return "Patch";
    case "ask":
    case "playtest":
      return "Report";
  }
}

function instructionsForMode(mode: RunRequest["mode"]): string {
  switch (mode) {
    case "plan":
      return [
        "Режим PLAN: не пиши patch.",
        "Дай короткий план реализации: файлы, классы, registry/resources, риски compile и evidence, который нужно собрать."
      ].join("\n");
    case "build":
      return [
        "Режим BUILD: сформируй готовый к применению patch для текущего Forge/Fabric/NeoForge проекта.",
        "Формат ответа: 1) PATCH PLAN до 6 пунктов; 2) FILES список путей; 3) UNIFIED DIFF в markdown code block `diff`.",
        "Не выдумывай API. Если нужен непроверенный API, оставь это в PATCH PLAN как проверку, а не в коде."
      ].join("\n");
    case "playtest":
      return "Режим PLAYTEST: после build evidence объясни, что проверить в dev world и какие логи/скриншоты собрать.";
    case "ask":
      return "Режим ASK: ответь конкретно, но не формируй patch без прямой просьбы.";
  }
}

// ФИКС: когда пользователь явно выбрал модель — она единственный кандидат.
// Preferred-список (kimi/code/deepseek) добавлялся ВСЕГДА, из-за чего при
// пустом ответе GLM происходил fallback на Kimi. Теперь preferred добавляется
// ТОЛЬКО если configuredModel не задан (auto-режим при холодном старте).
function selectModelCandidates(configuredModel: string | undefined, models: ProviderModel[]): string[] {
  const ids = models.map((model) => model.id).filter(Boolean);
  // Если модель выбрана явно — только она + fallback на model-not-found.
  if (configuredModel?.trim()) {
    return [configuredModel.trim()]; // ВЫБОР МОДЕЛИ СВЯЩЕНЕН: при явной модели — ровно один кандидат, без тихого фоллбэка на чужие модели.
  }
  // Нет явного выбора — preferred + все остальные.
  const preferred = ids.filter((id) => /kimi|code|coder|deepseek|qwen/i.test(id));
  return unique([...preferred, ...ids].filter((id): id is string => Boolean(id)));
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

// Безопасный разбор arguments tool-call'а. Провайдер нормализует arguments к
// строке (OpenAI) или объекту (Cloudflare native) — здесь всегда строка после
// normalizeArguments, но страхуемся от мусора.
function safeParseArgs(argumentsJson: string): unknown {
  if (!argumentsJson) {
    return {};
  }
  try {
    return JSON.parse(argumentsJson);
  } catch {
    return { _raw: argumentsJson };
  }
}

// Человекочитаемое описание tool-call'а для модалки ApprovalGate и activity-ленты.
// Показывает конкретные аргументы (путь файла, gradle task), чтобы пользователь
// видел что именно делает модель, а не просто имя tool'а.
function describeToolCall(name: string, input: unknown): string {
  const record = input as Record<string, unknown> | null;
  switch (name) {
    case "repo.read":
      return `Чтение файла: ${String(record?.path ?? "?")}`;
    case "repo.patch":
      return "Применение patch (unified diff)";
    case "gradle.run":
      return `Gradle task: ${String(record?.task ?? "build")}`;
    case "knowledge.search":
      return `Поиск по Knowledge Base: ${String(record?.query ?? record?.topic ?? "?")}`;
    default:
      // Этап 3/4: динамические инструменты MCP-bridge'ей. Контракт (risk) dispatcher
      // определит сам; здесь — человекочитаемая подпись для модалки/лога по префиксу.
      if (name.startsWith("blockbench.")) {
        const detail = name.slice("blockbench.".length);
        const arg = record ? Object.entries(record).slice(0, 2).map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`).join(", ") : "";
        return `Blockbench: ${detail}${arg ? ` (${arg})` : ""}`;
      }
      if (name.startsWith("minecraft.")) {
        // Этап 4: все minecraft.*-инструменты идут через approval (game-control).
        const detail = name.slice("minecraft.".length);
        const arg = record ? Object.entries(record).slice(0, 2).map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`).join(", ") : "";
        return `Minecraft dev bridge: ${detail}${arg ? ` (${arg})` : ""}`;
      }
      return `Tool: ${name}`;
  }
}

// repo.patch возвращает { accepted: boolean }. «Успех» = accepted=true.
function isAccepted(result: unknown): boolean {
  return Boolean((result as { accepted?: unknown } | null)?.accepted);
}

// Этап 5: извлекает images[] из NormalizedToolResult (если результат имеет
// такую форму). images = base64 PNG из blockbench.render / minecraft.screenshot.
function extractToolImages(result: unknown): Array<{ data: string; mimeType: string }> | undefined {
  const record = result as { images?: unknown } | null;
  const images = record?.images;
  if (!Array.isArray(images) || !images.length) {
    return undefined;
  }
  return images.filter(
    (img): img is { data: string; mimeType: string } =>
      typeof img === "object" && img !== null
      && typeof (img as { data?: unknown }).data === "string"
      && typeof (img as { mimeType?: unknown }).mimeType === "string"
  );
}

// Этап 5: убирает images[] из результата для role:"tool" — base64 не должен
// попадать в JSON.stringify (раздувает контекст, ломает prefix-cache).
// Возвращает копию result без поля images.
function stripToolImages(result: unknown): unknown {
  if (!result || typeof result !== "object") {
    return result;
  }
  const record = result as Record<string, unknown>;
  if (!("images" in record)) {
    return result;
  }
  const { images: _images, ...rest } = record;
  void _images;
  return rest;
}

// Команда/сборка упала, если exitCode — число и не 0. null (процесс не дошёл
// до close) тоже трактуем как неудачу для diagnose-loop.
function isFailedBuild(result: unknown): boolean {
  if (!isCommandEvidence(result)) {
    return false;
  }
  return result.exitCode !== 0;
}

function isCommandEvidence(value: unknown): value is CommandEvidence {
  const record = value as { exitCode?: unknown; stdout?: unknown; stderr?: unknown } | null;
  return Boolean(record)
    && (typeof record?.exitCode === "number" || record?.exitCode === null)
    && typeof record?.stdout === "string"
    && typeof record?.stderr === "string";
}

function createRunSummary(request: RunRequest, projectMap: ProjectMap): string {
  const facts = [
    projectMap.loader !== "unknown" ? projectMap.loader : "unknown loader",
    projectMap.minecraftVersion ? `MC ${projectMap.minecraftVersion}` : undefined,
    projectMap.javaVersion ? `Java ${projectMap.javaVersion}` : undefined,
    projectMap.mainModId ? `mod ${projectMap.mainModId}` : undefined
  ].filter(Boolean);

  const buildText = request.mode === "playtest"
    ? "Build был запущен как часть пробного прогона."
    : "Когда будешь готов собрать evidence команд, запусти Инструменты > Gradle build.";

  return `Индекс готов: ${facts.join(", ")}. Найдено registry: ${projectMap.registries.length}, event handlers: ${projectMap.eventHandlers.length}, mixin config: ${projectMap.mixins.length}. ${buildText}`;
}

function skippedPhaseSummary(name: RunPhaseState["name"], mode: RunRequest["mode"]): string {
  switch (name) {
    case "Research":
      return "Пропущено: нужен запрос и подтверждение на поиск источников.";
    case "Patch":
      return "Пропущено: этот запуск не создавал patch.";
    case "Build":
      return mode === "playtest" ? "Build не был достигнут." : "Пропущено вне режима пробного прогона.";
    case "Launch":
      return "Пропущено: запуск Minecraft client требует явного подтверждения.";
    case "Playtest":
      return "Пропущено: нужен dev world и путь сбора evidence.";
    case "Diagnose":
      return "Пропущено: нет failed build, crash log или playtest evidence.";
    case "Report":
      return "Пропущено: нет многошагового отчета для финализации.";
    case "Understand":
      return "Пропущено.";
  }
}
