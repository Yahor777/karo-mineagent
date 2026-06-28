// MCP-сервер MineAgent: JSON-RPC 2.0 over Streamable HTTP (server-side).
//
// Зеркало клиентской стороны (mcpClient.ts): принимает POST-запросы с JSON-RPC
// сообщениями, обрабатывает initialize / tools/list / tools/call /
// notifications/initialized. Transport — Node.js http module, localhost-only.
//
// Без внешних зависимостей. Bearer-token авторизация опциональна.

import * as http from "node:http";
import type {
  McpJsonRpcRequest,
  McpJsonRpcResponse,
  McpNotification,
  McpInitializeResult,
  McpToolListResult,
  McpToolCallResult,
  McpToolCallParams,
  McpContentBlock,
  McpJsonRpcError
} from "./types";
import {
  MINEAGENT_TOOLS,
  handleToolCall,
  normalizedToContentBlocks,
  type McpServerContext
} from "./mcpServerTools";

const PROTOCOL_VERSION = "2025-11-25";
const SERVER_NAME = "MineAgent MCP Server";
const SERVER_VERSION = "0.1.0";

// JSON-RPC error codes (spec).
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

export interface McpServerOptions {
  port: number;
  /** Bearer-токен; если задан — каждый запрос должен нести Authorization: Bearer <token>. */
  token?: string;
  /** Hostname для bind. По умолчанию 127.0.0.1 (localhost-only). */
  host?: string;
}

export class McpServer {
  private server: http.Server | undefined;
  private readonly sessions = new Map<string, boolean>();

  public constructor(
    private readonly options: McpServerOptions,
    private readonly contextRef: () => McpServerContext
  ) {}

  public get port(): number {
    return this.options.port;
  }

  public isRunning(): boolean {
    return Boolean(this.server?.listening);
  }

  public start(): Promise<void> {
    if (this.server) {
      throw new Error("MCP server is already running.");
    }
    return new Promise((resolve, reject) => {
      const host = this.options.host ?? "127.0.0.1";
      this.server = http.createServer((req, res) => {
        void this.handleRequest(req, res);
      });

      // Если listen() падает (EADDRINUSE, EACCES, и т.д.) — reject'им Promise,
      // иначе активация расширения зависнет навсегда.
      this.server.on("error", (err) => {
        process.stderr.write(`MCP server error: ${err.message}\n`);
        // Очищаем server, чтобы stop() не пытался закрыть уже мёртвый сокет.
        this.server = undefined;
        reject(err);
      });

      this.server.listen(this.options.port, host, () => {
        // После успешного listen убираем error-reject, чтобы последующие
        // рантайм-ошибки не реджектили уже завершённый Promise.
        this.server!.removeAllListeners("error");
        this.server!.on("error", (err) => {
          process.stderr.write(`MCP server runtime error: ${err.message}\n`);
        });
        resolve();
      });
    });
  }

