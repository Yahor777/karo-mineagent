import type { ToolContract, ToolRisk } from "../tools/ToolContracts";
import type { ToolRegistry } from "../tools/toolRegistry";
import { registerToolSchema, unregisterToolSchema } from "../tools/toolSchemas";
import type { ToolDefinition } from "../providers/ProviderAdapter";
import type {
  McpConnectionStatus,
  McpContentBlock,
  McpTool,
  McpToolCallResult,
  McpToolInputSchema,
  NormalizedToolResult
} from "./types";
import { BlockbenchMcpClient, McpClient, type FetchImpl } from "./mcpClient";
import type { McpBridge } from "./bridgeTypes";

// Префикс всех blockbench-инструментов в MineAgent. Серверные имена (из tools/list)
// маппятся в blockbench.<serverName>, чтобы модель видела их в едином неймспейсе.
const PREFIX = "blockbench";

export interface BlockbenchBridgeOptions {
  url: string;
  timeoutMs: number;
  fetchImpl?: FetchImpl;
}

export interface BlockbenchBridgeDependencies {
  registry: ToolRegistry;
}

export interface BlockbenchBridgeSnapshot {
  status: McpConnectionStatus;
  url: string;
  toolCount: number;
  toolNames: string[];
  serverName?: string;
  error?: string;
}

/**
 * BlockbenchBridge — соединяет живой Blockbench (через MCP-клиент) с реестром
 * tools MineAgent. При подключении: tools/list сервера → регистрация контрактов
 * blockbench.* с risk-классификацией (read для render/screenshot, write для
 * мутирующих операций) + wire-схемы для tool-loop. При отключении — снимает всё.
 *
 * Прокси tool-call'ов идёт через СУЩЕСТВУЮЩИЙ ToolDispatcher: bridge регистрирует
 * handler'ом вызов client.callTool(...). Dispatcher на основе контракта решает
 * approval: read → без модалки, write → через ApprovalGate (как и остальное).
 *
 * Подключение — это game-control-действие: вызывающий код (webview/orchestrator)
 * проводит его через dispatcher.dispatch("blockbench.connect", ...) либо через
 * прямой gate.request() — bridge НЕ делает approval сам, чтобы не дублировать
 * round-trip-логику.
 */
export class BlockbenchBridge implements McpBridge {
  private client: McpClient | undefined;
  private status: McpConnectionStatus = "disconnected";
  private serverName: string | undefined;
  private lastError: string | undefined;
  private readonly registeredToolNames: string[] = [];
  // serverName → inputSchema. Нужно для coerceArgsToSchema: модели (особенно
  // reasoning) часто шлют массив/число строкой ("[0,14,0]", "64"). Перед
  // tools/call приводим такие значения к типам, объявленным в схеме.
  private readonly toolSchemas = new Map<string, McpToolInputSchema>();
  private readonly listeners = new Set<(snapshot: BlockbenchBridgeSnapshot) => void>();

  public constructor(
    private readonly deps: BlockbenchBridgeDependencies,
    private readonly options: BlockbenchBridgeOptions
  ) {}

  public isConnected(): boolean {
    return this.status === "connected";
  }

  public getStatus(): McpConnectionStatus {
    return this.status;
  }

  public getUrl(): string {
    return this.options.url;
  }

  public listRegisteredToolNames(): string[] {
    return [...this.registeredToolNames];
  }

  public snapshot(): BlockbenchBridgeSnapshot {
    return {
      status: this.status,
      url: this.options.url,
      toolCount: this.registeredToolNames.length,
      toolNames: [...this.registeredToolNames],
      serverName: this.serverName,
      error: this.lastError
    };
  }

  public onChange(listener: (snapshot: BlockbenchBridgeSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Подключение к MCP-серверу: initialize → tools/list → регистрация контрактов.
   * НЕ делает approval сам (это ответственность вызывающего кода через gate).
   * При ошибке — статус "error", контракты не регистрируются.
   */
  public async connect(signal?: AbortSignal): Promise<BlockbenchBridgeSnapshot> {
    if (this.status === "connected" || this.status === "connecting") {
      throw new Error(`Blockbench уже в статусе ${this.status}.`);
    }
    this.lastError = undefined;
    this.setStatus("connecting");

    try {
      this.client = new BlockbenchMcpClient({
        url: this.options.url,
        timeoutMs: this.options.timeoutMs,
        fetchImpl: this.options.fetchImpl,
        // displayName для диагностических сообщений McpClient (раньше хардкод
        // "Blockbench MCP" внутри клиента; после обобщения — параметризуется).
        displayName: "Blockbench MCP"
      });
      const init = await this.client.connect(signal);
      this.serverName = init.serverInfo?.name;
      const tools = await this.client.listTools(true, signal);
      this.registerTools(tools);
      this.setStatus("connected");
      return this.snapshot();
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.unregisterAll();
      this.client = undefined;
      this.setStatus("error");
      throw error;
    }
  }

  /** Отключение: клиент.disconnect() + снятие всех динамических контрактов/схем. */
  public async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.disconnect();
    }
    this.unregisterAll();
    this.client = undefined;
    this.serverName = undefined;
    this.setStatus("disconnected");
  }

