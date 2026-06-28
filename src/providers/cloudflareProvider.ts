import { OpenAICompatibleProvider, ProviderRequestError } from "./openaiCompatibleProvider";
import type {
  ChatRequest,
  ChatResponse,
  ProviderAdapter,
  ProviderModel,
  StreamChunk,
  TokenCount,
  ModelVendor,
  ModelCategory,
  ModelApiType,
  EmbeddingRequest,
  EmbeddingResponse
} from "./ProviderAdapter";

// Полный каталог моделей Cloudflare Workers AI (text-generation).
// Источник: developers.cloudflare.com/workers-ai/models/ (июнь 2026).
// Каждая модель помечена vendor (для группировки в UI) и category
// (flagship/reasoning/fast/vision — для подсказки пользователю).
// Модели absent на Cloudflare (Claude/Anthropic, xAI, MiniMax, Assembly,
// black-forest-labs text) сюда НЕ входят — их нет в Workers AI.
const cloudflareDefaultModels: ProviderModel[] = [
  // === Moonshot AI === frontier coding модели, самые дорогие в семье
  {
    id: "@cf/moonshotai/kimi-k2.7-code",
    label: "Kimi K2.7 Code",
    provider: "cloudflare",
    vendor: "moonshotai",
    category: "flagship",
    apiType: "text",
    capabilities: {
      contextWindow: 262144,
      vision: true,
      tools: true,
      jsonMode: true,
      reasoning: true,
      fixedContext: true,
      costHint: "high",
      codingQuality: "frontier",
      speed: "fast",
      neuronsPerMInput: 86364,
      neuronsPerMOutput: 363636
    }
  },
  {
    id: "@cf/moonshotai/kimi-k2.6",
    label: "Kimi K2.6",
    provider: "cloudflare",
    vendor: "moonshotai",
    category: "flagship",
    apiType: "text",
    capabilities: {
      contextWindow: 262144,
      vision: true,
      tools: true,
      jsonMode: true,
      reasoning: true,
      fixedContext: true,
      costHint: "high",
      codingQuality: "frontier",
      speed: "fast",
      neuronsPerMInput: 86364,
      neuronsPerMOutput: 363636
    }
  },

  // === Z.AI (Zhipu) === GLM-серия
  {
    id: "@cf/zai-org/glm-5.2",
    label: "GLM 5.2 (flagship coding)",
    provider: "cloudflare",
    vendor: "zai",
    category: "flagship",
    apiType: "text",
    capabilities: {
      contextWindow: 262144,
      vision: false,
      tools: true,
      jsonMode: true,
      reasoning: true,
      fixedContext: true,
      costHint: "high",
      codingQuality: "frontier",
      speed: "medium",
      neuronsPerMInput: 127273,
      neuronsPerMOutput: 400000
    }
  },
  {
    id: "@cf/zai-org/glm-4.7-flash",
    label: "GLM 4.7 Flash (бюджетная)",
    provider: "cloudflare",
    vendor: "zai",
    category: "fast",
    apiType: "text",
    capabilities: {
      contextWindow: 131072,
      vision: false,
      tools: true,
      jsonMode: true,
      reasoning: true,
      fixedContext: true,
      costHint: "low",
      codingQuality: "strong",
      speed: "fast",
      neuronsPerMInput: 5500,
      neuronsPerMOutput: 36400
    }
  },

  // === OpenAI (open-weight gpt-oss)
  {
    id: "@cf/openai/gpt-oss-120b",
    label: "GPT OSS 120B",
    provider: "cloudflare",
    vendor: "openai",
    category: "reasoning",
    apiType: "text",
    capabilities: {
      contextWindow: 128000,
      vision: false,
      tools: true,
      jsonMode: true,
      reasoning: true,
      fixedContext: true,
      costHint: "medium",
      codingQuality: "strong",
      speed: "medium",
      neuronsPerMInput: 31818,
      neuronsPerMOutput: 68182
    }
  },
  {
    id: "@cf/openai/gpt-oss-20b",
    label: "GPT OSS 20B (быстрая)",
    provider: "cloudflare",
    vendor: "openai",
    category: "fast",
    apiType: "text",
    capabilities: {
      contextWindow: 128000,
      vision: false,
      tools: true,
      jsonMode: true,
      reasoning: true,
      fixedContext: true,
      costHint: "medium",
      codingQuality: "strong",
      speed: "fast",
      neuronsPerMInput: 18182,
      neuronsPerMOutput: 27273
    }
  },

  // === Google (Gemma open-weight)
  {
    id: "@cf/google/gemma-4-26b-a4b-it",
    label: "Gemma 4 26B A4B",
    provider: "cloudflare",
    vendor: "google",
    category: "vision",
    apiType: "text",
    capabilities: {
      contextWindow: 256000,
      vision: true,
      tools: true,
      jsonMode: true,
      reasoning: true,
      fixedContext: true,
      costHint: "low",
      codingQuality: "strong",
      speed: "medium",
      neuronsPerMInput: 9091,
      neuronsPerMOutput: 27273
    }
  },

  // === NVIDIA (Nemotron)
  {
    id: "@cf/nvidia/nemotron-3-120b-a12b",
    label: "Nemotron 3 120B A12B",
    provider: "cloudflare",
    vendor: "nvidia",
    category: "reasoning",
    apiType: "text",
    capabilities: {
      contextWindow: 128000,
      vision: false,
      tools: true,
      jsonMode: true,
      reasoning: true,
      fixedContext: true,
      costHint: "medium",
      codingQuality: "strong",
      speed: "medium",
      neuronsPerMInput: 45455,
      neuronsPerMOutput: 136364
    }
  },

  // === Qwen (Alibaba)
  {
    id: "@cf/qwen/qwen3-30b-a3b-fp8",
    label: "Qwen 3 30B A3B FP8 (бюджетная)",
    provider: "cloudflare",
    vendor: "qwen",
    category: "fast",
    apiType: "text",
    capabilities: {
      contextWindow: 128000,
      vision: false,
      tools: true,
      jsonMode: true,
      reasoning: true,
      fixedContext: true,
      costHint: "low",
      codingQuality: "strong",
      speed: "medium",
      neuronsPerMInput: 4625,
      neuronsPerMOutput: 30475
    }
  },
  {
    id: "@cf/qwen/qwq-32b",
    label: "QwQ 32B (reasoning)",
    provider: "cloudflare",
    vendor: "qwen",
    category: "reasoning",
    apiType: "text",
    capabilities: {
      contextWindow: 128000,
      vision: false,
      tools: false,
      jsonMode: true,
      reasoning: true,
      fixedContext: true,
      costHint: "medium",
      codingQuality: "strong",
      speed: "medium",
      neuronsPerMInput: 60000,
      neuronsPerMOutput: 90909
    }
  },
  {
    id: "@cf/qwen/qwen2.5-coder-32b-instruct",
    label: "Qwen 2.5 Coder 32B",
    provider: "cloudflare",
    vendor: "qwen",
    category: "flagship",
    apiType: "text",
    capabilities: {
      contextWindow: 128000,
      vision: false,
      tools: false,
      jsonMode: true,
      fixedContext: true,
      costHint: "medium",
      codingQuality: "strong",
      speed: "medium",
      neuronsPerMInput: 60000,
      neuronsPerMOutput: 90909
    }
  },

  // === DeepSeek === дорогой reasoning-специалист
  {
    id: "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
    label: "DeepSeek R1 Distill Qwen 32B",
    provider: "cloudflare",
    vendor: "deepseek",
    category: "reasoning",
    apiType: "text",
    capabilities: {
      contextWindow: 128000,
      vision: false,
      tools: false,
      jsonMode: true,
      reasoning: true,
      fixedContext: true,
      costHint: "high",
      codingQuality: "strong",
      speed: "medium",
      neuronsPerMInput: 45170,
      neuronsPerMOutput: 443756
    }
  },

  // === Meta (Llama) === scout с vision + fast-варианты
  {
    id: "@cf/meta/llama-4-scout-17b-16e-instruct",
    label: "Llama 4 Scout 17B 16E",
    provider: "cloudflare",
    vendor: "meta",
    category: "vision",
    apiType: "text",
    capabilities: {
      contextWindow: 131072,
      vision: true,
      tools: true,
      jsonMode: true,
      fixedContext: true,
      costHint: "medium",
      codingQuality: "strong",
      speed: "medium",
      neuronsPerMInput: 24545,
      neuronsPerMOutput: 77273
    }
  },
  {
    id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    label: "Llama 3.3 70B FP8 Fast",
    provider: "cloudflare",
    vendor: "meta",
    category: "fast",
    apiType: "text",
    capabilities: {
      contextWindow: 128000,
      vision: false,
      tools: true,
      jsonMode: true,
      fixedContext: true,
      costHint: "medium",
      codingQuality: "strong",
      speed: "fast",
      neuronsPerMInput: 26668,
      neuronsPerMOutput: 204805
    }
  },
  {
    id: "@cf/meta/llama-3.2-11b-vision-instruct",
    label: "Llama 3.2 11B Vision",
    provider: "cloudflare",
    vendor: "meta",
    category: "vision",
    apiType: "text",
    capabilities: {
      contextWindow: 128000,
      vision: true,
      tools: false,
      jsonMode: true,
      fixedContext: true,
      costHint: "low",
      codingQuality: "basic",
      speed: "medium",
      neuronsPerMInput: 4410,
      neuronsPerMOutput: 61493
    }
  },
  {
    id: "@cf/meta/llama-3.2-3b-instruct",
    label: "Llama 3.2 3B (бюджетная)",
    provider: "cloudflare",
    vendor: "meta",
    category: "fast",
    apiType: "text",
    capabilities: {
      contextWindow: 128000,
      vision: false,
      tools: false,
      jsonMode: true,
      fixedContext: true,
      costHint: "low",
      codingQuality: "basic",
      speed: "fast",
      neuronsPerMInput: 4625,
      neuronsPerMOutput: 30475
    }
  },
  {
    id: "@cf/meta/llama-3.2-1b-instruct",
    label: "Llama 3.2 1B (ультра-бюджет)",
    provider: "cloudflare",
    vendor: "meta",
    category: "fast",
    apiType: "text",
    capabilities: {
      contextWindow: 60000,
      vision: false,
      tools: false,
      jsonMode: true,
      fixedContext: true,
      costHint: "low",
      codingQuality: "basic",
      speed: "fast",
      neuronsPerMInput: 2457,
      neuronsPerMOutput: 18252
    }
  },

  // === Mistral AI === vision-способная
  {
    id: "@cf/mistralai/mistral-small-3.1-24b-instruct",
    label: "Mistral Small 3.1 24B",
    provider: "cloudflare",
    vendor: "mistralai",
    category: "vision",
    apiType: "text",
    capabilities: {
      contextWindow: 128000,
      vision: true,
      tools: true,
      jsonMode: true,
      fixedContext: true,
      costHint: "medium",
      codingQuality: "strong",
      speed: "fast",
      neuronsPerMInput: 31876,
      neuronsPerMOutput: 50488
    }
  },

  // === IBM Granite === дешёвая для агентов
  {
    id: "@cf/ibm-granite/granite-4.0-h-micro",
    label: "Granite 4.0 H Micro (ультра-бюджет)",
    provider: "cloudflare",
    vendor: "other",
    category: "fast",
    apiType: "text",
    capabilities: {
      contextWindow: 128000,
      vision: false,
      tools: true,
      jsonMode: true,
      fixedContext: true,
      costHint: "low",
      codingQuality: "basic",
      speed: "fast",
      neuronsPerMInput: 1542,
      neuronsPerMOutput: 10158
    }
  }
];

