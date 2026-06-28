import type { ProviderId } from "../config/types";

export interface ModelCapabilities {
  contextWindow?: number;
  vision: boolean;
  tools: boolean;
  jsonMode: boolean;
  reasoning?: boolean;
  fixedContext?: boolean;
  costHint?: "low" | "medium" | "high";
  codingQuality?: "basic" | "strong" | "frontier";
  speed?: "slow" | "medium" | "fast";
  // Ценовая информация для UI. Нейроны Cloudflare за 1M input/output токенов.
  // Берётся из официального llms-full.txt. 0 = бесплатно/не применимо.
  neuronsPerMInput?: number;
  neuronsPerMOutput?: number;
  deprecated?: boolean;
  // Фаза 1 (P1.5): поддерживает ли модель reasoning_effort (low/medium/high).
  effortLevels?: boolean;
}

// Вендор/производитель модели — для группировки в UI выбора модели.
// Выводится как optgroup в списке. Берётся из идентификатора модели (@cf/{vendor}/...).
export type ModelVendor =
  | "moonshotai"
  | "openai"
  | "google"
  | "nvidia"
  | "deepseek"
  | "qwen"
  | "zai"
  | "meta"
  | "mistralai"
  | "microsoft"
  | "other";

// Тип модели по API endpoint'у — определяет, как с ней взаимодействовать.
// Чат/код-модели идут через /chat/completions, image — через /run/, audio — через свои endpoints.
export type ModelApiType =
  | "text"      // чат/код через chat completions (главные кандидаты)
  | "image"     // генерация изображений (flux, sd) — отдельный endpoint
  | "audio";    // TTS/ASR/voice — отдельный endpoint

// Категория использования — помогает пользователю выбрать модель под задачу.
export type ModelCategory =
  | "flagship"   // флагманские coding/frontier модели
  | "reasoning"  // модели с явным reasoning (R1, QwQ)
  | "fast"       // быстрые лёгкие модели для рутины
  | "vision";    // multimodal с поддержкой изображений

export interface ProviderModel {
  id: string;
  label: string;
  provider: ProviderId;
  capabilities: ModelCapabilities;
  vendor?: ModelVendor;
  category?: ModelCategory;
  apiType?: ModelApiType;
}

// Нормализованный внутренний формат tool-call. arguments всегда строка
// (OpenAI-shape), даже если провайдер отдал объектом (Cloudflare-native) —
// нормализация происходит в провайдере.
export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

// Wire-формат tool-схемы (OpenAI-shape: type:"function" + function:{...}).
// Используется на OpenAI-compat endpoint'е Cloudflare (/ai/v1/chat/completions),
// который вызывает MineAgent. См. docs/source-ledger.md entry-3.
export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

// Этап 5: multimodal content-блоки для vision-передачи изображений.
// OpenAI Chat Completions vision-формат (см. docs/source-ledger.md entry-13/14):
// content может быть строкой (обратно-совместимо) ИЛИ массивом блоков.
// Cloudflare OpenAI-compat endpoint /ai/v1/chat/completions принимает эту форму.
export type ContentBlock = TextContentBlock | ImageContentBlock;

export interface TextContentBlock {
  type: "text";
  text: string;
}

export interface ImageContentBlock {
  type: "image_url";
  image_url: {
    // data URL (data:image/png;base64,...) или полностью квалифицированный URL.
    url: string;
    // Опционально: low = экономия токенов, high = детализация. По умолчанию
    // провайдер трактует отсутствие как "auto".
    detail?: "low" | "high";
  };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  // Этап 5: union string | ContentBlock[]. Строка остаётся валидной для
  // обратно-совместимости (все существующие вызовы используют строку).
  // Массив блоков используется для vision-запросов (image_url-блоки).
  content: string | ContentBlock[];
  name?: string;
  // role:"tool" — ответ на tool_call. tool_call_id связывает с вызовом.
  tool_call_id?: string;
  // role:"assistant" — список tool_calls, которые модель решила сделать.
  tool_calls?: ToolCall[];
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  jsonMode?: boolean;
  maxTokens?: number;
  tools?: ToolDefinition[];
  // tool_choice управляет, обязан ли модель звать tools. По умолчанию не шлём
  // (провайдер трактует отсутствие как "auto").
  tool_choice?: "auto" | "required" | "none";
  // Фаза 1 (P1.5): уровень reasoning effort для моделей, которые его поддерживают.
  reasoning_effort?: "low" | "medium" | "high";
  signal?: AbortSignal;
}

export interface ChatResponse {
  id?: string;
  model: string;
  content: string;
  raw?: unknown;
  // Tool-calls, нормализованные из ответа провайдера. Пусто/undefined → это
  // финальный текстовый ответ, tool-loop завершается.
  toolCalls?: ToolCall[];
  // Этап 5: скрытый reasoning_content (chain-of-thought) от reasoning-моделей
  // (GLM 5.2, DeepSeek V4, QwQ и др.). Провайдер отдаёт его отдельно от content.
  // Orchestrator surfaced его в activity-событиях, чтобы пользователь видел
  // ход мыслей модели, а не только финальный ответ.
  reasoningContent?: string;
  // Опционально: реальные цифры токенов из ответа провайдера.
  // Если провайдер не отдаёт usage — вызывающий код оценит по chars/4.
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    visionCalls?: number;
  };
}

export interface StreamChunk {
  contentDelta: string;
  raw?: unknown;
}

export interface TokenCount {
  inputTokens: number;
  estimated: boolean;
}

export interface ProviderAdapter {
  readonly id: ProviderId;
  readonly displayName: string;
  chat(request: ChatRequest): Promise<ChatResponse>;
  streamChat(request: ChatRequest): AsyncIterable<StreamChunk>;
  listModels(): Promise<ProviderModel[]>;
  countTokens?(request: ChatRequest): Promise<TokenCount>;
  // Этап 6: embeddings для Knowledge Base + Skills retrieval.
  // Cloudflare OpenAI-compat endpoint /v1/embeddings (entry-16 source-ledger).
  embeddings?(request: EmbeddingRequest): Promise<EmbeddingResponse>;
  validateKey(): Promise<boolean>;
}

// Этап 6: запрос embeddings. input — строка или массив строк.
export interface EmbeddingRequest {
  model: string;
  input: string | string[];
  signal?: AbortSignal;
}

// Этап 6: ответ embeddings. data[i].embedding — векторное представление текста.
export interface EmbeddingResponse {
  model: string;
  data: Array<{ embedding: number[]; index?: number }>;
  usage?: { promptTokens?: number };
  raw?: unknown;
}

// --- Этап 5: helpers для multimodal content ---

// Проверяет, содержит ли messages хотя бы один image_url-блок (vision-запрос).
// Используется orchestrator'ом для инкремента visionCalls в token-budget.
export function hasImageBlocks(messages: ChatMessage[]): boolean {
  for (const message of messages) {
    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block.type === "image_url") {
          return true;
        }
      }
    }
  }
  return false;
}

// Извлекает текст из content (строка ИЛИ массив блоков). text-блоки
// склеиваются; image_url-блоки пропускаются (они несут токены, но не текст).
// Используется в countTokens и логировании.
export function extractTextFromContent(content: string | ContentBlock[]): string {
  if (typeof content === "string") {
    return content;
  }
  return content
    .filter((block) => block.type === "text")
    .map((block) => (block as TextContentBlock).text)
    .join("");
}
