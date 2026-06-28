package dev.mineagent.bridge.neoforge;

import dev.mineagent.bridge.common.Bridge;
import net.neoforged.api.distmarker.Dist;
import net.neoforged.bus.api.IEventBus;
import net.neoforged.fml.ModContainer;
import net.neoforged.fml.common.Mod;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * NeoForge mod-класс mineagent-bridge. Регистрируется с
 * {@code value = Dist.CLIENT} (entry-11 source-ledger) — на dedicated server
 * этот класс НЕ загружается вовсе (registration-level disable для сервера).
 *
 * Сам по себе mod-класс не создаёт Bridge (ему нужны MC-состояния из
 * client-setup). Фактический start моста происходит в
 * {@link ClientBridgeSetup} — на FMLClientSetupEvent, под двумя guards:
 *   1. {@code FMLEnvironment.dist == Dist.CLIENT} (здесь уже гарантировано
 *      аннотацией @Mod, но listener существует только на клиенте).
 *   2. {@code !FMLEnvironment.production} — dev-only.
 * В production (production=true) listener НЕ создаёт Bridge, НЕ подписывает
 * tick-handler → bridge-код мёртв, tree-shaking может его выкинуть.
 */
@Mod(value = "mineagent_bridge", dist = Dist.CLIENT)
public class NeoForgeBridge {

    static final Logger LOGGER = LoggerFactory.getLogger("mineagent-bridge");
    static volatile Bridge bridge;

    public NeoForgeBridge(IEventBus modEventBus, ModContainer container) {
        // Регистрация client-setup listener'а. Dist.CLIENT уже отфильтровал
        // dedicated server на уровне аннотации @Mod — здесь только клиент.
        modEventBus.addListener(ClientBridgeSetup::onClientSetup);
        modEventBus.addListener(ClientBridgeSetup::onClientTickStart);
        LOGGER.debug("[mineagent-bridge] neoforge mod class constructed (client side).");
    }

    /** Для тестов/диагностики: текущий мост (null в production). */
    public static Bridge getBridge() {
        return bridge;
    }
}