// Image-generation модели (отдельный endpoint /run/, НЕ для чата).
// Показываются в UI в разделе «Изображения» — не как main модель.
const cloudflareImageModels: ProviderModel[] = [
  {
    id: "@cf/black-forest-labs/flux-1-schnell",
    label: "FLUX.1 Schnell (бюджетная)",
    provider: "cloudflare",
    vendor: "other",
    apiType: "image",
    capabilities: {
      vision: false,
      tools: false,
      jsonMode: false,
      costHint: "low",
      speed: "fast",
      // Pricing в нейронах за 512×512 тайл/step (по данным llms-full.txt).
      neuronsPerMInput: 5,
      neuronsPerMOutput: 10
    }
  },
  {
    id: "@cf/black-forest-labs/flux-2-klein-4b",
    label: "FLUX.2 Klein 4B",
    provider: "cloudflare",
    vendor: "other",
    apiType: "image",
    capabilities: {
      vision: false,
      tools: false,
      jsonMode: false,
      costHint: "low",
      speed: "fast",
      neuronsPerMInput: 5,
      neuronsPerMOutput: 26
    }
  },
  {
    id: "@cf/black-forest-labs/flux-2-dev",
    label: "FLUX.2 Dev (фотореализм)",
    provider: "cloudflare",
    vendor: "other",
    apiType: "image",
    capabilities: {
      vision: false,
      tools: false,
      jsonMode: false,
      costHint: "medium",
      speed: "medium",
      neuronsPerMInput: 19,
      neuronsPerMOutput: 38
    }
  },
  {
    id: "@cf/black-forest-labs/flux-2-klein-9b",
    label: "FLUX.2 Klein 9B (top quality)",
    provider: "cloudflare",
    vendor: "other",
    apiType: "image",
    capabilities: {
      vision: false,
      tools: false,
      jsonMode: false,
      costHint: "high",
      speed: "slow",
      neuronsPerMInput: 1364,
      neuronsPerMOutput: 1364
    }
  },
  {
    id: "@cf/leonardo/lucid-origin",
    label: "Leonardo Lucid Origin",
    provider: "cloudflare",
    vendor: "other",
    apiType: "image",
    capabilities: {
      vision: false,
      tools: false,
      jsonMode: false,
      costHint: "high",
      speed: "medium",
      neuronsPerMInput: 636,
      neuronsPerMOutput: 12
    }
  },
  {
    id: "@cf/leonardo/phoenix-1.0",
    label: "Leonardo Phoenix 1.0",
    provider: "cloudflare",
    vendor: "other",
    apiType: "image",
    capabilities: {
      vision: false,
      tools: false,
      jsonMode: false,
      costHint: "high",
      speed: "medium",
      neuronsPerMInput: 530,
      neuronsPerMOutput: 10
    }
  }
];

