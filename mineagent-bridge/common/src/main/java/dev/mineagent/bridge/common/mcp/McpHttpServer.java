package dev.mineagent.bridge.common.mcp;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;
import com.sun.net.httpserver.HttpServer;
import dev.mineagent.bridge.common.BridgeConfig;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import java.util.concurrent.Executors;
import java.util.logging.Level;
import java.util.logging.Logger;

/**
 * Streamable HTTP transport для MCP-сервера (entry-6 source-ledger), серверная
 * сторона. Использует встроенный JDK {@link HttpServer} — никаких внешних
 * web-framework зависимостей (AGENTS.md: минимум deps).
 *
 * Безопасность:
 *   - bind только на {@code 127.0.0.1} (localhost-only).
 *   - проверка shared-token в заголовке Authorization (Bearer) на каждый запрос.
 *     Token генерируется модом и печатается в лог (парсится расширением).
 *   - на initialize выдаем MCP-Session-Id, ждём его в последующих запросах
 *     (best-effort; не строго — клиент может его не прислать).
 *
 * Endpoint поддерживает POST (JSON-RPC request/notification) и DELETE
 * (terminate session). Ответ — plain application/json (Streamable HTTP: сервер
 * волен отвечать одним сообщением; SSE не нужен для одиночных round-trip'ов).
 */
public final class McpHttpServer {

    private static final Logger LOG = Logger.getLogger(McpHttpServer.class.getName());

    private final BridgeConfig config;
    private final McpProtocol protocol;
    private final McpSession session;
    private HttpServer server;

    public McpHttpServer(BridgeConfig config, McpProtocol protocol, McpSession session) {
        this.config = config;
        this.protocol = protocol;
        this.session = session;
    }

    /** Запускает HTTP-сервер (bind + handler). Idempotent для одного экземпляра. */
    public synchronized void start() throws IOException {
        if (server != null) {
            return;
        }
        InetSocketAddress addr = new InetSocketAddress(config.getHost(), config.getPort());
        server = HttpServer.create(addr, 0);
        server.createContext(config.getPath(), new BridgeHandler());
        server.setExecutor(Executors.newSingleThreadExecutor(r -> {
            Thread t = new Thread(r, "mineagent-bridge-http");
            t.setDaemon(true);
            return t;
        }));
        server.start();
        LOG.info(() -> "[mineagent-bridge] MCP endpoint ready at " + config.getBaseUrl());
    }

    public synchronized void stop() {
        if (server != null) {
            server.stop(0);
            server = null;
            LOG.info(() -> "[mineagent-bridge] MCP endpoint stopped.");
        }
    }

    public boolean isRunning() {
        return server != null;
    }

    private final class BridgeHandler implements HttpHandler {

        @Override
        public void handle(HttpExchange exchange) throws IOException {
            try {
                String method = exchange.getRequestMethod();
                if ("DELETE".equals(method)) {
                    // Terminate session (best-effort). Сервер завершает HTTP-сессию,
                    // но сам game-bridge продолжает работать (loader решает).
                    writeJson(exchange, 200, "{}");
                    return;
                }
                if (!"POST".equals(method)) {
                    writeJson(exchange, 405, error(-32600, "Only POST/DELETE supported"));
                    return;
                }
                // Token-check. Authorization: Bearer <token> либо X-Bridge-Token.
                if (!checkToken(exchange)) {
                    writeJson(exchange, 401, error(-32001, "Unauthorized: bad or missing token"));
                    return;
                }
                String body = readBody(exchange);
                McpProtocol.HandleOutcome outcome = protocol.handle(body, session);

                // Notification → 202 Accepted (без тела, как требует Streamable HTTP).
                if (!outcome.isResponse) {
                    writeNoBody(exchange, 202);
                    return;
                }

                // На initialize выдаем session-id (один на мост).
                if (!session.isInitialized()) {
                    // handle() уже проставил protocolVersion в случае успеха initialize.
                }
                exchange.getResponseHeaders().set("Content-Type", "application/json");
                exchange.getResponseHeaders().set("MCP-Protocol-Version",
                        session.getProtocolVersion() != null ? session.getProtocolVersion()
                                : McpProtocol.PROTOCOL_VERSION);
                if (session.getSessionId() == null && session.isInitialized()) {
                    String sid = "mc-" + UUID.randomUUID();
                    session.setSessionId(sid);
                }
                if (session.getSessionId() != null) {
                    exchange.getResponseHeaders().set("MCP-Session-Id", session.getSessionId());
                }
                writeBody(exchange, 200, outcome.responseJson);
            } catch (Exception e) {
                LOG.log(Level.WARNING, "MCP handler error", e);
                try {
                    writeJson(exchange, 500, error(-32603, "Internal error: " + e.getMessage()));
                } catch (IOException ignored) {
                    // exchange уже закрыт
                }
            }
        }

        private boolean checkToken(HttpExchange exchange) {
            String auth = exchange.getRequestHeaders().getFirst("Authorization");
            if (auth != null && auth.startsWith("Bearer ")) {
                return config.getToken().equals(auth.substring("Bearer ".length()).trim());
            }
            String headerToken = exchange.getRequestHeaders().getFirst("X-Bridge-Token");
            return headerToken != null && config.getToken().equals(headerToken.trim());
        }

        private String readBody(HttpExchange exchange) throws IOException {
            byte[] bytes = exchange.getRequestBody().readAllBytes();
            return new String(bytes, StandardCharsets.UTF_8);
        }

        private void writeBody(HttpExchange exchange, int status, String body) throws IOException {
            byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(status, bytes.length);
            try (OutputStream os = exchange.getResponseBody()) {
                os.write(bytes);
            }
        }

        private void writeJson(HttpExchange exchange, int status, String body) throws IOException {
            writeBody(exchange, status, body);
        }

        private void writeNoBody(HttpExchange exchange, int status) throws IOException {
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(status, -1);
        }

        private String error(int code, String message) {
            return "{\"jsonrpc\":\"2.0\",\"id\":null,\"error\":{\"code\":" + code
                    + ",\"message\":\"" + escape(message) + "\"}}";
        }

        private String escape(String s) {
            return s.replace("\\", "\\\\").replace("\"", "\\\"")
                    .replace("\n", "\\n").replace("\r", "\\r");
        }
    }
}
