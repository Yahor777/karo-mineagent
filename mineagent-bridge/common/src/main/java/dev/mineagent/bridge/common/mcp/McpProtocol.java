package dev.mineagent.bridge.common.mcp;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.mineagent.bridge.common.tools.BridgeTool;
import dev.mineagent.bridge.common.tools.BridgeTools;

import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * JSON-RPC 2.0 над Streamable HTTP — серверная сторона. Реализует только
 * wire-формат (entry-6/7 source-ledger): разбор request, маршрутизация по
 * method, формирование result/error. Транспорт (HTTP) — {@link McpHttpServer}.
 *
 * Поддерживаемые методы:
 *   initialize              → {protocolVersion, capabilities, serverInfo}
 *   notifications/initialized → (notification, ответа нет)
 *   tools/list              → {tools:[{name,description,inputSchema}]}
 *   tools/call              → {content:[...], isError}
 *   ping                    → {} (keepalive)
 *
 * Состояние сессии (protocolVersion после initialize) живёт в {@link McpSession}.
 */
public final class McpProtocol {

    public static final String PROTOCOL_VERSION = "2025-11-25";
    public static final String SERVER_NAME = "mineagent-bridge";
    public static final String SERVER_VERSION = "0.1.0";

    private static final Gson GSON = new GsonBuilder().disableHtmlEscaping().create();

    private final BridgeTools tools;

    public McpProtocol(BridgeTools tools) {
        this.tools = tools;
    }

    /**
     * Обрабатывает один JSON-RPC request. Возвращает response-JSON (для request
     * с id) или null (для notification — ответ не нужен). Транспорт решает, как
     * отправить ответ (plain JSON или SSE).
     */
    public HandleOutcome handle(String rawJson, McpSession session) {
        JsonObject message;
        try {
            JsonElement parsed = JsonParser.parseString(rawJson);
            if (!parsed.isJsonObject()) {
                return HandleOutcome.response(errorResponse(null, -32600, "Invalid Request: not an object"));
            }
            message = parsed.getAsJsonObject();
        } catch (Exception e) {
            return HandleOutcome.response(errorResponse(null, -32700, "Parse error: " + e.getMessage()));
        }

        if (!message.has("jsonrpc")) {
            return HandleOutcome.response(errorResponse(extractId(message), -32600, "Invalid Request: missing jsonrpc"));
        }

        String method = str(message, "method");
        boolean isNotification = !message.has("id");
        Object id = message.has("id") ? gsonId(message.get("id")) : null;

        JsonObject params = message.has("params") && message.get("params").isJsonObject()
                ? message.getAsJsonObject("params") : new JsonObject();

        try {
            Object result = dispatch(method, params, session);
            // Notification: ответа нет (best-effort).
            if (isNotification) {
                return HandleOutcome.notification();
            }
            return HandleOutcome.response(successResponse(id, result));
        } catch (RpcException e) {
            if (isNotification) {
                return HandleOutcome.notification();
            }
            return HandleOutcome.response(errorResponse(id, e.code, e.getMessage()));
        } catch (Exception e) {
            if (isNotification) {
                return HandleOutcome.notification();
            }
            return HandleOutcome.response(errorResponse(id, -32603, "Internal error: " + e.getMessage()));
        }
    }

    @SuppressWarnings("unchecked")
    private Object dispatch(String method, JsonObject params, McpSession session) {
        switch (method == null ? "" : method) {
            case "initialize": {
                // Переговариваем protocolVersion: берём ту, что прислал клиент, если она
                // из известных; иначе предлагаем свою. Фиксируем в сессии.
                String clientVersion = str(params, "protocolVersion");
                String negotiated = PROTOCOL_VERSION.equals(clientVersion) ? PROTOCOL_VERSION : PROTOCOL_VERSION;
                session.setProtocolVersion(negotiated);
                Map<String, Object> result = new LinkedHashMap<>();
                result.put("protocolVersion", negotiated);
                result.put("capabilities", new HashMap<String, Object>());
                result.put("serverInfo", Map.of("name", SERVER_NAME, "version", SERVER_VERSION));
                return result;
            }
            case "notifications/initialized":
                // Подтверждение инициализации клиента; состояние не меняем.
                return null;
            case "ping":
                return new HashMap<String, Object>();
            case "tools/list":
                return Map.of("tools", tools.toToolList());
            case "tools/call":
                return callTool(params, session);
            default:
                throw new RpcException(-32601, "Method not found: " + method);
        }
    }