// Audio-модели (TTS/ASR). Показываются в разделе «Звуки».
const cloudflareAudioModels: ProviderModel[] = [
  {
    id: "@cf/myshell-ai/melotts",
    label: "MeloTTS (TTS, мультиязычная)",
    provider: "cloudflare",
    vendor: "other",
    apiType: "audio",
    capabilities: {
      vision: false,
      tools: false,
      jsonMode: false,
      costHint: "low",
      speed: "fast",
      neuronsPerMInput: 19
    }
  },
  {
    id: "@cf/deepgram/aura-2-en",
    label: "Deepgram Aura 2 EN (TTS)",
    provider: "cloudflare",
    vendor: "other",
    apiType: "audio",
    capabilities: {
      vision: false,
      tools: false,
      jsonMode: false,
      costHint: "medium",
      speed: "fast",
      neuronsPerMInput: 2727
    }
  },
  {
    id: "@cf/openai/whisper-large-v3-turbo",
    label: "Whisper Large V3 Turbo (ASR)",
    provider: "cloudflare",
    vendor: "other",
    apiType: "audio",
    capabilities: {
      vision: false,
      tools: false,
      jsonMode: false,
      costHint: "low",
      speed: "fast",
      neuronsPerMInput: 47
    }
  }
];

// Полный каталог для UI: текст + изображения + звук.
const cloudflareCatalog: ProviderModel[] = [
  ...cloudflareDefaultModels,
  ...cloudflareImageModels,
  ...cloudflareAudioModels
];

