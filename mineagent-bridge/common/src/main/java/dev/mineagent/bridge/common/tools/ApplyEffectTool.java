package dev.mineagent.bridge.common.tools;

import java.util.LinkedHashMap;
import java.util.Map;

import static dev.mineagent.bridge.common.tools.SummonTool.asDouble;
import static dev.mineagent.bridge.common.tools.SummonTool.asString;

/**
 * apply_effect — наложить статус-эффект на target по registry-id эффекта.
 * target может быть selector (@p, @e[...]) или registry-именем.
 */
public final class ApplyEffectTool implements BridgeTool {

    @Override
    public String name() {
        return "apply_effect";
    }

    @Override
    public String description() {
        return "Apply a status effect (registry id, e.g. minecraft:speed) to a target "
                + "(selector or entity id). duration in ticks (20 = 1s), amplifier 0-based.";
    }

    @Override
    public Map<String, Object> inputSchema() {
        Map<String, Object> schema = new LinkedHashMap<>();
        schema.put("type", "object");
        Map<String, Object> props = new LinkedHashMap<>();
        props.put("target", Map.of("type", "string", "description",
                "Target selector (@p, @e[type=...]) or entity registry id."));
        props.put("effect", Map.of("type", "string", "description",
                "Mob effect registry id, e.g. minecraft:speed."));
        props.put("duration", Map.of("type", "integer", "description", "Duration in ticks (20 ticks = 1 second)."));
        props.put("amplifier", Map.of("type", "integer", "description", "Amplifier, 0-based (0 = level I)."));
        schema.put("properties", props);
        schema.put("required", java.util.List.of("target", "effect"));
        return schema;
    }

    @Override
    public ToolResult invoke(Map<String, Object> arguments, ToolContext ctx) {
        String target = asString(arguments.get("target"));
        String effect = asString(arguments.get("effect"));
        if (target == null || target.isBlank() || effect == null || effect.isBlank()) {
            return ToolResult.error("apply_effect: 'target' and 'effect' are required.");
        }
        int duration = toInt(asDouble(arguments.get("duration")), 200);
        int amplifier = toInt(asDouble(arguments.get("amplifier")), 0);
        try {
            String result = ctx.queue().supplyAndWait(() -> {
                if (!ctx.game().isClientReady()) {
                    return "Client not ready (no world loaded).";
                }
                return ctx.game().applyEffect(target, effect, duration, amplifier);
            });
            return ToolResult.text(result);
        } catch (Exception e) {
            return ToolResult.error("apply_effect failed: " + e.getMessage());
        }
    }

    private static int toInt(Double value, int fallback) {
        return value == null ? fallback : value.intValue();
    }
}
