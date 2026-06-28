package dev.mineagent.bridge.forge;

import dev.mineagent.bridge.common.Bridge;
import net.minecraft.client.Minecraft;
import net.minecraftforge.api.distmarker.Dist;
import net.minecraftforge.common.MinecraftForge;
import net.minecraftforge.eventbus.api.SubscribeEvent;
import net.minecraftforge.fml.common.Mod;
import net.minecraftforge.fml.event.lifecycle.FMLClientSetupEvent;
import net.minecraftforge.fml.loading.FMLEnvironment;
import net.minecraftforge.fml.loading.FMLLoader;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Forge mod-класс mineagent-bridge (MC 1.20.1). Регистрируется через
 * {@link EventBusSubscriber} с {@code value = Dist.CLIENT} (entry-11
 * source-ledger) — класс {@link ClientEvents} НЕ загружается на dedicated
 * server вовсе (registration-level disable для сервера).
 *
 * Production-disable для клиентской prod-сборки: внутри {@code onClientSetup}
 * проверяем {@code !FMLLoader.isProduction()} (Forge 1.20.1 API). В prod тело
 * метода не создаёт {@link Bridge}, не инстанцирует {@link ForgeGameAccess},
 * не подписывает tick-handler → мёртвый код, tree-shaking выкидывает.
 *
 * В dev: onClientSetup создаёт и стартует мост; FORGE-шину подписываем на
 * TickEvent.ClientTickEvent, чтобы {@code bridge.drainTick()} исполнял задачи
 * инструментов на client game thread (entry-12).
 *
 * Замечание о сигнатурах (entry-10): на Forge 1.20.1 dev-флаг доступен через
 * {@code FMLLoader.isProduction()} (boolean) — стабильный публичный API на этой
 * ветке. FMLEnvironment.dist даёт физическую сторону (Dist.CLIENT).
 */
@Mod("mineagent_bridge")
public class ForgeBridge {

    static final Logger LOGGER = LoggerFactory.getLogger("mineagent-bridge");
    static volatile Bridge bridge;

    public ForgeBridge() {
        // Клиентские lifecycle/tick-events подписываются через @EventBusSubscriber
        // с Dist.CLIENT — отдельный класс ClientEvents (см. ниже). Здесь только
        // помечаем, что mod сконструирован.
        LOGGER.debug("[mineagent-bridge] forge mod class constructed.");
    }

    /** Текущий мост (null в production). Для тестов/диагностики. */
    public static Bridge getBridge() {
        return bridge;
    }

    /**
     * Client-only события. {@code value = Dist.CLIENT} на аннотации класса —
     * это registration-level guard: dedicated server не регистрирует этот
     * subscriber, класс не загружается JVM.
     */
    @Mod.EventBusSubscriber(modid = "mineagent_bridge", value = Dist.CLIENT, bus = Mod.EventBusSubscriber.Bus.MOD)
    public static class ClientEvents {

        @SubscribeEvent
        public static void onClientSetup(FMLClientSetupEvent event) {
            // Registration-level production guard (правило AGENTS.md).
            // В prod тело НЕ выполняется — bridge-код остаётся мёртвым.
            if (FMLLoader.isProduction()) {
                LOGGER.debug("[mineagent-bridge] production build — bridge disabled (registration-level).");
                return;
            }
            if (FMLEnvironment.dist != Dist.CLIENT) {
                return;
            }
            LOGGER.info("[mineagent-bridge] dev environment detected — starting MCP server.");
            try {
                ForgeGameAccess gameAccess = new ForgeGameAccess();
                Bridge b = new Bridge(gameAccess, msg -> LOGGER.info(msg));
                b.start();
                bridge = b;
            } catch (Throwable t) {
                // Bridge не должен валить запуск клиента.
                LOGGER.error("[mineagent-bridge] failed to start MCP server", t);
            }

            // Tick-handler на FORGE-шине (game bus): drain очереди каждый client-tick.
            // Регистрируем только в dev — после guard. В prod FORGE event-bus про
            // нас не знает.
            MinecraftForge.EVENT_BUS.register(TickHandler.class);
        }
    }

    /** Дёргает bridge.drainTick() на каждом client-tick. */
    @Mod.EventBusSubscriber(modid = "mineagent_bridge", value = Dist.CLIENT, bus = Mod.EventBusSubscriber.Bus.FORGE)
    public static class TickHandler {
        @SubscribeEvent
        public static void onClientTick(net.minecraftforge.event.TickEvent.ClientTickEvent event) {
            Bridge b = bridge;
            if (b != null) {
                b.drainTick();
            }
        }
    }
}