  // --- Регистрация инструментов из tools/list ---

  private registerTools(tools: McpTool[]): void {
    this.unregisterAll();
    for (const tool of tools) {
      if (!tool.name) {
        continue;
      }
      const prefixedName = `${PREFIX}.${tool.name}`;
      const risk = classifyRisk(prefixedName, tool.description);
      const contract: ToolContract = {
        name: prefixedName,
        description: tool.description ?? `Blockbench tool: ${tool.name}`,
        risk,
        requiresApproval: risk !== "read",
        inputSchema: tool.inputSchema ?? { type: "object" },
        outputSchema: { type: "object" }
      };
      const serverName = tool.name;
      const handler = this.buildHandler(serverName);
      this.deps.registry.registerDynamic(contract, handler);
      registerToolSchema(prefixedName, mcpToolToSchema(prefixedName, tool));
      this.toolSchemas.set(serverName, tool.inputSchema ?? { type: "object" });
      this.registeredToolNames.push(prefixedName);
    }
  }

  private unregisterAll(): void {
    // Снимаем ТОЛЬКО свои схемы/контракты (точечно по имени). Раньше здесь был
    // вызов clearDynamicSchemas() — но он стирает ВООБЩЕ ВСЕ динамические схемы,
    // включая схемы ДРУГИХ bridge'ей (например minecraft.* при подключении
    // второго моста). clearDynamicSchemas() оставлен только для полного reset
    // в тестах/холодном старте. См. test/toolLoopMinecraft.test.ts multi-bridge.
    for (const name of this.registeredToolNames) {
      this.deps.registry.unregisterDynamic(name);
      unregisterToolSchema(name);
    }
    this.registeredToolNames.length = 0;
    this.toolSchemas.clear();
  }

  // Handler, оборачивающий MCP tools/call в ToolHandler для dispatcher'а.
  // Нормализует McpToolCallResult → NormalizedToolResult для role:"tool".
  private buildHandler(serverName: string): (input: unknown) => Promise<NormalizedToolResult> {
    return async (input) => {
      if (!this.client || !this.isConnected()) {
        return { text: "Blockbench отключён: инструмент недоступен.", isError: true };
      }
      const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
      // ФИКС реального бага: модели (особенно reasoning) часто шлют массив/число
      // строкой — например rotation:"[-25,0,0]", origin:"[0,14,0]", uv:"[0,0]".
      // Blockbench MCP-сервер ждёт массивы/числа и отклоняет такие вызовы.
      // Приводим значения к типам из inputSchema перед tools/call.
      const args = coerceArgsToSchema(raw, this.toolSchemas.get(serverName));
      let result: McpToolCallResult;
      try {
        result = await this.client.callTool({ name: serverName, arguments: args });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { text: `Blockbench MCP ошибка вызова ${serverName}: ${message}`, isError: true };
      }
      return normalizeCallResult(result, serverName);
    };
  }

  private setStatus(status: McpConnectionStatus): void {
    this.status = status;
    const snapshot = this.snapshot();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        // Подписчик не должен валить bridge.
      }
    }
  }

  /**
   * Helper для пункта 6 задачи (render tool): находит blockbench.*-инструмент,
   * который рендерит модель в изображение (по имени/описанию). Используется
   * orchestrator'ом/vision-фазой для захвата base64 PNG без угадывания.
   */
  public findRenderTool(): string | undefined {
    return this.registeredToolNames.find((name) => {
      const lower = name.toLowerCase();
      return lower.includes("render") || lower.includes("screenshot") || lower.includes("preview");
    });
  }
}

/**
 * Risk-классификатор для blockbench-инструментов. Heuristic по имени/описанию
 * (НЕ вызывает модель — это было бы пожаром токенов). render/screenshot/export-image
 * → read (без approval); всё, что меняет проект (модель/куб/кость/keyframe/
 * animation/texture-мутирующее) → write (через ApprovalGate).
 */
export function classifyRisk(name: string, description?: string): ToolRisk {
  const haystack = `${name} ${description ?? ""}`.toLowerCase();
  const readPatterns = [
    "render",
    "screenshot",
    "preview",
    "export.*image",
    "export_image",
    "exportimage",
    "get_",
    "list_",
    "read_"
  ];
  for (const pattern of readPatterns) {
    if (pattern.includes(".*")) {
      if (new RegExp(pattern).test(haystack)) {
        return "read";
      }
    } else if (haystack.includes(pattern)) {
      return "read";
    }
  }
  return "write";
}

/**
 * Конвертирует McpToolCallResult → NormalizedToolResult.
 * - text-блоки склеиваются в одно поле text (для role:"tool").
 * - image-блоки (base64 PNG) сохраняются в images[] для будущей vision-передачи
 *   (Этап 5). На Этапе 3 они просто лежат в результате, не теряя данные.
 * - isError=true → semantic-ошибка (не throw): модель видит текст из content.
 */