  public stop(): Promise<void> {
    if (!this.server) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.server!.close(() => {
        this.server = undefined;
        this.sessions.clear();
        resolve();
      });
    });
  }

  // --- HTTP request handling ---

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // Только POST на единый endpoint (root path).
    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Method Not Allowed. Use POST." }));
      return;
    }

    // Bearer-токен проверяем до парсинга тела.
    if (this.options.token) {
      const auth = req.headers["authorization"] ?? "";
      if (auth !== `Bearer ${this.options.token}`) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized: invalid or missing bearer token." }));
        return;
      }
    }

    // Читаем тело.
    let body: string;
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      body = Buffer.concat(chunks).toString("utf8");
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify(this.makeError(null, PARSE_ERROR, "Failed to read request body.")));
      return;
    }

    let message: unknown;
    try {
      message = JSON.parse(body);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify(this.makeError(null, PARSE_ERROR, "Invalid JSON.")));
      return;
    }

    await this.handleJsonRpc(message, res);
  }

  private async handleJsonRpc(message: unknown, res: http.ServerResponse): Promise<void> {
    // Notification (без id) — не требует ответа.
    if (isNotification(message)) {
      await this.handleNotification(message, res);
      return;
    }

    // Request (с id) — требует result/error.
    if (isRequest(message)) {
      await this.handleRequest2(message, res);
      return;
    }

    // Некорректный формат.
    const id = typeof message === "object" && message !== null && "id" in message
      ? (message as { id: number | string }).id
      : null;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(this.makeError(id, INVALID_REQUEST, "Not a valid JSON-RPC 2.0 message.")));
  }

  private async handleNotification(
    message: McpNotification,
    res: http.ServerResponse
  ): Promise<void> {
    // notifications/initialized — клиент подтверждает готовность после initialize.
    // Ничего не делаем, просто 202 Accepted.
    if (message.method === "notifications/initialized") {
      res.writeHead(202);
      res.end();
      return;
    }
    // Прочие notification'ы — игнорируем (best-effort).
    res.writeHead(202);
    res.end();
  }

  private async handleRequest2(
    message: McpJsonRpcRequest,
    res: http.ServerResponse
  ): Promise<void> {
    const { id, method } = message;

    try {
      switch (method) {
        case "initialize":
          await this.handleInitialize(message, res);
          return;
        case "tools/list":
          this.sendResult(res, id, this.toolsListResult());
          return;
        case "tools/call":
          await this.handleToolsCall(message, res);
          return;
        case "ping":
          this.sendResult(res, id, {});
          return;
        default:
          this.sendResult(res, id, undefined, {
            code: METHOD_NOT_FOUND,
            message: `Method "${method}" is not supported.`
          });
          return;
      }
    } catch (error) {
      this.sendResult(res, id, undefined, {
        code: INTERNAL_ERROR,
        message: describeError(error)
      });
    }
  }

  private async handleInitialize(
    message: McpJsonRpcRequest,
    res: http.ServerResponse
  ): Promise<void> {
    // Генерируем session-id (простой UUID-подобный).
    const sessionId = `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    this.sessions.set(sessionId, true);

    const result: McpInitializeResult = {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {
        tools: { listChanged: false }
      },
      serverInfo: {
        name: SERVER_NAME,
        version: SERVER_VERSION
      }
    };

    res.writeHead(200, {
      "Content-Type": "application/json",
      "Mcp-Session-Id": sessionId,
      "MCP-Protocol-Version": PROTOCOL_VERSION
    });
    res.end(JSON.stringify(this.makeResponse(message.id, result)));
  }

  private toolsListResult(): McpToolListResult {
    return { tools: MINEAGENT_TOOLS };
  }

  private async handleToolsCall(
    message: McpJsonRpcRequest,
    res: http.ServerResponse
  ): Promise<void> {
    const params = message.params as McpToolCallParams | undefined;
    if (!params || !params.name) {
      this.sendResult(res, message.id, undefined, {
        code: INVALID_PARAMS,
        message: "tools/call requires 'name'."
      });
      return;
    }

    const ctx = this.contextRef();
    try {
      const result = await handleToolCall(params.name, params.arguments, ctx);
      const contentBlocks = normalizedToContentBlocks(result);
      const toolCallResult: McpToolCallResult = {
        content: contentBlocks,
        isError: result.isError
      };
      this.sendResult(res, message.id, toolCallResult);
    } catch (error) {
      // Semantic error — возвращаем как content с isError=true, не как JSON-RPC error.
      const errorBlock: McpContentBlock = { type: "text", text: `Error: ${describeError(error)}` };
      const toolCallResult: McpToolCallResult = {
        content: [errorBlock],
        isError: true
      };
      this.sendResult(res, message.id, toolCallResult);
    }
  }

  // --- Response helpers ---

  private sendResult(
    res: http.ServerResponse,
    id: number | string,
    result?: unknown,
    error?: McpJsonRpcError
  ): void {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(this.makeResponse(id, result, error)));
  }

  private makeResponse(
    id: number | string,
    result?: unknown,
    error?: McpJsonRpcError
  ): McpJsonRpcResponse {
    return {
      jsonrpc: "2.0",
      id,
      ...(result !== undefined ? { result } : {}),
      ...(error !== undefined ? { error } : {})
    };
  }

  private makeError(
    id: number | string | null,
    code: number,
    message: string
  ): { jsonrpc: "2.0"; id: number | string | null; error: McpJsonRpcError } {
    return { jsonrpc: "2.0", id, error: { code, message } };
  }
}

// --- Type guards ---

function isRequest(msg: unknown): msg is McpJsonRpcRequest {
  return (
    typeof msg === "object" &&
    msg !== null &&
    (msg as Record<string, unknown>).jsonrpc === "2.0" &&
    "id" in msg &&
    "method" in msg
  );
}

function isNotification(msg: unknown): msg is McpNotification {
  return (
    typeof msg === "object" &&
    msg !== null &&
    (msg as Record<string, unknown>).jsonrpc === "2.0" &&
    !("id" in msg) &&
    "method" in msg
  );
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
