package dev.mineagent.bridge.common.tools;

import dev.mineagent.bridge.common.game.GameVector;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * summon — спавн сущности по registry-id в позиции (или возле игрока).
 * Все мутирующие minecraft-инструменты = game-control (расширение требует approval).
 */
public final class SummonTool implements BridgeTool {

    @Override
    public String name() {
        return "summon";
    }

    @Override
    public String description() {
        return "Summon an entity by registry id (e.g. minecraft:zombie) at a position, "
                + "or near the local player if pos is omitted. Dev world only.";
    }

    @Override
    public Map<String, Object> inputSchema() {
        Map<String, Object> pos = new LinkedHashMap<>();
        pos.put("type", "object");
        Map<String, Object> posProps = new LinkedHashMap<>();
        posProps.put("x", Map.of("type", "number"));
        posProps.put("y", Map.of("type", "number"));
        posProps.put("z", Map.of("type", "number"));
        pos.put("properties", posProps);

        Map<String, Object> schema = new LinkedHashMap<>();
        schema.put("type", "object");
        Map<String, Object> props = new LinkedHashMap<>();
        props.put("entity", Map.of("type", "string", "description",
                "Entity registry id, e.g. minecraft:zombie."));
        props.put("pos", pos);
        schema.put("properties", props);
        schema.put("required", java.util.List.of("entity"));
        return schema;
    }

    @Override
    public ToolResult invoke(Map<String, Object> arguments, ToolContext ctx) {
        String entity = asString(arguments.get("entity"));
        if (entity == null || entity.isBlank()) {
            return ToolResult.error("summon: 'entity' is required.");
        }
        GameVector pos = parsePos(arguments.get("pos"));
        try {
            String result = ctx.queue().supplyAndWait(() -> {
                if (!ctx.game().isClientReady()) {
                    return "Client not ready (no world loaded).";
                }
                return ctx.game().summon(entity, pos);
            });
            return ToolResult.text(result);
        } catch (java.util.concurrent.TimeoutException e) {
            return ToolResult.error("summon timed out: game thread did not drain the task "
                    + "(world paused or not ticking?)");
        } catch (Exception e) {
            String msg = e.getMessage() != null ? e.getMessage() : e.getClass().getSimpleName();
            return ToolResult.error("summon failed: " + msg);
        }
    }

    static String asString(Object value) {
        return value == null ? null : value.toString();
    }

    static GameVector parsePos(Object raw) {
        if (!(raw instanceof Map<?, ?> map)) {
            return null;
        }
        Double x = asDouble(map.get("x"));
        Double y = asDouble(map.get("y"));
        Double z = asDouble(map.get("z"));
        if (x == null || y == null || z == null) {
            return null;
        }
        return new GameVector(x, y, z);
    }

    static Double asDouble(Object value) {
        if (value instanceof Number n) {
            return n.doubleValue();
        }
        if (value instanceof String s) {
            try {
                return Double.parseDouble(s);
            } catch (NumberFormatException e) {
                return null;
            }
        }
        return null;
    }
}