export function normalizeCallResult(result: McpToolCallResult, toolName: string): NormalizedToolResult {
  const textParts: string[] = [];
  const images: Array<{ data: string; mimeType: string }> = [];
  for (const block of Array.isArray(result.content) ? result.content : []) {
    const typed = block as McpContentBlock;
    if (typed.type === "text") {
      textParts.push(typed.text);
    } else if (typed.type === "image") {
      images.push({ data: typed.data, mimeType: typed.mimeType });
    } else if (typed.type === "resource" && typed.resource.text) {
      textParts.push(typed.resource.text);
    }
  }
  let text = textParts.join("\n").trim();
  if (!text) {
    text = `Blockbench ${toolName}: пустой ответ (no text content).`;
  }
  if (result.isError && !text.toLowerCase().includes("error")) {
    text = `Blockbench ${toolName} вернул ошибку: ${text}`;
  }
  return {
    text,
    images: images.length ? images : undefined,
    isError: Boolean(result.isError)
  };
}

// Конвертация MCP inputSchema → wire ToolDefinition для tool-loop. Используется
// тестами и может использоваться bridge'ом если потребуется явная регистрация
// схемы (сейчас registerDynamic + inputSchema достаточно; orchestrator собирает
// схемы через buildToolSchemas из динамического хранилища).
export function mcpToolToSchema(prefixedName: string, tool: McpTool): ToolDefinition {
  return {
    type: "function",
    function: {
      name: prefixedName,
      description: tool.description ?? prefixedName,
      parameters: tool.inputSchema ?? { type: "object", properties: {} }
    }
  };
}

/**
 * Приводит аргументы tool-вызова к типам, объявленным в inputSchema.
 *
 * Зачем: LLM (особенно reasoning-модели) часто сериализуют вложенные значения
 * строкой — rotation:"[-25,0,0]", origin:"[0,14,0]", size:"[10,10,6]", uv:"[0,0]",
 * texture_width:"64". Blockbench MCP-сервер ожидает массивы/числа и отклоняет
 * такие вызовы (наблюдаемый баг «rotation передаётся строкой вместо массива»).
 * Эта функция чинит вызов на стороне моста, а не заставляет обходить инструмент.
 *
 * Безопасно: приводим ТОЛЬКО когда схема явно объявляет тип и значение строкой
 * действительно парсится в нужный тип. Любая неоднозначность → оставляем как есть.
 * Неизвестные схеме поля проходят без изменений.
 */
export function coerceArgsToSchema(
  args: Record<string, unknown>,
  schema: McpToolInputSchema | undefined
): Record<string, unknown> {
  const properties = schema?.properties;
  if (!properties || typeof properties !== "object") {
    return args;
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    const propSchema = (properties as Record<string, unknown>)[key];
    out[key] = coerceValue(value, propSchema);
  }
  return out;
}

// Возвращает объявленный JSON-Schema тип свойства ("array"/"number"/...), или
// undefined если тип не задан/неоднозначен (oneOf/anyOf и т.п. — не трогаем).
function schemaType(propSchema: unknown): string | undefined {
  if (!propSchema || typeof propSchema !== "object") {
    return undefined;
  }
  const t = (propSchema as { type?: unknown }).type;
  return typeof t === "string" ? t : undefined;
}

function coerceValue(value: unknown, propSchema: unknown): unknown {
  const type = schemaType(propSchema);
  if (!type) {
    return value;
  }
  // Уже корректный тип — ничего не делаем.
  if (type === "array" && Array.isArray(value)) {
    return coerceArrayItems(value, propSchema);
  }
  if (type === "object" && value && typeof value === "object" && !Array.isArray(value)) {
    return value;
  }
  if ((type === "number" || type === "integer") && typeof value === "number") {
    return value;
  }
  if (type === "boolean" && typeof value === "boolean") {
    return value;
  }

  // Главный случай бага: строка вместо массива/числа/булева/объекта.
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (type === "array" || type === "object") {
      const parsed = tryParseJson(trimmed);
      if (parsed !== undefined) {
        if (type === "array" && Array.isArray(parsed)) {
          return coerceArrayItems(parsed, propSchema);
        }
        if (type === "object" && parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return parsed;
        }
      }
      return value; // не распарсилось в нужный тип — оставляем как есть
    }
    if (type === "number" || type === "integer") {
      if (trimmed !== "" && Number.isFinite(Number(trimmed))) {
        const num = Number(trimmed);
        return type === "integer" ? Math.trunc(num) : num;
      }
      return value;
    }
    if (type === "boolean") {
      if (trimmed === "true") {
        return true;
      }
      if (trimmed === "false") {
        return false;
      }
      return value;
    }
  }
  return value;
}

// Приводит элементы массива к типу items.type (например массив чисел, где
// модель прислала ["-25","0","0"]). Только когда items.type задан.
function coerceArrayItems(arr: unknown[], propSchema: unknown): unknown[] {
  const items = propSchema && typeof propSchema === "object" ? (propSchema as { items?: unknown }).items : undefined;
  if (!schemaType(items)) {
    return arr;
  }
  return arr.map((el) => coerceValue(el, items));
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
