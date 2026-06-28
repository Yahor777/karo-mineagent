import type { ToolContract, ToolRisk } from "../tools/ToolContracts";
import type { ToolRegistry } from "../tools/toolRegistry";
import { registerToolSchema, unregisterToolSchema } from "../tools/toolSchemas";
import type { ToolDefinition } from "../providers/ProviderAdapter";
import type {
  McpConnectionStatus,
  McpContentBlock,
  McpTool,
  McpToolCallResult,
  NormalizedToolResult
} from "./types";
import { McpClient, type FetchImpl } from "./mcpClient";
import type { McpBridge } from "./bridgeTypes";

// Префикс всех minecraft-инструментов в MineAgent. Серверные имена (из tools/list
// мода mineagent-bridge) маппятся в minecraft.<serverName>, чтобы модель видела их
// в едином неймспейсе (отдельном от blockbench.*).
const PREFIX = "minecraft";

export interface MinecraftBridgeOptions {
  url: string;
  timeoutMs: number;
  fetchImpl?: FetchImpl;
  // Shared-token от мода (парсится из лога dev-клиента, см. logParser.ts).
  // undefined — подключение идёт без Authorization (мод отклонит).
  token?: string;
}

export interface MinecraftBridgeDependencies {
  registry: ToolRegistry;
}

export interface MinecraftBridgeSnapshot {
  status: McpConnectionStatus;
  url: string;
  toolCount: number;
  toolNames: string[];
  serverName?: string;
  error?: string;
  // Источник токена для UI (чтобы понять, был ли найден маркер в логе).
  hasToken: boolean;
}

/**
 * MinecraftBridge — соединяет живой dev-клиент Minecraft (мод mineagent-bridge,
// MCP-сервер внутри JVM) с реестром tools MineAgent.
 *
 * ОТЛИЧИЯ ОТ BlockbenchBridge (Этап 3):
 *   1. Risk-классификатор: ВСЕ minecraft-инструменты = game-control (меняют
 *      живой игровой мир). Даже get_state/screenshot — game-control с approval:
 *      технически read, но «захватывает состояние игры» → для прозрачности идёт
 *      через модалку (AGENTS.md Safety Rules). Это сознательное решение —
 *      см. комментарий в {@link classifyMinecraftRisk}.
 *   2. Shared-token: мод генерирует токен при старте (Bridge.generateToken),
 *      печатает в лог, расширение парсит через logParser.parseBridgeReadyLine и
 *      передаёт сюда. Шлётся в заголовке Authorization на каждый запрос.
 *   3. Lifecycle: после minecraft.runClient (approval game-control у вызывающего
 *      кода) → wait endpoint ready (health-poll с retry, см.
 *      {@link waitForEndpoint}) → connect.
 *
 * Подключение — это game-control-действие: вызывающий код (webview) проводит его
 * через gate.request(). Bridge НЕ делает approval сам, как и BlockbenchBridge.
 *
 * Инструменты регистрируются как dynamics из tools/list (единый паттерн с
 * Blockbench; сервер authoritative по своим инструментам). Статичные контракты
 * minecraft.* в ToolContracts.ts оставлены только для UI-подсказок — они НЕ
 * участвуют в dispatch (динамические переопределяют статику в ToolRegistry).
 */
export class MinecraftBridge implements McpBridge {
  private client: McpClient | undefined;
  private status: McpConnectionStatus = "disconnected";
  private serverName: string | undefined;
  private lastError: string | undefined;
  private readonly registeredToolNames: string[] = [];
  private readonly listeners = new Set<(snapshot: MinecraftBridgeSnapshot) => void>();

