import type {
  McpClientCapabilities,
  McpClientInfo,
  McpConnectionStatus,
  McpInitializeResult,
  McpJsonRpcError,
  McpJsonRpcRequest,
  McpJsonRpcResponse,
  McpNotification,
  McpTool,
  McpToolCallParams,
  McpToolCallResult,
  McpToolListResult
} from "./types";

// Дефолтная версия протокола MCP, которую клиент предлагает при initialize.
// Сервер может вернуть другую (negotiated) — фиксируем ту, что вернул.
const DEFAULT_PROTOCOL_VERSION = "2025-11-25";

// Инъекция fetch — для мока в тестах (как globalThis.fetch в cloudflareProvider).
// По умолчанию берётся глобальный fetch (Node 20+).
export type FetchImpl = typeof fetch;

export interface McpClientOptions {
  url: string;
  timeoutMs: number;
  clientInfo?: McpClientInfo;
  fetchImpl?: FetchImpl;
  // Человекочитаемое имя сервера для диагностических сообщений (ошибки/лог).
  // По умолчанию "MCP" — BlockbenchBridge передаёт "Blockbench MCP",
  // MinecraftBridge — "Minecraft MCP".
  displayName?: string;
  // Дополнительные заголовки на каждый запрос. Используется MinecraftBridge
  // для передачи shared-token (Authorization: Bearer <token>), который мод
  // mineagent-bridge проверяет на localhost-сервере (AGENTS.md Safety Rules).
  extraHeaders?: Record<string, string>;
}

/**
 * @deprecated Внутренний alias для обратной совместимости с BlockbenchBridge и
 * его тестами. Новый код должен использовать {@link McpClient} напрямую.
 * Сохранён как type-alias, чтобы `import { BlockbenchMcpClient }` продолжал
 * работать без изменений.
 */
export type BlockbenchMcpClientOptions = McpClientOptions;

/**
 * McpClient — клиентская сторона MCP over Streamable HTTP (generic).
 *
 * Обобщение исходного BlockbenchMcpClient (Этап 3) для двух потребителей
 * (BlockbenchBridge — Этап 3, MinecraftBridge — Этап 4). Wire-формат протокола
 * идентичен (см. docs/source-ledger.md entry-6/7): initialize →
 * notifications/initialized → tools/list → tools/call. НЕ запускает сервер —
 * подключается к уже запущенному.
 *
 * Streamable HTTP (MCP spec 2025-11-25): каждый JSON-RPC message — отдельный POST;
 * Accept перечисляет application/json и text/event-stream; ответ может прийти как
 * plain-JSON либо как text/event-stream (одно data:{...}-событие). Сервер может
 * выдать MCP-Session-Id — тогда клиент обязан слать его в последующих запросах.
 *
 * displayName подставляется в диагностические сообщения (раньше хардкод
 * "Blockbench MCP"), extraHeaders — на каждый запрос (token для Minecraft).
 */
export class McpClient {
  private status: McpConnectionStatus = "disconnected";
  private protocolVersion: string | undefined;
  private sessionId: string | undefined;
  private nextId = 1;
  private toolsCache: McpTool[] | undefined;
  private readonly fetchImpl: FetchImpl;
  private readonly clientInfo: McpClientInfo;
  private readonly displayName: string;
  private readonly extraHeaders: Record<string, string>;
  // Подписчики на смену статуса (для UI/bridge).
  private readonly statusListeners = new Set<(status: McpConnectionStatus) => void>();

