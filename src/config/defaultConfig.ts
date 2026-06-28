import { DEFAULT_PHASES } from "../constants";
import type { MineAgentConfig } from "./types";

export const defaultMineAgentConfig: MineAgentConfig = {
  version: 1,
  providers: {
    defaultProvider: "custom",
    defaultModel: "kimi-k2.7",
    custom: {
      baseUrl: "https://llm.kimchi.dev/openai/v1",
      modelsEndpoint: "/models",
      chatEndpoint: "/chat/completions"
    },
    cloudflare: {
      accountId: ""
    },
    // Auto-tiering: рутина → дешёвая GLM 4.7 Flash, сложное → Kimi K2.7 Code.
    // Это экономит нейроны Cloudflare в ~15 раз на рутинных операциях.
    routineModel: "minimax-m2.7",
    complexModel: "kimi-k2.7",
    // Фаза 1 (P1.2): по умолчанию замок выключен — auto-tiering активен.
    lockModel: false
  },
  agent: {
    approvalMode: "ask",
    // Пусто по умолчанию — ничего не одобрено автоматически.
    autoApproveTools: [],
    evidenceRetentionDays: 14,
    defaultRunPhases: [...DEFAULT_PHASES],
    tokenLimit: 1_000_000,
    // Tool-loop: maxToolIterations — это ПОТОЛОК БЕЗОПАСНОСТИ (анти-runaway), а
    // НЕ продуктивный лимит. Цикл идёт пока модель прогрессирует; реальная
    // остановка — по завершению задачи, по зацикливанию (повтор тех же вызовов)
    // или по превышению токен-бюджета сессии. Высокий потолок (100) нужен, чтобы
    // длинные build-задачи (3D-модель из десятков костей/кубов) доводились до конца.
    maxToolIterations: 100,
    maxDiagnoseIterations: 3,
    // Этап 5: vision-модель по умолчанию — llama-4-scout (natively multimodal,
    // $0.27/M input, 131k context, tools support). См. docs/source-ledger.md entry-15.
    visionModel: "@cf/meta/llama-4-scout-17b-16e-instruct",
    // Этап 5: critic-модель — пусто = авто-выбор модели, отличной от main.
    criticModel: "",
    // Этап 5: critic по умолчанию = другая модель (не self-critique).
    criticMode: "other-model",
    // Этап 5: vision триггерится после render/screenshot — на чекпойнтах дизайна.
    visionTriggers: ["blockbench.render", "minecraft.screenshot"],
    // Этап 6: embeddings для Knowledge Base + Skills retrieval.
    // bge-m3 — multilingual (важно для русского проекта), см. entry-16 source-ledger.
    embeddingModel: "",
    // Этап 6 / Фаза 2 (P2.2): top-K записей Knowledge Base в контекст модели.
    // Включено по умолчанию — локальные embeddings (bge-m3) работают без провайдера.
    knowledgeTopK: 5,
    // Этап 6: top-K скиллов в system prompt.
    skillsTopK: 0,
    // Фаза 2 (P2.4/P2.5): бесплатный реальный поиск по умолчанию.
    webSearchMode: "free"
  },
  // Sub-агенты добавляет пользователь через UI. Пресеты — отдельной опцией позже.
  subAgents: [],
  minecraft: {
    gradleBuildTask: "build",
    runClientTask: "runClient",
    devBridgeEnabled: false
  },
  // Этап 3: Blockbench MCP-клиент. По умолчанию выключен — подключение инициируется
  // пользователем (через UI или config.mcp.blockbench.enabled=true). Дефолтный URL
  // соответствует blockbench-mcp-plugin (Settings → General → MCP Server Endpoint).
  mcp: {
    blockbench: {
      enabled: false,
      url: "http://localhost:3000/bb-mcp",
      timeoutMs: 60_000,
      connectPrompt: "ask"
    },
    // MCP-сервер MineAgent: выставляет оркестратор наружу. По умолчанию выключен.
    // Порт 3200 (не конфликтует с Blockbench 3000 и Minecraft 3100).
    server: {
      enabled: false,
      port: 3200,
      token: ""
    },
    // Этап 4: Minecraft Dev Bridge. По умолчанию выключен. URL совпадает с
    // BridgeConfig.DEFAULT_HOST/PORT/PATH мода (127.0.0.1:3100/mc-mcp). Токен
    // НЕ хранится в config — мод генерирует его при старте, расширение парсит
    // из лога (minecraftBridge.ts + logParser.ts) и держит только в памяти.
    minecraft: {
      enabled: false,
      url: "http://127.0.0.1:3100/mc-mcp",
      timeoutMs: 60_000,
      launchWaitMs: 90_000,
      launchPrompt: "ask"
    }
  },
  paths: {
    skills: ".mineagent/skills",
    referencePacks: ".mineagent/reference-packs",
    playtests: ".mineagent/playtests",
    runs: ".mineagent/runs",
    sessions: ".mineagent/sessions"
  }
};
