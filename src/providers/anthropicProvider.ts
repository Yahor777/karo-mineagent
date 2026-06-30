import type {
  ChatRequest,
  ChatResponse,
  ChatMessage,
  ContentBlock,
  ProviderAdapter,
  ProviderModel,
  StreamChunk,
  TokenCount,
  ToolCall,
  ToolDefinition
} from "./ProviderAdapter";
import { extractTextFromContent } from "./ProviderAdapter";
import { ProviderRequestError } from "./openaiCompatibleProvider";

const ANTHROPIC_BASE = "https://api.anthropic.com";
const ANTHROPIC_VERSION = "2023-06-01";

// Полноценная реализация Anthropic Messages API.
// Поддержка: tools (tool_use / tool_result), vision (base64 image-блоки),
// реальные listModels()/validateKey() (через /v1/models), парсинг usage.
// До этой версии провайдер НЕ слал tools и НЕ парсил tool_use — tool-loop с
// Claude не работал, хотя capabilities рапортовали tools:true/vision:true.
export class AnthropicProvider implements ProviderAdapter {
  public readonly id = "anthropic" as const;
  public readonly displayName = "Anthropic Claude";

  public constructor(private readonly apiKey: string) {}

  public async chat(request: ChatRequest): Promise<ChatResponse> {
    const system = extractSystemPrompt(request.messages);
    const messages = toAnthropicMessages(request.messages);

    const body: Record<string, unknown> = {
      model: request.model,
      messages,
      // max_tokens у Anthropic обязателен.
      max_tokens: request.maxTokens ?? 4096
    };
    if (system) {
      body.system = system;
    }
    if (typeof request.temperature === "number") {
      body.temperature = request.temperature;
    }
    // tools: конвертируем OpenAI-shape ToolDefinition → формат Anthropic
    // ({ name, description, input_schema }). tool_choice маппим в Anthropic-вид.
    if (request.tools?.length) {
      body.tools = request.tools.map(toAnthropicTool);
      const choice = toAnthropicToolChoice(request.tool_choice);
      if (choice) {
        body.tool_choice = choice;
      }
    }

    const response = await fetch(`${ANTHROPIC_BASE}/v1/messages`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: request.signal
    });

    if (!response.ok) {
      throw await ProviderRequestError.fromResponse(this.displayName, response);
    }

    const raw = (await response.json()) as AnthropicMessageResponse;
    const { text, toolCalls } = parseAnthropicContent(raw);
    return {
      id: raw.id,
      model: raw.model ?? request.model,
      content: text,
      // undefined (а не []) когда tool_calls нет — обратная совместимость с
      // вызовами без tools, как и в openaiCompatibleProvider.
      toolCalls: toolCalls.length ? toolCalls : undefined,
      usage: extractUsage(raw),
      raw
    };
  }

  public async *streamChat(request: ChatRequest): AsyncIterable<StreamChunk> {
    // Anthropic поддерживает SSE-стриминг, но текущий контракт MineAgent
    // ожидает один чанк (см. openaiCompatibleProvider). Делегируем в chat().
    const response = await this.chat(request);
    yield { contentDelta: response.content, raw: response.raw };
  }

  public async listModels(): Promise<ProviderModel[]> {
    try {
      const response = await fetch(`${ANTHROPIC_BASE}/v1/models`, {
        headers: this.headers()
      });
      if (!response.ok) {
        return this.fallbackModels();
      }
      const raw = (await response.json()) as {
        data?: Array<{ id: string; display_name?: string }>;
      };
      const models = raw.data?.map((model) => this.describeModel(model.id, model.display_name));
      return models?.length ? models : this.fallbackModels();
    } catch {
      return this.fallbackModels();
    }
  }

  public async countTokens(request: ChatRequest): Promise<TokenCount> {
    const chars = request.messages
      .map((message) => extractTextFromContent(message.content))
      .join("\n").length;
    return { inputTokens: Math.ceil(chars / 4), estimated: true };
  }

  public async validateKey(): Promise<boolean> {
    if (!this.apiKey) {
      return false;
    }
    try {
      // Реальная проверка ключа: лёгкий GET /v1/models (раньше было фейково —
      // просто Boolean(apiKey), что давало ложно-валидный статус для битого ключа).
      const response = await fetch(`${ANTHROPIC_BASE}/v1/models`, {
        headers: this.headers()
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  private headers(): Record<string, string> {
    return {
      "x-api-key": this.apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      "content-type": "application/json"
    };
  }

  private describeModel(id: string, label?: string): ProviderModel {
    const isHaiku = /haiku/i.test(id);
    return {
      id,
      label: label ?? id,
      provider: this.id,
      capabilities: {
        contextWindow: 200000,
        vision: true,
        tools: true,
        // Anthropic не поддерживает response_format=json_object: строгий JSON
        // форсируется через tools. Честно отражаем это в capabilities, чтобы
        // capability-резолвер (Фаза 1.3) не считал Claude json-native.
        jsonMode: false,
        costHint: isHaiku ? "low" : "high",
        codingQuality: "frontier",
        speed: isHaiku ? "fast" : "medium"
      }
    };
  }

  private fallbackModels(): ProviderModel[] {
    // Фоллбэк, если /v1/models недоступен. Стабильные alias-id Anthropic
    // (`-latest`), а не выдуманные идентификаторы.
    return [
      this.describeModel("claude-3-5-sonnet-latest", "Claude 3.5 Sonnet"),
      this.describeModel("claude-3-5-haiku-latest", "Claude 3.5 Haiku"),
      this.describeModel("claude-3-opus-latest", "Claude 3 Opus")
    ];
  }
}

// --- Конвертация сообщений в формат Anthropic ---

type AnthropicImageSource =
  | { type: "base64"; media_type: string; data: string }
  | { type: "url"; url: string };

type AnthropicBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: AnthropicImageSource }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string };

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicBlock[];
}

