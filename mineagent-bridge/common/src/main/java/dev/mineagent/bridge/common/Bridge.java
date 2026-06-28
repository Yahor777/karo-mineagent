package dev.mineagent.bridge.common;

import dev.mineagent.bridge.common.game.BridgeGameAccess;
import dev.mineagent.bridge.common.mcp.McpHttpServer;
import dev.mineagent.bridge.common.mcp.McpProtocol;
import dev.mineagent.bridge.common.mcp.McpSession;
import dev.mineagent.bridge.common.tools.BridgeTools;
import dev.mineagent.bridge.common.tools.MainThreadQueue;

import java.security.SecureRandom;
import java.util.HexFormat;
import java.util.function.Consumer;
import java.util.logging.Level;
import java.util.logging.Logger;

/**
 * Фасад lifecycle MCP-сервера mineagent-bridge. Loader'ы (Fabric/NeoForge/Forge)
 * создают один экземпляр в dev-окружении на клиенте и:
 *   1. В client-tick-handler'е (или клиентском цикле loader'а) вызывают
 *      {@link #drainTick()} — чтобы инструменты исполнялись на game thread.
 *   2. На shutdown/disconnect вызывают {@link #stop()}.
 *
 * В {@link Bridge#start} генерируется shared token (печатается в лог в
 * предсказуемом формате — расширенле парсит через {@code logParser.ts} и шлёт
 * в каждом запросе). {@link BridgeConfig} хранит host/port/path/timeout.
 *
 * Эта реализация не знает о Minecraft: доступ к игре инжектируется через
 * {@link BridgeGameAccess}, который реализует loader. Все MC-вызовы внутри
 * инструментов идут через {@link MainThreadQueue} → {@link #drainTick()} на
 * game thread (entry-12 source-ledger).
 */
public final class Bridge {

    private static final Logger LOG = Logger.getLogger(Bridge.class.getName());

    /**
     * Маркер строки в логе, которую парсит расширение (logParser.ts):
     * содержит base URL и token. Формат намеренно простой и устойчивый к
     * обрезке/таймстемпам: однострочник с двумя известными ключами.
     */
    public static final String READY_LOG_MARKER = "[mineagent-bridge] MCP endpoint ready";

    private final BridgeConfig config;
    private final BridgeGameAccess gameAccess;
    private final MainThreadQueue queue;
    private final BridgeTools tools;
    private final McpProtocol protocol;
    private final McpSession session;
    private final McpHttpServer http;
    private final Consumer<String> logger;

    public Bridge(BridgeGameAccess gameAccess, Consumer<String> logger) {
        this(BridgeConfig.defaults(generateToken()), gameAccess, logger);
    }

    public Bridge(BridgeConfig config, BridgeGameAccess gameAccess, Consumer<String> logger) {
        this.config = config;
        this.gameAccess = gameAccess;
        this.logger = logger == null ? msg -> LOG.info(msg) : logger;
        this.queue = new MainThreadQueue(config.getToolTimeoutMs());
        this.tools = new BridgeTools();
        this.session = new McpSession(gameAccess, queue);
        this.protocol = new McpProtocol(tools);
        this.http = new McpHttpServer(config, protocol, session);
    }

    /** Запускает HTTP-сервер и печатает ready-строку с токеном для расширения. */
    public synchronized void start() {
        try {
            http.start();
            // Готовая строка для logParser.ts расширения: однострочник, два поля.
            // Пример: [mineagent-bridge] MCP endpoint ready url=http://127.0.0.1:3100/mc-mcp token=a1b2...
            logger.accept(READY_LOG_MARKER
                    + " url=" + config.getBaseUrl()
                    + " token=" + config.getToken());
        } catch (Exception e) {
            LOG.log(Level.SEVERE, "Failed to start mineagent-bridge MCP server", e);
            logger.accept("[mineagent-bridge] MCP endpoint FAILED to start: " + e.getMessage());
        }
    }

    public synchronized void stop() {
        http.stop();
        queue.cancelAll();
    }

    public boolean isRunning() {
        return http.isRunning();
    }

    public BridgeConfig getConfig() {
        return config;
    }

    public MainThreadQueue getQueue() {
        return queue;
    }

    /**
     * Вызывается loader'ом из client-tick-handler'а в конце каждого client-tick.
     * Дёргает накопленные задачи инструментов на game thread. Безопасен, если
     * очередь пуста (быстрая проверка).
     */
    public void drainTick() {
        if (queue.pendingCount() == 0) {
            return;
        }
        queue.drainAll();
    }

    /** Генерация shared-токена: 32 байта → hex (64 символа). */
    public static String generateToken() {
        byte[] bytes = new byte[32];
        new SecureRandom().nextBytes(bytes);
        return HexFormat.of().formatHex(bytes);
    }
}
