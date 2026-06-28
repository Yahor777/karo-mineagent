import type {
  ChatRequest,
  ChatResponse,
  ChatMessage,
  ProviderAdapter,
  ProviderModel,
  StreamChunk,
  TokenCount,
  ToolCall,
  EmbeddingRequest,
  EmbeddingResponse
} from "./ProviderAdapter";
import { extractTextFromContent } from "./ProviderAdapter";
import type { ProviderId } from "../config/types";

export interface OpenAICompatibleOptions {
  id: ProviderId;
  displayName: string;
  baseUrl: string;
  apiKey: string;
  defaultModels: ProviderModel[];
  chatEndpoint?: string;
  modelsEndpoint?: string;
  // Этап 6: embeddings endpoint (по умолчанию /v1/embeddings).
  embeddingsEndpoint?: string;
  // Этап 6: prompt caching — x-session-affinity header (Cloudflare).
  // Если задан — каждый chat-запрос шлёт этот header → prefix cache hit.
  sessionAffinityId?: string;
}

export class OpenAICompatibleProvider implements ProviderAdapter {
  public readonly id: ProviderId;
  public readonly displayName: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly defaultModels: ProviderModel[];
  private readonly chatEndpoint: string;
  private readonly modelsEndpoint: string;
  // Этап 6: embeddings endpoint (по умолчанию /v1/embeddings).
  private readonly embeddingsEndpoint: string;
  // Этап 6: prompt caching session affinity (Cloudflare x-session-affinity).
  private readonly sessionAffinityId?: string;

  public constructor(options: OpenAICompatibleOptions) {
    this.id = options.id;
    this.displayName = options.displayName;
    this.baseUrl = trimTrailingSlash(options.baseUrl);
    this.apiKey = options.apiKey;
    this.defaultModels = options.defaultModels;
    this.chatEndpoint = options.chatEndpoint ?? "/v1/chat/completions";
    this.modelsEndpoint = options.modelsEndpoint ?? "/v1/models";
    this.embeddingsEndpoint = options.embeddingsEndpoint ?? "/v1/embeddings";
    this.sessionAffinityId = options.sessionAffinityId;
  }

