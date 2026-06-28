package dev.mineagent.bridge.neoforge;

import dev.mineagent.bridge.common.Bridge;
import net.neoforged.api.distmarker.Dist;
import net.neoforged.api.distmarker.OnlyIn;
import net.neoforged.fml.loading.FMLEnvironment;
import net.neoforged.neoforge.client.event.ClientTickEvent;
import net.neoforged.neoforge.event.client.ClientStartingEvent;

/**
 * Client-side lifecycle для mineagent-bridge (NeoForge). {@link OnlyIn}(Dist.CLIENT)
 * гарантирует, что класс не загружается на dedicated server даже опосредованно.
 *
 * Registration-level production-disable (правило AGENTS.md): оба listener'а
 * проверяют {@code !FMLEnvironment.production}. В prod-сборке тело методов
 * возвращается сразу, не создавая {@link Bridge}, не инстанцируя
 * {@link NeoForgeGameAccess} и не запуская HTTP-сервер. Мёртвый код →
 * tree-shaking.
 *
 * В dev: onClientStarting создаёт Bridge (MCP-сервер на JDK HttpServer) и
 * стартует endpoint; onClientTickStart дёргает {@code bridge.drainTick()}, чтобы
 * задачи инструментов исполнялись на client game thread (entry-12).
 *
 * Замечание: FMLEnvironment.production доступен с NeoForge 20.2+. На ранних
 * версиях используется FmlConstants.isProduction — сигнатура стабильна для 1.21.
 */
@OnlyIn(Dist.CLIENT)
public final class ClientBridgeSetup {

    private ClientBridgeSetup() {
    }

    /**
     * Создаёт и стартует мост, когда клиент готов (ClientStartingEvent в NeoForge).
     * Этот event срабатывает ПОСЛЕ загрузки клиента, но до первого tick'а.
     */
    public static void onClientStarting(ClientStartingEvent event) {
        if (!isDevelopmentEnvironment()) {
            NeoForgeBridge.LOGGER.debug("[mineagent-bridge] production build — bridge disabled (registration-level).");
            return;
        }
        NeoForgeBridge.LOGGER.info("[mineagent-bridge] dev environment detected — starting MCP server.");
        try {
            NeoForgeGameAccess gameAccess = new NeoForgeGameAccess();
            Bridge bridge = new Bridge(gameAccess, msg -> NeoForgeBridge.LOGGER.info(msg));
            bridge.start();
            NeoForgeBridge.bridge = bridge;
        } catch (Throwable t) {
            // Bridge не должен валить запуск клиента.
            NeoForgeBridge.LOGGER.error("[mineagent-bridge] failed to start MCP server", t);
        }
    }

    /**
     * Drain очереди задач на game thread (ClientTickEvent). Подписка идёт через
     * modEventBus в конструкторе {@link NeoForgeBridge}, но сама обработка —
     * на NeoForge.EVENT_BUS через типизированный event. Здесь ловим начало tick.
     */
    public static void onClientTickStart(ClientTickEvent.Pre event) {
        Bridge bridge = NeoForgeBridge.bridge;
        if (bridge != null) {
            bridge.drainTick();
        }
    }

    /**
     * Dev-detection для NeoForge 1.21. {@code FMLEnvironment.dist == Dist.CLIENT}
     * уже гарантируется аннотацией @Mod; здесь дополнительно проверяем, что мы
     * не в production. Сигнатура FMLEnvironment.production стабильна для 1.21.x.
     */
    private static boolean isDevelopmentEnvironment() {
        return FMLEnvironment.dist == Dist.CLIENT && !FMLEnvironment.production;
    }
}
