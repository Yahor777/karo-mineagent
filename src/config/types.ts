import type { RunPhaseName } from "../orchestrator/phases";
import type { SubAgentConfig } from "../agents/types";

export type ProviderId = "openai" | "anthropic" | "fireworks" | "cloudflare" | "wavespeed" | "kimchi" | "custom";
export type ApprovalMode = "ask" | "workspace" | "auto-readonly";

export interface MineAgentConfig {
  version: 1;
  providers: {
    defaultProvider: ProviderId;
    defaultModel: string;
    custom: {
      baseUrl: string;
      modelsEndpoint: string;
      chatEndpoint: string;
    };
    cloudflare: {
      accountId: string;
    };
    // Auto-tiering: рутина (чтение файлов, мелкие вопросы) идёт на дешёвую
    // модель, а сложные задачи (build/patch/plan) — на дорогую.
    // Пустая строка = используется defaultModel.
    routineModel: string;
    complexModel: string;
    // Фаза 1 (P1.2): замок модели — отключает auto-tiering; отвечает только
    // выбранная defaultModel. UI всегда показывает, какая модель отвечала.
    lockModel?: boolean;
  };
  agent: {
    approvalMode: ApprovalMode;
    // Whitelist scopeId (tool name или sub-agent id), одобренных через кнопку
    // «Всегда». Persistится в config.json. Позволяет снять approval в UI позже.
    autoApproveTools: string[];
    evidenceRetentionDays: number;
    defaultRunPhases: RunPhaseName[];
    // Лимит токенов за сессию. Стоп-предложение появляется только ПОСЛЕ ответа
    // модели, не прерывая выполняющийся запрос. 0 = без лимита.
    tokenLimit: number;
    // Этап 2 (Code-MCP): максимум итераций tool-loop «модель → tool → модель».
    // Предохранитель от зацикливания и пожара токенов.
    maxToolIterations: number;
    // Максимум итераций diagnose-loop внутри одной неудачной gradle.run:
    // parseMinecraftLog → ошибка обратно в модель → попытка починить.
    maxDiagnoseIterations: number;
    // Этап 5 (Vision + Critic): модель для vision-оценки артефактов (скринов,
    // рендеров). Пусто = авто-выбор vision-capable модели из каталога провайдера.
    visionModel: string;
    // Этап 5: модель для critic-оценки. Пусто = авто-выбор модели, отличной
    // от main (избегаем self-critique). Если = mainModel → self-critique с
    // UI-предупреждением «объективность ниже».
    criticModel: string;
    // Этап 5: режим critic. "other-model" = другая модель (по умолчанию),
    // "self" = та же модель (self-critique), "off" = critic выключен.
    criticMode: "other-model" | "self" | "off";
    // Этап 5: события, которые триггерят vision-оценку. Имена tool'ов или
    // фаз. Пустой массив = vision выключен. По умолчанию: blockbench.render,
    // minecraft.screenshot.
    visionTriggers: string[];
    // Этап 6: модель для embeddings (Knowledge Base + Skills retrieval).
    // Пусто = авто-выбор (@cf/baai/bge-m3 — multilingual, важно для русского).
    embeddingModel: string;
    // Этап 6: сколько записей Knowledge Base подмешивать в контекст модели
    // (top-K retrieval). 0 = retrieval выключен. По умолчанию 5.
    knowledgeTopK: number;
    // Этап 6: сколько скиллов подмешивать в system prompt (top-K matching).
    // 0 = skills retrieval выключен. По умолчанию 3.
    skillsTopK: number;
    // Фаза 1 (P1.5): reasoning effort для reasoning-моделей. Не задан = не шлём.
    reasoningEffort?: "low" | "medium" | "high";
    // Фаза 2 (P2.4/P2.5): режим веб-поиска. free = DuckDuckGo HTML (по умолчанию),
    // full = Firecrawl (ключ из окружения FIRECRAWL_API_KEY).
    webSearchMode?: "free" | "full";
  };
  // Конфиги sub-агентов. Пустой массив = нет sub-агентов. CRUD через UI.
  subAgents: SubAgentConfig[];
  minecraft: {
    gradleBuildTask: string;
    runClientTask: string;
    devBridgeEnabled: boolean;
  };
  // Этап 3 (Blockbench MCP-клиент): настройки подключения к живому Blockbench
  // через Model Context Protocol (Streamable HTTP). URL/порт настраиваются в
  // самом Blockbench (Settings → General → MCP Server Port/Endpoint); MineAgent
  // подключается к уже запущенному серверу, не запускает Blockbench.
  mcp: {
    blockbench: {
      enabled: boolean;
      url: string;
      // Таймаут одного JSON-RPC round-trip (60с, как у sub-агентов).
      timeoutMs: number;
      // Реакция на предложение подключиться при открытии воркбенча:
      // "ask" (по умолчанию) — спросить; "always" — подключать без вопроса;
      // "never" — больше не предлагать (кнопка «Больше не спрашивать»).
      connectPrompt?: "ask" | "always" | "never";
    };
    // MCP-сервер MineAgent: выставляет оркестратор наружу для внешних
    // MCP-клиентов (другие редакторы, CLI, AI-агенты). По умолчанию выключен.
    // Bearer-токен опционален; если задан — каждый запрос должен его нести.
    server: {
      enabled: boolean;
      port: number;
      // Bearer-токен для авторизации. Пусто = без авторизации (только localhost).
      token: string;
    };
    // Этап 4 (Minecraft Dev Bridge): MCP-сервер живёт ВНУТРИ dev-сборки мода
    // (mineagent-bridge). Lifecycle отличается от Blockbench: MineAgent сначала
    // запускает клиент (minecraft.runClient через gradle), мод поднимает
    // MCP-endpoint и печатает в лог токен, расширение парсит лог → wait endpoint
    // → connect. Порт 3100 (отличается от Blockbench 3000, оба живут одновременно).
    minecraft: {
      enabled: boolean;
      url: string;
      // Таймаут одного JSON-RPC round-trip (60с, как у Blockbench).
      timeoutMs: number;
      // Сколько ждать поднятия endpoint'а модом после runClient (dev-клиент
      // стартует десятки секунд — MC JVM + reload). Polling health-check.
      launchWaitMs: number;
      // Реакция на предложение запустить dev-клиент при попытке подключения,
      // когда endpoint ещё не поднят: "ask" (по умолчанию) — спросить и
      // запустить runClient с подтверждения; "always" — запускать без вопроса;
      // "never" — не предлагать запуск (кнопка «Больше не спрашивать»).
      launchPrompt?: "ask" | "always" | "never";
    };
  };
  paths: {
    skills: string;
    referencePacks: string;
    playtests: string;
    runs: string;
    sessions: string;
  };
}

export interface ResearchSource {
  url: string;
  title?: string;
  summary: string;
  learned: string;
  usedFor: string;
  status?: "candidate" | "accepted" | "rejected";
}

export interface ResearchLedger {
  topic: string;
  status: "draft" | "reviewed";
  sources: ResearchSource[];
  userNotes: string;
  lastUpdated: string | null;
}
