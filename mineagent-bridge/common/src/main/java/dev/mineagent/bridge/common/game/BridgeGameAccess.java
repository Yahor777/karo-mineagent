package dev.mineagent.bridge.common.game;

import java.util.List;

/**
 * SPI-интерфейс доступа к Minecraft API. Реализуется каждым loader'ом
 * (Fabric/NeoForge/Forge) поверх client-side API своей версии. Все методы
 * выполняются на client game thread (см. {@code MainThreadQueue}) — impl'ы
 * НЕ обязаны быть потокобезопасными сами по себе, вызывать их можно только из
 * enqueue-обработчика.
 *
 * Разделение common (этот интерфейс) / loader (impl) позволяет держать всю
 * MCP/JSON-RPC логику в loader-agnostic common/ и тестировать её без Minecraft.
 */
public interface BridgeGameAccess {

    /** Тип «мир/клиент готов» — инструменты доступны только когда true. */
    boolean isClientReady();

    /**
     * Summon сущности по registry-имени (например "minecraft:zombie") в позиции.
     * Если pos == null — возле локального игрока. Возвращает сообщение о результате.
     */
    String summon(String entityTypeId, GameVector pos);

    /**
     * Накладывает эффект на target (selector или registry-имя). effect — registry-id
     * (например "minecraft:speed"). duration в тиках, amplifier 0-based.
     */
    String applyEffect(String target, String effect, int duration, int amplifier);

    /** Перемещает камеру локального игрока в pos + yaw/pitch (в градусах). */
    String setCamera(GameVector pos, float yaw, float pitch);

    /**
     * Захват кадра с экрана. Возвращает PNG в base64 (без data:-префикса) или
     * null, если захват не удался.
     */
    String screenshot();

    /** Снимок сущностей по selector (например "@e[type=!player,distance=..30]"). */
    List<GameEntitySnapshot> getState(String selector);

    /** Триггер перезагрузки ресурсов (datapacks/ресурсы клиента). */
    String reloadResources();
}