// То же самое, что cloudflareCatalog — оставлено для обратной совместимости
// с existing кодом, который ссылается на cloudflareDefaultModels.
// TODO: переименовать все ссылки на cloudflareCatalog позже.
function getCloudflareDefaultModels(): ProviderModel[] {
  return cloudflareCatalog;
}

export class CloudflareProvider implements ProviderAdapter {
  public readonly id = "cloudflare";
  public readonly displayName = "Cloudflare Workers AI";
  private readonly openai: OpenAICompatibleProvider;
  private readonly apiBaseUrl: string;

  public constructor(
    private readonly apiToken: string,
    private readonly accountId: string
  ) {
    this.apiBaseUrl = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai`;
    // Этап 6: prompt caching — session affinity для prefix cache hits.
    // ID генерируется один раз на старте провайдера = одна сессия VS Code.
    const affinityId = `mineagent_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    this.openai = new OpenAICompatibleProvider({
      id: "cloudflare",
      displayName: "Cloudflare Workers AI",
      baseUrl: `${this.apiBaseUrl}/v1`,
      apiKey: apiToken,
      defaultModels: cloudflareCatalog,
      chatEndpoint: "/chat/completions",
      modelsEndpoint: "/models",
      sessionAffinityId: affinityId
    });
  }

  public async chat(request: ChatRequest): Promise<ChatResponse> {
    return this.openai.chat(request);
  }

