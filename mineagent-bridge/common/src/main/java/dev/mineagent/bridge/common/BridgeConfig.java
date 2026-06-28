package dev.mineagent.bridge.common;

/**
 * Конфигурация MCP-сервера моста. Immutable value-объект; создаётся loader'ом
 * перед {@link Bridge#start} на основе dev-окружения.
 *
 * Все значения по умолчанию выбраны так, чтобы совпадать с config.minecraftBridge
 * расширения (defaultConfig.ts): порт 3100, путь /mc-mcp (отличается от
 * Blockbench 3000, чтобы оба bridge'а жили одновременно).
 */
public final class BridgeConfig {

    /** Хост бинда. Всегда localhost (AGENTS.md: localhost-only). */
    public static final String DEFAULT_HOST = "127.0.0.1";
    public static final int DEFAULT_PORT = 3100;
    public static final String DEFAULT_PATH = "/mc-mcp";

    /** Таймаут одного инструмента (ms) — не должен вешать HTTP-поток. */
    public static final long DEFAULT_TOOL_TIMEOUT_MS = 30_000L;

    private final String host;
    private final int port;
    private final String path;
    private final String token;
    private final long toolTimeoutMs;

    public BridgeConfig(String host, int port, String path, String token, long toolTimeoutMs) {
        this.host = host;
        this.port = port;
        this.path = path;
        this.token = token;
        this.toolTimeoutMs = toolTimeoutMs;
    }

    public static BridgeConfig defaults(String token) {
        return new BridgeConfig(DEFAULT_HOST, DEFAULT_PORT, DEFAULT_PATH, token, DEFAULT_TOOL_TIMEOUT_MS);
    }

    public String getHost() {
        return host;
    }

    public int getPort() {
        return port;
    }

    public String getPath() {
        return path;
    }

    /** Shared token: мод генерирует, расширение парсит из лога. */
    public String getToken() {
        return token;
    }

    public long getToolTimeoutMs() {
        return toolTimeoutMs;
    }

    /** Полный URL для логирования при старте endpoint'а. */
    public String getBaseUrl() {
        return "http://" + host + ":" + port + path;
    }
}