    /**
     * tools/call требует, чтобы клиент уже прошел initialize (session initialized),
     * и чтобы имя инструмента было зарегистрировано. Исполнение инструмента
     * происходит на game thread через {@link BridgeTool#invoke} →
     * {@code ctx.queue().submitAndWait}.
     *
     * bridge-game-access и queue инжектируются через {@link McpSession} (loader
     * кладёт их при создании сессии), чтобы protocol оставался чистым от MC.
     */
    private Object callTool(JsonObject params, McpSession session) {
        if (!session.isInitialized()) {
            throw new RpcException(-32000, "Session not initialized");
        }
        String name = str(params, "name");
        if (name == null || name.isBlank()) {
            throw new RpcException(-32602, "tools/call: 'name' required");
        }
        BridgeTool tool = tools.get(name);
        if (tool == null) {
            throw new RpcException(-32602, "Unknown tool: " + name);
        }
        Map<String, Object> arguments = params.has("arguments") && params.get("arguments").isJsonObject()
                ? GSON.fromJson(params.getAsJsonObject("arguments"), Map.class)
                : new HashMap<String, Object>();
        BridgeTool.ToolContext ctx = session.requireToolContext();
        BridgeTool.ToolResult result = tool.invoke(arguments, ctx);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("content", result.content);
        if (result.isError) {
            out.put("isError", true);
        }
        return out;
    }

    // --- JSON-RPC response builders ---

    private static String successResponse(Object id, Object result) {
        Map<String, Object> resp = new LinkedHashMap<>();
        resp.put("jsonrpc", "2.0");
        resp.put("id", id);
        resp.put("result", result);
        return GSON.toJson(resp);
    }

    private static String errorResponse(Object id, int code, String message) {
        Map<String, Object> resp = new LinkedHashMap<>();
        resp.put("jsonrpc", "2.0");
        resp.put("id", id);
        Map<String, Object> err = new LinkedHashMap<>();
        err.put("code", code);
        err.put("message", message);
        resp.put("error", err);
        return GSON.toJson(resp);
    }

    private static String str(JsonObject obj, String key) {
        if (!obj.has(key) || !obj.get(key).isJsonPrimitive()) {
            return null;
        }
        return obj.get(key).getAsString();
    }

    private static Object gsonId(JsonElement idElement) {
        if (idElement == null || idElement.isJsonNull()) {
            return null;
        }
        if (idElement.isJsonPrimitive()) {
            if (idElement.getAsJsonPrimitive().isNumber()) {
                return idElement.getAsNumber();
            }
            return idElement.getAsString();
        }
        return null;
    }

    private static Object extractId(JsonObject obj) {
        if (!obj.has("id")) {
            return null;
        }
        return gsonId(obj.get("id"));
    }

    /** Семантическая JSON-RPC ошибка (code + message). */
    private static final class RpcException extends RuntimeException {
        final int code;
        RpcException(int code, String message) {
            super(message);
            this.code = code;
        }
    }

    /** Результат handle: либо response-JSON, либо notification (null). */
    public static final class HandleOutcome {
        public final boolean isResponse;
        public final String responseJson;

        private HandleOutcome(boolean isResponse, String responseJson) {
            this.isResponse = isResponse;
            this.responseJson = responseJson;
        }

        static HandleOutcome response(String json) {
            return new HandleOutcome(true, json);
        }

        static HandleOutcome notification() {
            return new HandleOutcome(false, null);
        }
    }
}
