// Клиентские типы Model Context Protocol (MCP).
//
// Реализуют только wire-формат клиентской стороны: JSON-RPC 2.0 over Streamable
// HTTP (см. docs/source-ledger.md, entry-6/7 — официальная спецификация
// modelcontextprotocol.io spec 2025-11-25). Код blockbench-mcp-plugin (GPL-3.0)
// НЕ копируется — здесь только независимая реализация протокола.

// JSON-RPC 2.0: request (с id — сервер обязан ответить result/error).
export interface McpJsonRpcRequest<P = unknown> {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: P;
}

// JSON-RPC 2.0: notification (без id — сервер не отвечает; best-effort).
export interface McpNotification<P = unknown> {
  jsonrpc: "2.0";
  method: string;
  params?: P;
}

// JSON-RPC 2.0: успешный ответ. result зависит от метода.
export interface McpJsonRpcResponse<R = unknown> {
  jsonrpc: "2.0";
  id: number | string;
  result?: R;
  error?: McpJsonRpcError;
}

export interface McpJsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

// --- initialize ---

export interface McpClientInfo {
  name: string;
  version: string;
}

export interface McpClientCapabilities {
  // Минимальный клиент: никаких extras. Расширяем при росте потребностей.
  roots?: { listChanged?: boolean };
  sampling?: Record<string, never>;
}

export interface McpInitializeParams {
  protocolVersion: string;
  capabilities: McpClientCapabilities;
  clientInfo: McpClientInfo;
}

export interface McpServerInfo {
  name: string;
  version?: string;
}

export interface McpInitializeResult {
  protocolVersion: string;
  capabilities: Record<string, unknown>;
  serverInfo: McpServerInfo;
}

// --- tools/list ---

export interface McpToolInputSchema {
  type: "object";
  properties?: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
}

// Описание одного tool'а сервера — из tools/list. Это данные (не код),
// их можно читать и перечислять без нарушения лицензии.
export interface McpTool {
  name: string;
  description?: string;
  inputSchema: McpToolInputSchema;
}

export interface McpToolListResult {
  tools: McpTool[];
}

// --- tools/call ---

export interface McpToolCallParams {
  name: string;
  arguments?: Record<string, unknown>;
}

// Блоки content из tools/call — type-discriminated union по спецификации.
export type McpContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "resource"; resource: { uri: string; mimeType?: string; text?: string; blob?: string } };

export interface McpToolCallResult {
  content: McpContentBlock[];
  // semantic-ошибка (не throw): модель должна видеть текст из content.
  isError?: boolean;
}

// --- Статус подключения (для UI/bridge) ---

export type McpConnectionStatus = "disconnected" | "connecting" | "connected" | "error";

// Нормализованный результат вызова blockbench.*-tool'а для MineAgent: то, что
// кладётся в role:"tool" через dispatcher. Текст склеивается; image-блоки
// сохраняются отдельным полем для будущей vision-передачи (Этап 5).
export interface NormalizedToolResult {
  text: string;
  images?: Array<{ data: string; mimeType: string }>;
  isError: boolean;
}