  public constructor(private readonly options: McpClientOptions) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.clientInfo = options.clientInfo ?? { name: "mineagent-workbench", version: "0.1.0" };
    this.displayName = options.displayName ?? "MCP";
    this.extraHeaders = options.extraHeaders ?? {};
  }

  public isConnected(): boolean {
    return this.status === "connected";
  }

  public getStatus(): McpConnectionStatus {
    return this.status;
  }

  public getUrl(): string {
    return this.options.url;
  }

  public getToolsCache(): McpTool[] | undefined {
    return this.toolsCache;
  }

  public onStatusChange(listener: (status: McpConnectionStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  private setStatus(status: McpConnectionStatus): void {
    this.status = status;
    for (const listener of this.statusListeners) {
      try {
        listener(status);
      } catch {
        // Подписчик не должен валить клиент.
      }
    }
  }

  /**
   * Полный handshake: initialize → notifications/initialized. После успеха —
   * зафиксированы protocolVersion и (опционально) sessionId.
   */
  public async connect(signal?: AbortSignal): Promise<McpInitializeResult> {
    if (this.status === "connected" || this.status === "connecting") {
      throw new Error(`${this.displayName} уже в статусе ${this.status}.`);
    }
    this.setStatus("connecting");
    try {
      const capabilities: McpClientCapabilities = {};
      const result = await this.request<McpInitializeResult>("initialize", {
        protocolVersion: DEFAULT_PROTOCOL_VERSION,
        capabilities,
        clientInfo: this.clientInfo
      }, signal);

      if (!result.protocolVersion) {
        throw new Error("initialize: сервер не вернул protocolVersion.");
      }
      this.protocolVersion = result.protocolVersion;

      // Notification (без id) — best-effort. По спецификации клиент обязан его
      // послать после initialize, прежде чем звать другие методы.
      await this.notify("notifications/initialized", {}, signal);

      this.setStatus("connected");
      return result;
    } catch (error) {
      this.setStatus("error");
      throw error;
    }
  }

  /** tools/list с кэшированием результата. */
  public async listTools(refresh = false, signal?: AbortSignal): Promise<McpTool[]> {
    if (!refresh && this.toolsCache) {
      return this.toolsCache;
    }
    const result = await this.request<McpToolListResult>("tools/list", {}, signal);
    const tools = Array.isArray(result.tools) ? result.tools : [];
    this.toolsCache = tools;
    return tools;
  }

  /** tools/call. Возвращает результат целиком (content + isError). */
  public async callTool(params: McpToolCallParams, signal?: AbortSignal): Promise<McpToolCallResult> {
    return this.request<McpToolCallResult>("tools/call", params, signal);
  }

  /** Лёгкий health-check: tools/list без обновления кэша. */
  public async ping(signal?: AbortSignal): Promise<boolean> {
    try {
      await this.request<McpToolListResult>("tools/list", {}, signal);
      return true;
    } catch {
      return false;
    }
  }

  /** Завершение сессии: best-effort DELETE (сервер может ответить 405). */
  public async disconnect(): Promise<void> {
    if (this.status === "disconnected") {
      return;
    }
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.min(this.options.timeoutMs, 5_000));
      try {
        await this.fetchImpl(this.options.url, {
          method: "DELETE",
          headers: {
            ...this.extraHeaders,
            ...this.buildHeaders(/* includeSession */ true)
          },
          signal: controller.signal
        });
      } finally {
        clearTimeout(timer);
      }
    } catch {
      // disconnect — best-effort; игнорируем сетевые ошибки/405.
    }
    this.sessionId = undefined;
    this.protocolVersion = undefined;
    this.toolsCache = undefined;
    this.setStatus("disconnected");
  }

  // --- Внутренний transport ---

  private async request<R>(method: string, params: unknown, signal?: AbortSignal): Promise<R> {
    try {
      return await this.sendRequest<R>(method, params, signal);
    } catch (error) {
      // Самовосстановление при рассинхроне сессии: переинициализируемся и
      // повторяем исходный запрос ОДИН раз. Сам initialize не реентерим.
      if (error instanceof McpSessionConflictError && method !== "initialize") {
        await this.reinitialize(signal);
        return await this.sendRequest<R>(method, params, signal);
      }
      throw error;
    }
  }

  private async sendRequest<R>(method: string, params: unknown, signal?: AbortSignal): Promise<R> {
    const id = this.nextId++;
    const message: McpJsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    const response = await this.postJson(message, signal);
    if (response.error) {
      throw new McpRequestError(method, response.error);
    }
    return (response.result ?? {}) as R;
  }

  // Повторный handshake после сброса сессии (без проверок статуса connect()).
  private async reinitialize(signal?: AbortSignal): Promise<void> {
    this.sessionId = undefined;
    this.protocolVersion = undefined;
    const capabilities: McpClientCapabilities = {};
    const result = await this.sendRequest<McpInitializeResult>("initialize", {
      protocolVersion: DEFAULT_PROTOCOL_VERSION,
      capabilities,
      clientInfo: this.clientInfo
    }, signal);
    if (result.protocolVersion) {
      this.protocolVersion = result.protocolVersion;
    }
    await this.notify("notifications/initialized", {}, signal);
    this.setStatus("connected");
  }

  private async notify(method: string, params: unknown, signal?: AbortSignal): Promise<void> {
    const message: McpNotification = { jsonrpc: "2.0", method, params };
    // Notification не требует JSON-RPC ответа; шлём и не ждём result.
    await this.postRaw(message, signal, /* expectResponse */ false);
  }

  private async postJson(message: McpJsonRpcRequest | McpNotification, signal?: AbortSignal): Promise<McpJsonRpcResponse> {
    const parsed = await this.postRaw(message, signal, true);
    return parsed as McpJsonRpcResponse;
  }

  // Отправляет POST и возвращает разобранный JSON-RPC ответ. expectResponse=false
  // для notifications (не парсим тело — оно может быть пустым/accepted-ответом).
  private async postRaw(
    message: McpJsonRpcRequest | McpNotification,
    signal: AbortSignal | undefined,
    expectResponse: boolean
  ): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs);
    // Связываем внешний и внутренний сигналы.
    if (signal) {
      if (signal.aborted) {
        controller.abort();
      } else {
        signal.addEventListener("abort", () => controller.abort(), { once: true });
      }
    }

    let response: Response;
    try {
      response = await this.fetchImpl(this.options.url, {
        method: "POST",
        headers: {
          ...this.extraHeaders,
          ...this.buildHeaders(true),
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream"
        },
        body: JSON.stringify(message),
        signal: controller.signal
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`${this.displayName}: таймаут/abort запроса (${this.options.timeoutMs}мс).`);
      }
      throw new Error(`${this.displayName}: сетевая ошибка — ${describeError(error)}.`);
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      // 409 Conflict / 404 Not Found на HTTP-транспорте MCP означают рассинхрон
      // сессии: сервер потерял/закрыл сессию, а мы шлём устаревший MCP-Session-Id
      // (либо initialize пришёл при «занятой» сессии). Сбрасываем сессию и сигналим
      // типизированной ошибкой, чтобы request() мог переинициализироваться и повторить.
      if (response.status === 409 || response.status === 404) {
        this.sessionId = undefined;
        throw new McpSessionConflictError(this.displayName, response.status, response.statusText);
      }
      throw new Error(`${this.displayName}: HTTP ${response.status} ${response.statusText}.`);
    }

    // После initialize сервер может выдать MCP-Session-Id — фиксируем.
    const sessionIdHeader = response.headers.get("mcp-session-id");
    if (sessionIdHeader) {
      this.sessionId = sessionIdHeader;
    }

    if (!expectResponse) {
      return undefined;
    }

    const contentType = response.headers.get("content-type") ?? "";
    const raw = await response.text();
    if (!raw.trim()) {
      throw new Error(`${this.displayName}: пустой ответ сервера.`);
    }
    if (contentType.includes("text/event-stream")) {
      return parseSseSingleMessage(raw);
    }
    return JSON.parse(raw);
  }

  private buildHeaders(includeSession: boolean): Record<string, string> {
    const headers: Record<string, string> = {};
    if (includeSession && this.protocolVersion) {
      headers["MCP-Protocol-Version"] = this.protocolVersion;
    }
    if (includeSession && this.sessionId) {
      headers["MCP-Session-Id"] = this.sessionId;
    }
    return headers;
  }
}

