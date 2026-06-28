package dev.mineagent.bridge.common.game;

import java.util.List;

/**
 * Снимок состояния мира / сущностей для инструментов get_state. Loader-agnostic:
 * loader заполняет из своего Level/Entity API. Только данные — никакой привязки
 * к MC-классам.
 */
public final class GameEntitySnapshot {

    private final String id;
    private final String type;
    private final String displayName;
    private final GameVector position;
    private final double health;
    private final List<String> activeEffects;

    public GameEntitySnapshot(String id, String type, String displayName, GameVector position,
                              double health, List<String> activeEffects) {
        this.id = id;
        this.type = type;
        this.displayName = displayName;
        this.position = position;
        this.health = health;
        this.activeEffects = activeEffects == null ? List.of() : List.copyOf(activeEffects);
    }

    public String getId() {
        return id;
    }

    public String getType() {
        return type;
    }

    public String getDisplayName() {
        return displayName;
    }

    public GameVector getPosition() {
        return position;
    }

    public double getHealth() {
        return health;
    }

    public List<String> getActiveEffects() {
        return activeEffects;
    }
}
