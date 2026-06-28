package dev.mineagent.bridge.common.tools;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static dev.mineagent.bridge.common.tools.SummonTool.asString;

/**
 * get_state — снимок сущностей по selector. Возвращает JSON-массив снимков
 * (id, type, displayName, position, health, effects).
 */
public final class GetStateTool implements BridgeTool {

    private static final Gson GSON = new GsonBuilder().disableHtmlEscaping().create();

    @Override
    public String name() {
        return "get_state";
    }

    @Override
    public String description() {
        return "Read entity state near the local player by selector "
                + "(e.g. @e[type=!player,distance=..30]). Returns JSON array of snapshots.";
    }

    @Override
    public Map<String, Object> inputSchema() {
        Map<String, Object> schema = new LinkedHashMap<>();
        schema.put("type", "object");
        schema.put("properties", Map.of(
                "selector", Map.of("type", "string", "description",
                        "Entity selector, e.g. @e[type=!player,distance=..30]. Defaults to nearby entities.")
        ));
        return schema;
    }

    @Override
    public ToolResult invoke(Map<String, Object> arguments, ToolContext ctx) {
        String rawSelector = asString(arguments.get("selector"));
        // effectively final для лямбды; дефолт — «ближайшие не-игроки».
        final String selector = (rawSelector == null || rawSelector.isBlank())
                ? "@e[type=!player,distance=..30]" : rawSelector;
        try {
            List<?> snapshots = ctx.queue().supplyAndWait(() -> {
                if (!ctx.game().isClientReady()) {
                    return List.of();
                }
                return ctx.game().getState(selector);
            });
            String json = GSON.toJson(snapshots);
            return ToolResult.text(json);
        } catch (Exception e) {
            return ToolResult.error("get_state failed: " + e.getMessage());
        }
    }
}