/**
 * Ошибка JSON-RPC уровня протокола (response.error от сервера). Отличается от
 * транспортной ошибки: модель должна видеть code+message, чтобы реагировать.
 */
export class McpRequestError extends Error {
  public constructor(
    public readonly method: string,
    public readonly rpcError: McpJsonRpcError
  ) {
    super(`MCP ${method}: ${rpcError.code} ${rpcError.message}`);
    this.name = "McpRequestError";
  }
}

/**
 * Транспортный конфликт сессии (HTTP 409/404). Клиент сбрасывает sessionId и
 * пытается переинициализироваться + повторить запрос один раз.
 */
export class McpSessionConflictError extends Error {
  public constructor(
    displayName: string,
    public readonly status: number,
    statusText: string
  ) {
    super(`${displayName}: сессия рассинхронизирована (HTTP ${status} ${statusText}). Переподключаюсь.`);
    this.name = "McpSessionConflictError";
  }
}

// Разбирает SSE-стрим и возвращает первое data:{...}-событие как JSON-RPC ответ.
// Streamable HTTP (spec 2025-11-25): сервер может отдать ответ как text/event-stream,
// клиент обязан уметь разбирать оба варианта.
function parseSseSingleMessage(raw: string): unknown {
  const lines = raw.split(/\r?\n/);
  const dataLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
    // Пустая строка = конец события; берём первое готовое.
    if (line === "" && dataLines.length > 0) {
      break;
    }
  }
  if (dataLines.length === 0) {
    throw new Error("MCP: SSE-ответ без data-события.");
  }
  const json = dataLines.join("\n");
  return JSON.parse(json);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * @deprecated Backward-compat alias. BlockbenchBridge (Этап 3) и его тесты
 * импортируют `BlockbenchMcpClient` — после обобщения в {@link McpClient}
 * оставляем алиас, чтобы не трогать рабочий код Этапа 3. Новый код (Этап 4,
 * MinecraftBridge) использует McpClient напрямую.
 */
export const BlockbenchMcpClient = McpClient;