  public async *streamChat(request: ChatRequest): AsyncIterable<StreamChunk> {
    yield* this.openai.streamChat(request);
  }

  public async listModels(): Promise<ProviderModel[]> {
    let searchModels: ProviderModel[] = [];
    try {
      searchModels = await this.tryModelSearchEndpoint();
    } catch (error) {
      if (error instanceof ProviderRequestError) {
        throw error;
      }
      searchModels = [];
    }
    return uniqueModels([...searchModels, ...cloudflareCatalog]);
  }

  public async countTokens(request: ChatRequest): Promise<TokenCount> {
    return this.openai.countTokens(request);
  }

  // Этап 6: embeddings для Knowledge Base + Skills retrieval.
  public async embeddings(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    return this.openai.embeddings(request);
  }

  public async validateKey(): Promise<boolean> {
    try {
      await this.listModels();
      return true;
    } catch {
      return false;
    }
  }

  private async tryModelSearchEndpoint(): Promise<ProviderModel[]> {
    // Документация Cloudflare: GET /accounts/{account_id}/ai/models/search
    // Возвращает { result: { models: [...] } | [...] }, где у каждой модели есть
    // поле `name` (идентификатор вида "@cf/owner/model"), `description`, `task`.
    // Старый код использовал POST с пустым телом и искал поле `id` первым —
    // из-за этого реальные модели не выгружались.
    const response = await fetch(`${this.apiBaseUrl}/models/search`, {
      method: "GET",
      headers: this.headers()
    });
    if (response.status === 404 || response.status === 405) {
      return [];
    }
    if (!response.ok) {
      throw await ProviderRequestError.fromResponse(this.displayName, response);
    }
    const text = await response.text();
    if (!text.trim()) {
      return [];
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return [];
    }
    return normalizeCloudflareModels(extractModelRecords(parsed));
  }

  private headers(): Record<string, string> {
    return {
      "Authorization": `Bearer ${this.apiToken}`,
      "Content-Type": "application/json"
    };
  }
}

// Только эти task-типы Cloudflare нам интересны (текстовые чат-модели).
// Image/embedding/audio/classification/summarization/etc. отсекаем —
// они не подходят для role "код-ассистент".
const SUPPORTED_TASK_PATTERNS = [
  /text-generation/i,
  /conversational/i,
  /instruct/i,
  /chat/i,
  /completion/i
];

function extractModelRecords(value: unknown): Array<Record<string, unknown>> {
  const records: Array<Record<string, unknown>> = [];
  const visit = (item: unknown): void => {
    if (Array.isArray(item)) {
      for (const child of item) {
        visit(child);
      }
      return;
    }
    if (!item || typeof item !== "object") {
      return;
    }
    const record = item as Record<string, unknown>;
    // Cloudflare кладёт идентификатор модели в `name` (а не `id`).
    // Поддерживаем все варианты на случай разных версий API.
    const modelId = firstString(record.id, record.name, record.model, record.model_id, record.modelId);
    if (modelId) {
      records.push(record);
    }
    // Рекурсивно заходим в типичные контейнеры ответа Cloudflare.
    for (const key of ["result", "models", "data", "items", "results"]) {
      if (key in record) {
        visit(record[key]);
      }
    }
  };
  visit(value);
  return records;
}

function uniqueModels(models: ProviderModel[]): ProviderModel[] {
  const byId = new Map<string, ProviderModel>();
  for (const model of models) {
    // Не перезаписываем модели из bundled-каталога распарсенными данными,
    // у каталога более точные capabilities.
    if (!byId.has(model.id)) {
      byId.set(model.id, model);
    }
  }
  return Array.from(byId.values());
}

function normalizeCloudflareModels(rawModels: Array<Record<string, unknown>>): ProviderModel[] {
  const models: ProviderModel[] = [];
  for (const raw of rawModels) {
    const id = firstString(raw.id, raw.name, raw.model, raw.model_id, raw.modelId);
    if (!id) {
      continue;
    }
    const task = firstString(raw.task, raw.type, raw.category);
    // Пропускаем embedding/classification/summarization/translation — они
    // не нужны для моддинга. Image/text-to-image и audio/asr/tts оставляем,
    // но помечаем apiType чтобы UI показывал их в правильной категории.
    const apiType = inferApiType(id, task);
    if (apiType === "skip") {
      continue;
    }
    const label = firstString(raw.label, raw.display_name, raw.displayName, raw.title, raw.description) ?? id;
    models.push({
      id,
      label: label === id ? readableModelLabel(id) : label,
      provider: "cloudflare",
      capabilities: inferCapabilities(raw, id),
      vendor: inferVendor(id),
      category: inferCategory(id, raw),
      apiType
    });
  }
  return models;
}