export function extractSystemPrompt(messages: ChatMessage[]): string | undefined {
  const system = messages.find((message) => message.role === "system");
  if (!system) {
    return undefined;
  }
  const text = extractTextFromContent(system.content);
  return text.trim() ? text : undefined;
}

export function toAnthropicMessages(messages: ChatMessage[]): AnthropicMessage[] {
  const out: AnthropicMessage[] = [];
  for (const message of messages) {
    if (message.role === "system") {
      // system вынесен в отдельное поле запроса.
      continue;
    }

    if (message.role === "tool") {
      // role:"tool" → tool_result-блок внутри user-turn. Подряд идущие
      // tool-результаты сливаем в одно user-сообщение (требование Anthropic:
      // несколько tool_result в одном turn, чередование ролей).
      const block: AnthropicBlock = {
        type: "tool_result",
        tool_use_id: message.tool_call_id ?? "",
        content: extractTextFromContent(message.content)
      };
      const last = out[out.length - 1];
      if (
        last &&
        last.role === "user" &&
        Array.isArray(last.content) &&
        last.content.every((b) => b.type === "tool_result")
      ) {
        last.content.push(block);
      } else {
        out.push({ role: "user", content: [block] });
      }
      continue;
    }

    if (message.role === "assistant") {
      const blocks: AnthropicBlock[] = [];
      const text = extractTextFromContent(message.content);
      if (text.trim()) {
        blocks.push({ type: "text", text });
      }
      for (const call of message.tool_calls ?? []) {
        blocks.push({
          type: "tool_use",
          id: call.id,
          name: call.name,
          input: safeParseJson(call.arguments)
        });
      }
      out.push({ role: "assistant", content: blocks.length ? blocks : text });
      continue;
    }

    // role:"user"
    out.push({ role: "user", content: toUserContent(message.content) });
  }
  return out;
}

function toUserContent(content: string | ContentBlock[]): string | AnthropicBlock[] {
  if (typeof content === "string") {
    return content;
  }
  const blocks: AnthropicBlock[] = [];
  for (const block of content) {
    if (block.type === "text") {
      blocks.push({ type: "text", text: block.text });
    } else if (block.type === "image_url") {
      blocks.push({ type: "image", source: toImageSource(block.image_url.url) });
    }
  }
  return blocks;
}

export function toImageSource(url: string): AnthropicImageSource {
  // data URL (data:image/png;base64,XXXX) → base64-блок Anthropic.
  const match = /^data:([^;]+);base64,(.*)$/s.exec(url);
  if (match) {
    return { type: "base64", media_type: match[1], data: match[2] };
  }
  // Обычный URL — Anthropic поддерживает source.type=url.
  return { type: "url", url };
}

function toAnthropicTool(tool: ToolDefinition): Record<string, unknown> {
  return {
    name: tool.function.name,
    description: tool.function.description,
    input_schema: tool.function.parameters
  };
}

function toAnthropicToolChoice(
  choice: ChatRequest["tool_choice"]
): Record<string, unknown> | undefined {
  switch (choice) {
    case "required":
      return { type: "any" };
    case "none":
      return { type: "none" };
    case "auto":
      return { type: "auto" };
    default:
      return undefined;
  }
}

function parseAnthropicContent(
  raw: AnthropicMessageResponse
): { text: string; toolCalls: ToolCall[] } {
  const parts = raw.content ?? [];
  const textParts: string[] = [];
  const toolCalls: ToolCall[] = [];
  for (const part of parts) {
    if (part.type === "text" && typeof part.text === "string") {
      textParts.push(part.text);
    } else if (part.type === "tool_use") {
      toolCalls.push({
        id: part.id ?? "",
        name: part.name ?? "",
        // Нормализуем arguments к строке (как в openaiCompatible), чтобы
        // orchestrator делал JSON.parse единообразно.
        arguments: JSON.stringify(part.input ?? {})
      });
    }
  }
  return { text: textParts.join(""), toolCalls };
}

function extractUsage(raw: AnthropicMessageResponse): ChatResponse["usage"] | undefined {
  if (!raw.usage) {
    return undefined;
  }
  const inputTokens =
    typeof raw.usage.input_tokens === "number" ? raw.usage.input_tokens : undefined;
  const outputTokens =
    typeof raw.usage.output_tokens === "number" ? raw.usage.output_tokens : undefined;
  if (inputTokens === undefined && outputTokens === undefined) {
    return undefined;
  }
  return { inputTokens, outputTokens };
}

function safeParseJson(value: string): unknown {
  try {
    return value ? JSON.parse(value) : {};
  } catch {
    return {};
  }
}

interface AnthropicMessageResponse {
  id?: string;
  model?: string;
  stop_reason?: string;
  content?: Array<{
    type: string;
    text?: string;
    id?: string;
    name?: string;
    input?: unknown;
  }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
}