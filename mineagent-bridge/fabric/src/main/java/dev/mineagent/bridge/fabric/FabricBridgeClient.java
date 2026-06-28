package dev.mineagent.bridge.fabric;

import dev.mineagent.bridge.common.Bridge;
import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.fabricmc.loader.api.FabricLoader;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Fabric client entrypoint для mineagent-bridge. Регистрируется в
 * fabric.mod.json только для {@code environment: client} (entry-11
 * source-ledger) — на dedicated server этот класс не загружается вовсе.
 *
 * Production-disable на уровне registration (правило AGENTS.md):
 * в {@code onInitializeClient} проверяем
 * {@link FabricLoader#isDevelopmentEnvironment()} — если это prod-сборка,
 * тело метода НЕ создаёт Bridge, НЕ подписывает client-tick-handler и НЕ
 * инстанцирует {@link FabricGameAccess}. Весь bridge-код (HTTP-сервер,
 * инструменты) остаётся мёртвым — JVM его не трогает.
 *
 * В dev: создаём {@link Bridge}, стартуем HTTP-сервер, подписываемся на
 * END_CLIENT_TICK чтобы {@code bridge.drainTick()} дёргал накопленные задачи
 * инструментов на client game thread (thread-safety MC API, entry-12).
 */
public class FabricBridgeClient implements ClientModInitializer {

    private static final Logger LOGGER = LoggerFactory.getLogger("mineagent-bridge");
    private static Bridge bridge;

    @Override
    public void onInitializeClient() {
        // Registration-level production guard. В prod тело полностью пустое —
        // ни одного объекта bridge не создаётся (tree-shaking может убрать код).
        if (!FabricLoader.getInstance().isDevelopmentEnvironment()) {
            return;
        }

        LOGGER.info("[mineagent-bridge] dev environment detected — starting MCP server.");
        try {
            FabricGameAccess gameAccess = new FabricGameAccess();
            bridge = new Bridge(gameAccess, LOGGER::info);
            bridge.start();

            // END_CLIENT_TICK: конец каждого client-tick → drain очереди задач
            // на game thread. Подписка происходит только в dev (после guard).
            ClientTickEvents.END_CLIENT_TICK.register(client -> {
                if (bridge != null) {
                    bridge.drainTick();
                }
            });
        } catch (Throwable t) {
            // Bridge не должен валить запуск клиента — логируем и продолжаем.
            LOGGER.error("[mineagent-bridge] failed to start MCP server", t);
        }
    }

    /** Для тестов/диагностики: текущий экземпляр моста (null в prod). */
    public static Bridge getBridge() {
        return bridge;
    }
}