// Определяет тип API endpoint'а модели. "skip" = не показывать в каталоге.
function inferApiType(id: string, task: string | undefined): ModelApiType | "skip" {
  const haystack = `${id} ${task ?? ""}`.toLowerCase();
  // Image generation
  if (/text-to-image|image-generation|flux|stable-diffusion|leonardo|dreamshaper/.test(haystack)) {
    return "image";
  }
  // Audio (TTS / ASR)
  if (/speech|tts|asr|whisper|aura|melo|voice/.test(haystack)) {
    return "audio";
  }
  // Бесполезные для моддинга типы
  if (/embedding|rerank|classification|summarization|translation|object-detection/.test(haystack)) {
    return "skip";
  }
  // По умолчанию — текст/чат
  return "text";
}

function inferCapabilities(raw: Record<string, unknown>, id: string) {
  const haystack = JSON.stringify(raw).toLowerCase();
  return {
    contextWindow: firstNumber(raw.context_window, raw.contextWindow, raw.context_length, raw.contextLength, raw.max_tokens, raw.maxTokens),
    vision: /vision|image-to-text|multimodal/.test(haystack) || /kimi-k2\.7|llama-4|gemma-4|vision/i.test(id),
    tools: /function calling|function_calling|tool|tools/.test(haystack) || /kimi-k2\.7|glm|gpt-oss|qwen/i.test(id),
    jsonMode: !/text-to-image|speech|embedding|rerank|classification/.test(haystack),
    reasoning: /reasoning|reasoner|gpt-oss|kimi-k2\.7|glm|qwq|deepseek-r1/i.test(haystack) || /gpt-oss|kimi-k2\.7|glm|qwq|deepseek-r1/i.test(id),
    fixedContext: true,
    speed: /flash|fast|8b|20b/i.test(id) ? "fast" as const : "medium" as const,
    codingQuality: /kimi|coder|qwen|gpt-oss|glm/i.test(id) ? "strong" as const : "basic" as const
  };
}

// Определяет вендора из идентификатора модели вида @cf/{vendor}/...
function inferVendor(id: string): ModelVendor {
  const match = id.match(/^@cf\/([\w-]+)\//i);
  if (!match) {
    return "other";
  }
  const owner = match[1].toLowerCase();
  switch (owner) {
    case "moonshotai":
    case "moonshot":
      return "moonshotai";
    case "openai":
      return "openai";
    case "google":
      return "google";
    case "nvidia":
      return "nvidia";
    case "deepseek-ai":
    case "deepseek":
      return "deepseek";
    case "qwen":
    case "alibaba":
      return "qwen";
    case "zai-org":
    case "zai":
    case "zhipu":
      return "zai";
    case "meta":
    case "meta-llama":
      return "meta";
    case "mistralai":
    case "mistral":
      return "mistralai";
    case "microsoft":
      return "microsoft";
    default:
      return "other";
  }
}

// Определяет категорию модели по идентификатору и описанию.
function inferCategory(id: string, raw: Record<string, unknown>): ModelCategory {
  const haystack = `${id} ${JSON.stringify(raw)}`.toLowerCase();
  if (/vision|multimodal|image-to-text/.test(haystack) || /llama-4|gemma-[34]/.test(id.toLowerCase())) {
    return "vision";
  }
  if (/kimi-k2\.7|glm-5|gpt-oss-120b|qwen2\.5-coder|flagship/.test(haystack)) {
    return "flagship";
  }
  if (/reasoning|reasoner|deepseek-r1|qwq|gpt-oss|nemotron/.test(haystack)) {
    return "reasoning";
  }
  if (/flash|fast|8b|small|mini/.test(haystack)) {
    return "fast";
  }
  return "flagship";
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function readableModelLabel(id: string): string {
  const tail = id.split("/").filter(Boolean).pop() ?? id;
  return tail
    .replace(/^@cf\//, "")
    .replaceAll("-", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}