  public async chat(request: ChatRequest): Promise<ChatResponse> {
    // Этап 6: prompt caching — x-session-affinity header для Cloudflare.
    // Роутит запросы одной сессии на один model instance → prefix cache hit.
    const headers = this.headers();
    if (this.sessionAffinityId) {
      headers["x-session-affinity"] = this.sessionAffinityId;
    }
    // КРИТИЧЕСКИЙ ФИКС: преобразуем tool_calls в OpenAI wire-format.
    // ChatMessage.tool_calls хранит { id, name, arguments } (внутренний формат),
    // но API требует { id, type: "function", function: { name, arguments } }.
    const wireMessages = request.messages.map(toWireMessage);
    const response = await fetch(`${this.baseUrl}${this.chatEndpoint}`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: request.model,
        messages: wireMessages,
        temperature: request.temperature,
        max_tokens: request.maxTokens,
        response_format: request.jsonMode ? { type: "json_object" } : undefined,
        tools: request.tools,
        // tool_choice шлём только когда задан явно. Отсутствие поля провайдер
        // трактует как "auto" — так короче запрос и дружественнее prefix-cache.
        tool_choice: request.tool_choice,
        // Фаза 1 (P1.5): reasoning_effort — undefined не сериализуется, безопасно
        // для провайдеров без поддержки (гейтится в orchestrator).
        reasoning_effort: request.reasoning_effort
      }),
      signal: request.signal
    });

    if (!response.ok) {
      throw await ProviderRequestError.fromResponse(this.displayName, response);
    }

    const raw = (await response.json()) as OpenAIChatResponse;
    const toolCalls = extractToolCalls(raw);
    return {
      id: raw.id,
      model: raw.model ?? request.model,
      content: extractChatContent(raw),
      reasoningContent: extractReasoningContent(raw),
      toolCalls,
      raw,
      usage: extractUsage(raw)
    };
  }

  public async *streamChat(request: ChatRequest): AsyncIterable<StreamChunk> {
    const response = await this.chat(request);
    yield {
      contentDelta: response.content,
      raw: response.raw
    };
  }

  public async listModels(): Promise<ProviderModel[]> {
    try {
      const response = await fetch(`${this.baseUrl}${this.modelsEndpoint}`, {
        headers: this.headers()
      });
      if (!response.ok) {
        return this.defaultModels;
      }
      const raw = (await response.json()) as { data?: Array<{ id: string }> };
      const remoteModels = raw.data?.map((model) => ({
        id: model.id,
        label: model.id,
        provider: this.id,
        capabilities: {
          vision: false,
          tools: true,
          jsonMode: true,
          speed: "medium" as const
        }
      }));
      return remoteModels?.length ? remoteModels : this.defaultModels;
    } catch {
      return this.defaultModels;
    }
  }

  public async countTokens(request: ChatRequest): Promise<TokenCount> {
    // Этап 5: content может быть массивом блоков (text + image_url).
    // Извлекаем текст из блоков; image-блоки добавляют токены, но без
    // точной оценки (Cloudflare не отдаёт vision-token-count отдельно).
    const chars = request.messages
      .map((message) => extractTextFromContent(message.content))
      .join("\n").length;
    return {
      inputTokens: Math.ceil(chars / 4),
      estimated: true
    };
  }

  public async validateKey(): Promise<boolean> {
    if (!this.apiKey) {
      return false;
    }
    try {
      const response = await fetch(`${this.baseUrl}${this.modelsEndpoint}`, {
        headers: this.headers()
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  // Этап 6: /v1/embeddings для Knowledge Base + Skills retrieval.
  // Cloudflare OpenAI-compat endpoint (entry-16 source-ledger).
  public async embeddings(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    const response = await fetch(`${this.baseUrl}${this.embeddingsEndpoint}`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        model: request.model,
        input: request.input
      }),
      signal: request.signal
    });
    if (!response.ok) {
      throw await ProviderRequestError.fromResponse(this.displayName, response);
    }
    const raw = await response.json() as OpenAIEmbeddingResponse;
    return {
      model: raw.model ?? request.model,
      data: (raw.data ?? []).map((item) => ({
        embedding: item.embedding,
        index: item.index
      })),
      usage: raw.usage ? { promptTokens: raw.usage.prompt_tokens } : undefined,
      raw
    };
  }

  private headers(): Record<string, string> {
    return {
      "Authorization": `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
      // Некоторые OpenAI-совместимые провайдеры (например kimchi/castai за Cloudflare)
      // блокируют запросы без браузерного User-Agent: возвращают 403 / "error code: 1010".
      // Node/undici по умолчанию шлёт UA, который Cloudflare банит по сигнатуре. Поэтому
      // выставляем браузероподобный UA и Accept — без этого расширение не получает ответы.
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "Accept": "application/json"
    };
  }
}

export class ProviderRequestError extends Error {
  public constructor(
    public readonly providerName: string,
    public readonly status: number,
    public readonly providerMessage: string,
    public readonly code?: string,
    public readonly param?: string
  ) {
    super(formatProviderError(providerName, status, providerMessage, code, param));
  }

  public static async fromResponse(providerName: string, response: Response): Promise<ProviderRequestError> {
    const text = await response.text();
    const parsed = parseProviderError(text);
    return new ProviderRequestError(
      providerName,
      response.status,
      parsed.message || text || response.statusText,
      parsed.code,
      parsed.param
    );
  }

  public isModelNotFound(): boolean {
    return this.status === 404 && (this.param === "model" || this.code === "NOT_FOUND");
  }

  public isBillingBlocked(): boolean {
    return this.status === 402
      || this.status === 412
      || /billing|invoice|suspend|credit|spending limit|payment/i.test(this.providerMessage);
  }
}

interface OpenAIChatResponse {
  id?: string;
  model?: string;
  output_text?: string;
  response?: string;
  result?: unknown;
  output?: unknown;
  content?: unknown;
  // Cloudflare native-shape: tool_calls может лежать на верхнем уровне ответа
  // (а не внутри choices[0].message), см. docs/source-ledger.md entry-1.
  // В этом варианте каждый элемент — { name, arguments } с arguments-объектом.
  tool_calls?: unknown;
  // Reasoning-модели (GLM 5.2, DeepSeek V4, QwQ) могут отдавать
  // reasoning_content на верхнем уровне (Cloudflare-native shape) или
  // внутри choices[0].message (OpenAI-compat shape). См. extractReasoningContent.
  reasoning_content?: string;
  // Стандартное поле usage OpenAI-совместимых endpoint'ов.
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  choices?: Array<{
    text?: string;
    message?: {
      content?: unknown;
      reasoning_content?: string;
      // OpenAI-shape: tool_calls внутри message, arguments — JSON-строка.
      tool_calls?: unknown;
    };
    finish_reason?: string;
  }>;
}

// Этап 6: ответ /v1/embeddings (OpenAI-compat shape).
interface OpenAIEmbeddingResponse {
  model?: string;
  data?: Array<{ embedding: number[]; index?: number }>;
  usage?: { prompt_tokens?: number };
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

// Вытаскиваем usage из стандартного OpenAI-формата ответа.
// Если провайдер не отдаёт usage — возвращаем undefined, вызывающий
// код оценит токены по chars/4.
function extractUsage(raw: OpenAIChatResponse): { inputTokens?: number; outputTokens?: number } | undefined {
  if (!raw.usage) {
    return undefined;
  }
  const usage = raw.usage;
  const inputTokens = typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : undefined;
  const outputTokens = typeof usage.completion_tokens === "number" ? usage.completion_tokens : undefined;
  if (inputTokens === undefined && outputTokens === undefined) {
    return undefined;
  }
  return { inputTokens, outputTokens };
}

// Дефензивный парсер tool_calls. MineAgent ходит на OpenAI-compat endpoint
// Cloudflare (/ai/v1/chat/completions), где формат — OpenAI-shape:
// choices[0].message.tool_calls[].function.{ name, arguments(JSON-строка) }.
// Но Cloudflare native REST-формат (entry-1 source-ledger) плоский:
// response.tool_calls[].{ name, arguments(объект) }. Принимаем оба варианта —
// Cloudflare известен расхождениями между compat/native даже на одном endpoint.
function extractToolCalls(raw: OpenAIChatResponse): ToolCall[] | undefined {
  const calls: ToolCall[] = [];

  // 1. OpenAI-shape: choices[0].message.tool_calls.
  const messageCalls = raw.choices?.[0]?.message?.tool_calls;
  pushNormalized(calls, messageCalls, (item) => {
    const fn = recordField(item, "function");
    const name = (fn ? stringField(fn, "name") : undefined) ?? stringField(item, "name") ?? "";
    return {
      id: stringField(item, "id") ?? makeToolCallId(),
      name,
      arguments: normalizeArguments(fn ? fn.arguments : recordField(item, "arguments"))
    };
  });

  // 2. Cloudflare native-shape: tool_calls на верхнем уровне (или в result).
  if (!calls.length) {
    const native = raw.tool_calls ?? (isRecord(raw.result) ? raw.result.tool_calls : undefined);
    pushNormalized(calls, native, (item) => ({
      id: stringField(item, "id") ?? makeToolCallId(),
      name: stringField(item, "name") ?? "",
      arguments: normalizeArguments(recordField(item, "arguments"))
    }));
  }

  // undefined (вместо пустого массива) когда tool_calls нет — ChatResponse
  // остаётся обратно-совместимым со старыми вызовами без tools.
  return calls.length ? calls : undefined;
}

// Применяет normalizer к массиву unknown[], фильтруя элементы без name.
function pushNormalized(
  sink: ToolCall[],
  source: unknown,
  normalize: (item: Record<string, unknown>) => ToolCall
): void {
  if (!Array.isArray(source)) {
    return;
  }
  for (const raw of source) {
    if (!isRecord(raw)) {
      continue;
    }
    const call = normalize(raw);
    if (call.name) {
      sink.push(call);
    }
  }
}

// arguments в OpenAI — JSON-строка, в Cloudflare native — объект. Нормализуем
// всегда к строке, чтобы orchestrator делал JSON.parse единообразно.
function normalizeArguments(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value && typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return "{}";
    }
  }
  return "{}";
}

// Синтетический id для tool_call, если провайдер не вернул (Cloudflare native
// не использует id). Префикс "call_" соответствует конвенции OpenAI.
let toolCallCounter = 0;
function makeToolCallId(): string {
  toolCallCounter += 1;
  return `call_${Date.now().toString(36)}_${toolCallCounter}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function recordField(value: unknown, key: string): Record<string, unknown> | undefined {
  const record = isRecord(value) ? value : undefined;
  const field = record?.[key];
  return isRecord(field) ? field : undefined;
}

function stringField(value: unknown, key: string): string | undefined {
  const record = isRecord(value) ? value : undefined;
  const field = record?.[key];
  return typeof field === "string" && field.trim() ? field.trim() : undefined;
}

function extractChatContent(raw: OpenAIChatResponse): string {
  const candidates = [
    raw.choices?.[0]?.message?.content,
    raw.choices?.[0]?.text,
    raw.output_text,
    raw.response,
    raw.content,
    raw.result,
    raw.output
  ];
  for (const candidate of candidates) {
    const text = stringifyContent(candidate);
    if (text.trim()) {
      return text;
    }
  }
  return "";
}

// Извлекает reasoning_content (chain-of-thought) из ответа reasoning-моделей.
// Поле есть у GLM 5.2, DeepSeek V4, QwQ и других reasoning-моделей на
// OpenAI-compat endpoint'ах. Cloudflare-native shape тоже может содержать
// reasoning_content на верхнем уровне.
function extractReasoningContent(raw: OpenAIChatResponse): string | undefined {
  const candidates = [
    raw.choices?.[0]?.message?.reasoning_content,
    raw.reasoning_content
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate;
    }
  }
  return undefined;
}

function stringifyContent(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(stringifyContent).join("");
  }
  if (!value || typeof value !== "object") {
    return "";
  }
  const record = value as Record<string, unknown>;
  for (const key of ["text", "content", "response", "output_text", "value"]) {
    const text = stringifyContent(record[key]);
    if (text.trim()) {
      return text;
    }
  }
  return "";
}

function parseProviderError(text: string): { message?: string; code?: string; param?: string } {
  try {
    const raw = JSON.parse(text) as { error?: { message?: string; code?: string; param?: string } };
    return {
      message: raw.error?.message,
      code: raw.error?.code,
      param: raw.error?.param
    };
  } catch {
    return {
      message: text
    };
  }
}

function formatProviderError(
  providerName: string,
  status: number,
  providerMessage: string,
  code?: string,
  param?: string
): string {
  if (status === 404 && (param === "model" || code === "NOT_FOUND")) {
    return `${providerName}: модель не найдена или недоступна для этого ключа. MineAgent попробует выбрать доступную модель из списка провайдера.`;
  }
  if (status === 402 || status === 412 || /billing|invoice|suspend|credit|spending limit|payment/i.test(providerMessage)) {
    return `${providerName}: API-запрос отклонен из-за биллинга или статуса аккаунта. Проверь выбранный аккаунт/организацию, кредиты, лимит расходов и неоплаченные счета у провайдера.`;
  }
  return `${providerName}: запрос не прошел (${status}). ${providerMessage}`;
}

// КРИТИЧЕСКИЙ ФИКС: преобразует ChatMessage в OpenAI wire-format.
// tool_calls во внутреннем формате: { id, name, arguments }
// wire-format: { id, type: "function", function: { name, arguments } }
// Без этого Cloudflare возвращает 400: "Field required: function".
function toWireMessage(message: ChatMessage): Record<string, unknown> {
  const result: Record<string, unknown> = {
    role: message.role,
    content: message.content
  };
  if (message.name) {
    result.name = message.name;
  }
  if (message.tool_call_id) {
    result.tool_call_id = message.tool_call_id;
  }
  if (message.tool_calls?.length) {
    result.tool_calls = message.tool_calls.map((call) => ({
      id: call.id,
      type: "function",
      function: {
        name: call.name,
        arguments: call.arguments
      }
    }));
  }
  return result;
}