  public constructor(
    private readonly deps: MinecraftBridgeDependencies,
    private readonly options: MinecraftBridgeOptions
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

  public hasToken(): boolean {
    return Boolean(this.options.token);
  }

  public listRegisteredToolNames(): string[] {
    return [...this.registeredToolNames];
  }

  public snapshot(): MinecraftBridgeSnapshot {
    return {
      status: this.status,
      url: this.options.url,
      toolCount: this.registeredToolNames.length,
      toolNames: [...this.registeredToolNames],
      serverName: this.serverName,
      error: this.lastError,
      hasToken: this.hasToken()
    };
  }

  public onChange(listener: (snapshot: MinecraftBridgeSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Polling health-check endpoint'а мода. После runClient dev-клиент стартует
   * десятки секунд (MC JVM + reload); мод поднимает MCP-сервер и начинает
   * отвечать только когда клиент готов. Этот метод крутит ping до успеха или
   * до launchWaitMs — чтобы connect() не падал с connection-refused на старте.
   *
   * НЕ требует approval сам (только проверяет доступность) — вызывающий код уже
   * получил approval на runClient. Возвращает true если endpoint отвечает.
   */
  public async waitForEndpoint(launchWaitMs: number, signal?: AbortSignal): Promise<boolean> {
    const deadline = Date.now() + launchWaitMs;
    const interval = 1_000;
    while (Date.now() < deadline) {
      if (signal?.aborted) {
        return false;
      }
      if (await this.pingOnce(signal)) {
        return true;
      }
      await sleep(Math.min(interval, deadline - Date.now()), signal);
    }
    return false;
  }

  // Одноразовый health-check: POST initialize с тем же McpClient. Не меняем
  // статус моста — это проба доступности, а не подключение.
  private async pingOnce(signal?: AbortSignal): Promise<boolean> {
    const probe = new McpClient({
      url: this.options.url,
      timeoutMs: 3_000,
      fetchImpl: this.options.fetchImpl,
      displayName: "Minecraft MCP",
      extraHeaders: this.authHeaders()
    });
    try {
      await probe.connect(signal);
      await probe.disconnect();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Подключение к MCP-серверу: initialize → tools/list → регистрация контрактов.
   * НЕ делает approval сам (ответственность вызывающего кода через gate).
   * Предполагается, что endpoint уже поднят (через waitForEndpoint или
   * ручной запуск клиента пользователем).
   */
  public async connect(signal?: AbortSignal): Promise<MinecraftBridgeSnapshot> {
    if (this.status === "connected" || this.status === "connecting") {
      throw new Error(`Minecraft bridge уже в статусе ${this.status}.`);
    }
    if (!this.options.token) {
      throw new Error("Minecraft bridge: shared-token не задан (парсинг лога dev-клиента не дал результата).");
    }
    this.lastError = undefined;
    this.setStatus("connecting");

    try {
      this.client = new McpClient({
        url: this.options.url,
        timeoutMs: this.options.timeoutMs,
        fetchImpl: this.options.fetchImpl,
        displayName: "Minecraft MCP",
        extraHeaders: this.authHeaders()
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

  /** Заголовок Authorization для каждого запроса (shared-token от мода). */
  private authHeaders(): Record<string, string> {
    return this.options.token ? { Authorization: `Bearer ${this.options.token}` } : {};
  }

  // --- Регистрация инструментов из tools/list ---

  private registerTools(tools: McpTool[]): void {
    this.unregisterAll();
    for (const tool of tools) {
      if (!tool.name) {
        continue;
      }
      const prefixedName = `${PREFIX}.${tool.name}`;
      // ВСЕ minecraft-инструменты = game-control (меняют живой мир). Подробности
      // в classifyMinecraftRisk ниже.
      const risk = classifyMinecraftRisk(prefixedName, tool.description);
      const contract: ToolContract = {
        name: prefixedName,
        description: tool.description ?? `Minecraft dev bridge tool: ${tool.name}`,
        risk,
        requiresApproval: risk !== "read",
        inputSchema: tool.inputSchema ?? { type: "object" },
        outputSchema: { type: "object" }
      };
      const serverName = tool.name;
      const handler = this.buildHandler(serverName);
      this.deps.registry.registerDynamic(contract, handler);
      registerToolSchema(prefixedName, mcpToolToSchema(prefixedName, tool));
      this.registeredToolNames.push(prefixedName);
    }
  }

  private unregisterAll(): void {
    // Снимаем ТОЛЬКО свои схемы/контракты (точечно по имени), НЕ clearDynamicSchemas() —
    // иначе при подключении второго bridge'а убиваются чужие схемы. См. blockbenchBridge.
    for (const name of this.registeredToolNames) {
      this.deps.registry.unregisterDynamic(name);
      unregisterToolSchema(name);
    }
    this.registeredToolNames.length = 0;
  }

  // Handler, оборачивающий MCP tools/call в ToolHandler для dispatcher'а.
  // Нормализует McpToolCallResult → NormalizedToolResult для role:"tool".
  private buildHandler(serverName: string): (input: unknown) => Promise<NormalizedToolResult> {
    return async (input) => {
      if (!this.client || !this.isConnected()) {
        return { text: "Minecraft dev bridge отключён: инструмент недоступен.", isError: true };
      }
      const args = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
      let result: McpToolCallResult;
      try {
        result = await this.client.callTool({ name: serverName, arguments: args });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { text: `Minecraft MCP ошибка вызова ${serverName}: ${message}`, isError: true };
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
}

/**
 * Risk-классификатор для minecraft-инструментов. ВОЗВРАЩАЕТ ВСЕГДА game-control.
 *
 * Обоснование (правило AGENTS.md «Minecraft Dev Bridge»): bridge меняет живой
 * игровой мир (summon, эффекты, камера) и читает приватное состояние игры
 * (get_state, screenshot). Даже «read»-операции захватывают состояние мира,
 * которое пользователь может не хотеть раскрывать/менять без подтверждения.
 * Поэтому ВСЕ minecraft tool-call'ы идут через ApprovalGate с модалкой — это
 * сознательное решение в пользу прозрачности над токен-экономией approval-флуда.
 *
 * read-классификация зарезервирована на будущее, если появится категория
 * инструментов, которые заведомо безопасны (например registry-inspection без
 * доступа к миру) — тогда добавим whitelist имён. Сейчас единообразно game-control.
 */
export function classifyMinecraftRisk(name: string, description?: string): ToolRisk {
  void name;
  void description;
  return "game-control";
}

/**
 * Конвертирует McpToolCallResult → NormalizedToolResult. Идентичен blockbench-
 * версии по контракту (text/image/isError), но использует «Minecraft» в fallback-
 * тексте. image-блоки (screenshot → PNG base64) сохраняются для vision-фазы
 * (Этап 5).
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
    text = `Minecraft ${toolName}: пустой ответ (no text content).`;
  }
  if (result.isError && !text.toLowerCase().includes("error")) {
    text = `Minecraft ${toolName} вернул ошибку: ${text}`;
  }
  return {
    text,
    images: images.length ? images : undefined,
    isError: Boolean(result.isError)
  };
}

// Конвертация MCP inputSchema → wire ToolDefinition для tool-loop. Используется
// тестами; orchestrator собирает схемы через buildToolSchemas из динамического
// хранилища (как и для blockbench.*).
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

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0) {
      return resolve();
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
